/**
 * Order row on the shared Mini ERP: ORDERS in, sign-off, ORDRSP and hand-over out
 * (port of order/service.py).
 *
 *   receiveOrder()      parse -> stock -> price, with Grokbot loops; stops at a person
 *   confirmOrder()      the person approves: ORDRSP is written, the hand-over is returned
 *   resolvePriceCase()  the person types a manual EDI (back to Parse) or parks the order
 *
 * The order-dec.md rules hold: Grok's fixes go back through the code checks, a wrong price
 * never reaches the confirm step, and a person confirms every order.
 */
import type { Erp, Order } from "../core/erp";
import { decide, requestSignoff } from "../core/signoff";
import { availableToPromise, nextReadyDate } from "../core/stock";
import type { Caller } from "../grok/client";
import { ErpAvailabilityProvider } from "./availability";
import { loadContract, type SupplyContract } from "./contract";
import { polishPriceMail, proposeParseFix, proposeQtyResolution } from "./grokbot";
import { buildOrdrsp, type OrdrspHandoff, qtyText } from "./ordrsp";
import type { OrderLine, ParsedOrder, ParseFlag } from "./parser";
import { PipelineStatus, runOrderPipeline } from "./pipeline";
import { pyFloat, pyG, pyStr } from "./py";

export const MAX_ROUNDS = 3;

export type ReceiveResult = {
  status: "awaiting_person";
  case_id: string;
  order_ref: string | null;
  step: "manual_edi" | "stock_short" | "price_fix" | "confirm";
};

export type Backorder = { line_no: number; gtin: string | null; qty: number; date: string | null };

/** The hand-over Shipping's `ingestConfirmedOrder` takes (Python `confirm_order` shape). */
export type ConfirmedOrderHandoff = OrdrspHandoff & { ordrsp_ref: string; backorders: Backorder[]; signoff_case: string };

/** Write a clean ORDERS message from a parsed order (used after a Grokbot change). */
export function orderToEdi(order: ParsedOrder, qtyOverrides?: Map<number, number> | null): string {
  const overrides = qtyOverrides ?? new Map<number, number>();
  const seg = ["UNH+1+ORDERS:D:96A:UN'", `BGM+220+${pyStr(order.order_number)}+9'`];
  if (order.order_date) seg.push(`DTM+137:${order.order_date}:102'`);
  if (order.buyer_gln) seg.push(`NAD+BY+${order.buyer_gln}::9'`);
  if (order.supplier_gln) seg.push(`NAD+SU+${order.supplier_gln}::9'`);
  order.lines.forEach((line, i) => {
    const n = line.line_no || i + 1;
    const q = overrides.has(n) ? overrides.get(n)! : line.quantity;
    seg.push(`LIN+${n}++${pyStr(line.gtin)}:EN'`);
    seg.push(`QTY+21:${qtyText(q)}'`);
    if (line.unit_price != null) seg.push(`PRI+AAA:${pyFloat(line.unit_price)}:CT'`);
  });
  seg.push("UNS+S'");
  seg.push(`UNT+${seg.length + 1}+1'`);
  return seg.join("\n");
}

function parsedFromErp(order: Order): ParsedOrder {
  return {
    order_number: order.orderRef,
    order_date: (order.orderDate || "").replace(/-/g, "") || null,
    buyer_gln: order.buyerGln,
    supplier_gln: order.supplierGln,
    lines: order.lines.map((l) => ({
      line_no: l.lineNo,
      gtin: l.gtin,
      quantity: l.qtyConfirmed ?? l.qtyOrdered,
      quantity_raw: null,
      unit_price: l.unitPrice,
      unit_price_raw: null,
    })),
    message_type: null,
  };
}

/** Python `l.to_dict()` passed to `save_order`, in the ERP's camelCase line shape. */
const erpLines = (lines: OrderLine[]) =>
  lines.map((l, i) => ({ lineNo: l.line_no || i + 1, gtin: l.gtin, quantity: l.quantity, unitPrice: l.unit_price }));

/** Run one ORDERS message until it needs a person. Returns what happened. */
export async function receiveOrder(
  erp: Erp,
  rawEdi: string,
  opts: { sourceName?: string; contract?: SupplyContract | null; caller?: Caller | null } = {},
): Promise<ReceiveResult> {
  const contract = opts.contract ?? loadContract();
  const caller = opts.caller ?? null;
  const docId = erp.addDocument("ORDERS", null, rawEdi, { path: opts.sourceName ?? "ORDERS" });
  erp.log("retailer", "orders.received", null, { sourceDoc: docId });
  const provider = new ErpAvailabilityProvider(erp);

  let edi = rawEdi;
  const notes: string[] = [];
  const personReasons: string[] = [];
  const backorders: Backorder[] = [];
  let originalQty = new Map<number, number>();
  let lastFlags: ParseFlag[] = [];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const result = runOrderPipeline(edi, { availability: provider, contract });
    const parsed = result.parse ? result.parse.order : null;
    const ref = parsed && parsed.order_number ? parsed.order_number : null;
    if (parsed && originalQty.size === 0) {
      originalQty = new Map(
        parsed.lines.flatMap((l, i): [number, number][] => (l.quantity != null ? [[l.line_no || i + 1, l.quantity]] : [])),
      );
    }

    if (result.status === PipelineStatus.AWAIT_GROK_PARSE) {
      lastFlags = result.parse ? result.parse.flags.map((f) => ({ ...f })) : [];
      const fix = await proposeParseFix(edi, lastFlags, { caller });
      if (fix && round < MAX_ROUNDS) {
        erp.log("grok", "order.parse_fix", ref, { sourceDoc: docId, detail: fix.changes ?? null });
        const changed = (fix.changes || []).map((c) => `${pyStr(c.segment)}: ${pyStr(c.before)} -> ${pyStr(c.after)}`).join(", ");
        notes.push(`Grok corrected the EDI (${changed}); the parser read it again.`);
        personReasons.push(`Grok corrected the EDI: ${changed || "see changes"}`);
        edi = fix.corrected_edi;
        continue;
      }
      const caseId = requestSignoff(erp, {
        row: "order",
        kind: "manual_edi",
        subjectRef: ref || docId,
        title: `Order ${ref || "(no number)"}: the EDI cannot be read safely`,
        proposal: { flags: lastFlags, edi, options: ["manual_edi", "park_pending"] },
        reasons: [`the parser could not read the EDI and Grok had no safe fix: ${lastFlags.map((f) => f.message).join("; ")}`],
      });
      if (ref && parsed) {
        erp.saveOrder({
          orderRef: ref,
          buyerGln: parsed.buyer_gln,
          supplierGln: parsed.supplier_gln,
          orderDate: parsed.order_date,
          lines: erpLines(parsed.lines),
          status: "pending_manual_edi",
          sourceDoc: docId,
          contractId: contract.id,
          notes: { flags: lastFlags },
        });
      }
      return { status: "awaiting_person", case_id: caseId, order_ref: ref, step: "manual_edi" };
    }

    if (result.status === PipelineStatus.AWAIT_GROK_QTY && parsed) {
      const overrides = new Map<number, number>();
      for (let i = 0; i < parsed.lines.length && i < result.availability.length; i++) {
        const line = parsed.lines[i];
        const check = result.availability[i];
        if (check.ok) continue;
        const product = erp.product({ gtin: line.gtin });
        const buyer = erp.retailer(parsed.buyer_gln)?.name || parsed.buyer_gln || "cliente";
        const nextDate = line.gtin ? nextReadyDate(erp, line.gtin) : null;
        const later = nextDate && line.gtin ? availableToPromise(erp, line.gtin, nextDate).atp : 0;
        const proposal = await proposeQtyResolution({
          orderRef: ref || "",
          gtin: line.gtin || "",
          product: product?.name || line.gtin || "",
          buyer,
          ordered: line.quantity || 0,
          available: check.available_qty || 0,
          nextDate,
          laterAvailable: later - (check.available_qty || 0),
          caller,
        });
        if (!proposal) continue;
        const n = line.line_no || i + 1;
        overrides.set(n, proposal.now_qty);
        if (proposal.later_qty) backorders.push({ line_no: n, gtin: line.gtin, qty: proposal.later_qty, date: proposal.later_date });
        erp.log(proposal.source, "order.qty_short", ref, { sourceDoc: docId, detail: proposal });
        notes.push(`Line ${n}: ${proposal.action} - ${proposal.message}`);
        personReasons.push(`stock was short on line ${n}: ${proposal.action} proposed by ${proposal.source}`);
      }
      if (!overrides.size || round >= MAX_ROUNDS) {
        const caseId = requestSignoff(erp, {
          row: "order",
          kind: "stock_short",
          subjectRef: ref || docId,
          title: `Order ${pyStr(ref)}: not enough stock and no split is possible`,
          proposal: { availability: result.availability.map((a) => ({ ...a })) },
          reasons: ["stock is short and code found no split or partial delivery"],
        });
        return { status: "awaiting_person", case_id: caseId, order_ref: ref, step: "stock_short" };
      }
      edi = orderToEdi(parsed, overrides);
      continue;
    }

    if (result.status === PipelineStatus.AWAIT_PRICE_HUMAN && parsed && ref) {
      const [mail, source] = await polishPriceMail(result.draft_mail || "", { caller });
      erp.saveOrder({
        orderRef: ref,
        buyerGln: parsed.buyer_gln,
        supplierGln: parsed.supplier_gln,
        orderDate: parsed.order_date,
        lines: erpLines(parsed.lines),
        status: "pending_price",
        sourceDoc: docId,
        contractId: contract.id,
        notes: { draft_mail: mail },
      });
      const bad = result.price_check ? result.price_check.lines.filter((l) => !l.ok) : [];
      const reasons = bad.map((l) => `GTIN ${pyStr(l.gtin)}: ordered at €${pyFloat(l.order_price)}, contract €${pyFloat(l.expected_price)}`);
      const caseId = requestSignoff(erp, {
        row: "order",
        kind: "price_fix",
        subjectRef: ref,
        title: `Order ${ref}: the price does not match contract ${contract.id}`,
        proposal: {
          draft_mail: mail,
          mail_by: source,
          grokbot: notes,
          price_check: result.price_check ? result.price_check.toDict() : null,
          options: ["manual_edi", "park_pending"],
        },
        reasons: reasons.length ? reasons : ["the price check failed"],
      });
      erp.log("code", "order.price_mismatch", ref, { sourceDoc: docId, detail: { case: caseId } });
      return { status: "awaiting_person", case_id: caseId, order_ref: ref, step: "price_fix" };
    }

    if (result.status === PipelineStatus.AWAIT_CONFIRM_SIGNOFF && parsed && ref) {
      const lines = parsed.lines.map((line, i) => {
        const n = line.line_no || i + 1;
        return {
          line_no: n,
          gtin: line.gtin,
          quantity: originalQty.has(n) ? originalQty.get(n)! : line.quantity,
          qty_confirmed: line.quantity,
          unit_price: line.unit_price,
        };
      });
      erp.saveOrder({
        orderRef: ref,
        buyerGln: parsed.buyer_gln,
        supplierGln: parsed.supplier_gln,
        orderDate: parsed.order_date,
        lines: lines.map((l) => ({ lineNo: l.line_no, gtin: l.gtin, quantity: l.quantity, qtyConfirmed: l.qty_confirmed, unitPrice: l.unit_price })),
        status: "awaiting_confirmation",
        sourceDoc: docId,
        contractId: contract.id,
        notes: { backorders, grokbot: notes },
      });
      const draft = buildOrdrsp(parsed);
      const caseId = requestSignoff(erp, {
        row: "order",
        kind: "confirm",
        subjectRef: ref,
        title: `Confirm order ${ref} before the ORDRSP goes out`,
        proposal: {
          lines,
          availability: result.availability.map((a) => ({ ...a })),
          price_check: result.price_check ? result.price_check.toDict() : null,
          backorders,
          grokbot: notes,
          draft_ordrsp: draft.body,
        },
        reasons: ["Order rule: a person confirms every order before ORDRSP", ...personReasons],
      });
      erp.log("code", "order.checks_passed", ref, { sourceDoc: docId, detail: { case: caseId } });
      return { status: "awaiting_person", case_id: caseId, order_ref: ref, step: "confirm" };
    }

    throw new Error(`order pipeline error: ${JSON.stringify(result.notes)}`);
  }
  throw new Error("order pipeline did not settle");
}

/** The person approves the confirm sign-off: write ORDRSP, return the hand-over for Shipping. */
export function confirmOrder(erp: Erp, caseId: string, d: { by: string; reason: string }): ConfirmedOrderHandoff {
  const c = erp.signoff(caseId);
  if (!c || c.kind !== "confirm") throw new Error(`${caseId} is not an order confirmation`);
  const order = erp.order(c.subjectRef ?? "");
  if (!order) throw new Error(`${caseId} is not an order confirmation`);
  for (const line of order.lines) {
    // another order may have been confirmed since the checks ran
    const want = line.qtyConfirmed ?? line.qtyOrdered;
    const atp = availableToPromise(erp, line.gtin ?? "", order.orderDate).atp;
    if (want && want > atp) {
      throw new Error(
        `order ${order.orderRef}: only ${pyG(atp)} of ${pyStr(line.gtin)} left since the checks; run the order again before confirming`,
      );
    }
  }
  decide(erp, caseId, { approve: true, by: d.by, reason: d.reason });
  const parsed = parsedFromErp(order);
  const ordrsp = buildOrdrsp(parsed, { responseDate: order.orderDate || null });
  const docId = erp.addDocument("ORDRSP", order.orderRef, ordrsp.body);
  erp.setOrder(order.orderRef, { status: "confirmed", ordrspRef: docId });
  erp.log("code", "order.ordrsp_sent", order.orderRef, { sourceDoc: docId });
  return {
    ...ordrsp.handoff,
    ordrsp_ref: docId,
    backorders: ((order.notes ?? {}).backorders as Backorder[] | undefined) || [],
    signoff_case: caseId,
  };
}

export function rejectOrder(erp: Erp, caseId: string, d: { by: string; reason: string }): void {
  const c = erp.signoff(caseId);
  decide(erp, caseId, { approve: false, by: d.by, reason: d.reason });
  if (c?.subjectRef && erp.order(c.subjectRef)) erp.setOrder(c.subjectRef, { status: "rejected" });
}

export type ParkedResult = { status: "parked"; order_ref: string | null };

/** Manual EDI goes back to Parse; no EDI parks the order as pending. */
export async function resolvePriceCase(
  erp: Erp,
  caseId: string,
  d: { by: string; reason: string; manualEdi?: string | null; caller?: Caller | null },
): Promise<ReceiveResult | ParkedResult> {
  const c = erp.signoff(caseId);
  if (!c || !["price_fix", "manual_edi"].includes(c.kind)) throw new Error(`${caseId} is not a price or EDI case`);
  if (d.manualEdi) {
    decide(erp, caseId, { approve: true, by: d.by, reason: d.reason, edits: { manual_edi: true } });
    return receiveOrder(erp, d.manualEdi, { sourceName: `manual EDI for ${pyStr(c.subjectRef)}`, caller: d.caller });
  }
  decide(erp, caseId, { approve: true, by: d.by, reason: d.reason, edits: { parked: true } });
  if (c.subjectRef && erp.order(c.subjectRef)) erp.setOrder(c.subjectRef, { status: "pending" });
  return { status: "parked", order_ref: c.subjectRef };
}
