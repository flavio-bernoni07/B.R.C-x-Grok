/**
 * Order row on the shared Mini ERP: ORDERS in, sign-off, ORDRSP and hand-over out
 * (port of order/service.py).
 *
 *   receiveOrder()      parse -> stock -> price, with Grokbot loops; stops at a person
 *   confirmOrder()      the person approves: ORDRSP is written, the hand-over is returned
 *   resolvePriceCase()  the person types a manual EDI (back to Parse) or parks the order
 *   resolveQtyCase()    stock short: operator chooses split (continue) or mail (park, no ORDRSP)
 *   simulateOrderFeed() run every EDI in data/orders/feed.json without stopping the batch
 *
 * The order-dec.md rules hold: Grok's fixes go back through the code checks, a wrong price
 * never reaches the confirm step, and a person confirms every order. Qty short is a human
 * gate: split ships available qty toward ORDRSP; mail parks with no ORDRSP.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Erp, Order } from "../core/erp";
import { decide, requestSignoff } from "../core/signoff";
import { availableToPromise, nextReadyDate } from "../core/stock";
import type { Caller } from "../grok/client";
import { dataPath } from "../paths";
import { ErpAvailabilityProvider } from "./availability";
import { loadContract, type SupplyContract } from "./contract";
import { polishPriceMail, proposeParseFix } from "./grokbot";
import { draftQtyShortMail } from "./mail";
import { buildOrdrsp, type OrdrspHandoff, qtyText } from "./ordrsp";
import type { OrderLine, ParsedOrder, ParseFlag } from "./parser";
import { PipelineStatus, runOrderPipeline } from "./pipeline";
import { pyFloat, pyG, pyStr } from "./py";

export const MAX_ROUNDS = 3;

export type ReceiveResult = {
  status: "awaiting_person";
  case_id: string;
  order_ref: string | null;
  step: "manual_edi" | "stock_short" | "qty_choice" | "price_fix" | "confirm";
};

export type QtyLineChoice = {
  line_no: number;
  gtin: string | null;
  ordered_qty: number;
  available_qty: number;
  now_qty: number;
  later_qty: number;
  later_date: string | null;
  product: string | null;
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

export type ReceiveResume = {
  notes?: string[];
  personReasons?: string[];
  backorders?: Backorder[];
  /** Original ordered qty by line, kept across a split so the confirm card still shows what was asked. */
  originalQty?: Map<number, number> | Record<string, number>;
};

/** Run one ORDERS message until it needs a person. Returns what happened. */
export async function receiveOrder(
  erp: Erp,
  rawEdi: string,
  opts: {
    sourceName?: string;
    contract?: SupplyContract | null;
    caller?: Caller | null;
    /** Carry notes / backorders when an operator split re-enters the pipeline. */
    resume?: ReceiveResume | null;
  } = {},
): Promise<ReceiveResult> {
  const contract = opts.contract ?? loadContract();
  const caller = opts.caller ?? null;
  const docId = erp.addDocument("ORDERS", null, rawEdi, { path: opts.sourceName ?? "ORDERS" });
  erp.log("retailer", "orders.received", null, { sourceDoc: docId });
  const provider = new ErpAvailabilityProvider(erp);

  let edi = rawEdi;
  const notes: string[] = [...(opts.resume?.notes ?? [])];
  const personReasons: string[] = [...(opts.resume?.personReasons ?? [])];
  const backorders: Backorder[] = [...(opts.resume?.backorders ?? [])];
  let originalQty = new Map<number, number>();
  if (opts.resume?.originalQty) {
    const raw = opts.resume.originalQty;
    if (raw instanceof Map) originalQty = new Map(raw);
    else for (const [k, v] of Object.entries(raw)) originalQty.set(Number(k), v);
  }
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
        // Live Grok or the offline Grokbot rules (date / IT thousands) — same apply path.
        erp.log("grok", "order.parse_fix", ref, { sourceDoc: docId, detail: fix.changes ?? null });
        const changed = (fix.changes || [])
          .map((c) => `${pyStr(c.segment)}: ${pyStr(c.before)} → ${pyStr(c.after)}`)
          .join(", ");
        notes.push(`Grokbot corrected the EDI (${changed}); the parser read it again.`);
        personReasons.push(`Grokbot corrected the EDI: ${changed || "see changes"}`);
        edi = fix.corrected_edi;
        continue;
      }
      const caseId = requestSignoff(erp, {
        row: "order",
        kind: "manual_edi",
        subjectRef: ref || docId,
        title: `Order ${ref || "(no number)"}: the EDI cannot be read safely`,
        proposal: {
          flags: lastFlags.map((f) => ({
            what: f.message,
            where: f.segment || null,
            code: f.code,
          })),
          options: ["manual_edi", "park_pending"],
        },
        reasons: [
          `The order file could not be read safely and Grokbot had no automatic fix: ${lastFlags.map((f) => f.message).join("; ")}`,
        ],
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
      // Operator chooses split (continue toward ORDRSP for available qty) or mail (park, no ORDRSP).
      // The batch / feed never auto-applies a split: every short line waits in Sign-off Pending.
      const lines: QtyLineChoice[] = [];
      for (let i = 0; i < parsed.lines.length && i < result.availability.length; i++) {
        const line = parsed.lines[i];
        const check = result.availability[i];
        if (check.ok) continue;
        const n = line.line_no || i + 1;
        const ordered = line.quantity || 0;
        const available = Math.max(check.available_qty || 0, 0);
        const nextDate = line.gtin ? nextReadyDate(erp, line.gtin) : null;
        const rest = Math.max(ordered - available, 0);
        const product = erp.product({ gtin: line.gtin });
        lines.push({
          line_no: n,
          gtin: line.gtin,
          ordered_qty: ordered,
          available_qty: available,
          now_qty: available,
          later_qty: nextDate && rest > 0 ? rest : 0,
          later_date: nextDate && rest > 0 ? nextDate : null,
          product: product?.name || line.gtin || null,
        });
      }
      const canSplit = lines.some((l) => l.now_qty > 0);
      if (!canSplit) {
        const caseId = requestSignoff(erp, {
          row: "order",
          kind: "stock_short",
          subjectRef: ref || docId,
          title: `Order ${pyStr(ref)}: not enough stock and no split is possible`,
          proposal: {
            edi,
            summary: "Nothing can ship now — stock is too short for a partial delivery.",
            availability: result.availability.map((a) => ({
              product: erp.product({ gtin: a.gtin })?.name || a.gtin,
              ordered: a.ordered_qty,
              available: a.available_qty,
              ok: a.ok,
            })),
          },
          reasons: ["Stock is short and there is no quantity available to ship now."],
        });
        if (ref) {
          erp.saveOrder({
            orderRef: ref,
            buyerGln: parsed.buyer_gln,
            supplierGln: parsed.supplier_gln,
            orderDate: parsed.order_date,
            lines: erpLines(parsed.lines),
            status: "stock_short",
            sourceDoc: docId,
            contractId: contract.id,
            notes: { grokbot: notes },
          });
        }
        return { status: "awaiting_person", case_id: caseId, order_ref: ref, step: "stock_short" };
      }

      const short = lines[0];
      const buyer = erp.retailer(parsed.buyer_gln)?.name || parsed.buyer_gln || "Dear Customer";
      const supplier = erp.retailer(parsed.supplier_gln)?.name || "Riso Scotti";
      const draftMail = draftQtyShortMail({
        orderNumber: ref,
        buyerName: buyer,
        supplierName: supplier,
        productName: short.product,
        gtin: short.gtin,
        orderedQty: short.ordered_qty,
        availableQty: short.available_qty,
        orderDate: parsed.order_date,
      });
      notes.push(
        `Stock short on line ${short.line_no}: ${pyG(short.available_qty)} of ${pyG(short.ordered_qty)} available. Waiting for split or mail.`,
      );
      if (ref) {
        erp.saveOrder({
          orderRef: ref,
          buyerGln: parsed.buyer_gln,
          supplierGln: parsed.supplier_gln,
          orderDate: parsed.order_date,
          lines: erpLines(parsed.lines),
          status: "pending_qty",
          sourceDoc: docId,
          contractId: contract.id,
          notes: { grokbot: notes, draft_mail: draftMail },
        });
      }
      const caseId = requestSignoff(erp, {
        row: "order",
        kind: "qty_choice",
        subjectRef: ref || docId,
        title: `Order ${pyStr(ref)}: stock short — split available qty or mail the retailer`,
        proposal: {
          // Kept for split rebuild; the UI does not show raw EDI on this gate.
          edi,
          lines: lines.map((l) => ({
            product: l.product,
            ordered: l.ordered_qty,
            ship_now: l.now_qty,
            later: l.later_qty,
            later_date: l.later_date,
            line_no: l.line_no,
            gtin: l.gtin,
            ordered_qty: l.ordered_qty,
            available_qty: l.available_qty,
            now_qty: l.now_qty,
            later_qty: l.later_qty,
          })),
          draft_mail: draftMail,
          grokbot: notes,
          options: ["split", "mail"],
          summary:
            short.later_date && short.later_qty > 0
              ? `Ship ${pyG(short.now_qty)} now; ${pyG(short.later_qty)} later (${short.later_date}). Or email the retailer and park.`
              : `Ship ${pyG(short.now_qty)} of ${pyG(short.ordered_qty)} now. Or email the retailer and park.`,
        },
        reasons: lines.map((l) => {
          const name = l.product || pyStr(l.gtin);
          const base = `${name}: ordered ${pyG(l.ordered_qty)}, only ${pyG(l.available_qty)} available now`;
          return l.later_date && l.later_qty > 0
            ? `${base}; remainder ${pyG(l.later_qty)} can ship later (${l.later_date})`
            : base;
        }),
      });
      erp.log("code", "order.qty_short", ref, {
        sourceDoc: docId,
        detail: { case: caseId, action: "await_operator", lines },
      });
      return { status: "awaiting_person", case_id: caseId, order_ref: ref, step: "qty_choice" };
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
          summary: `Unit price on the ORDERS does not match contract ${contract.id}. Mail the retailer or paste a corrected ORDERS.`,
        },
        reasons: reasons.length
          ? reasons.map((r) => r.replace(/^GTIN /, "Product "))
          : ["The price on the order does not match the supply contract."],
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

/** Manual EDI goes back to Parse; no EDI parks the order as pending (optionally after sending the price mail). */
export async function resolvePriceCase(
  erp: Erp,
  caseId: string,
  d: {
    by: string;
    reason: string;
    manualEdi?: string | null;
    caller?: Caller | null;
    draftMail?: string | null;
    mailTo?: string | null;
    sendMail?: boolean;
  },
): Promise<ReceiveResult | ParkedResult> {
  const c = erp.signoff(caseId);
  if (!c || !["price_fix", "manual_edi"].includes(c.kind)) throw new Error(`${caseId} is not a price or EDI case`);
  if (d.manualEdi) {
    decide(erp, caseId, { approve: true, by: d.by, reason: d.reason, edits: { manual_edi: true } });
    return receiveOrder(erp, d.manualEdi, { sourceName: `manual EDI for ${pyStr(c.subjectRef)}`, caller: d.caller });
  }
  const proposal = (c.proposal ?? {}) as { draft_mail?: string; grokbot?: string[] };
  const sentMail = (d.draftMail?.trim() || proposal.draft_mail || "").trim();
  const mailTo = d.mailTo?.trim() || null;
  decide(erp, caseId, {
    approve: true,
    by: d.by,
    reason: d.reason,
    edits: { parked: true, mail_sent: !!d.sendMail, draft_mail: sentMail || null, mail_to: mailTo },
  });
  if (c.subjectRef && erp.order(c.subjectRef)) {
    erp.setOrder(c.subjectRef, {
      status: "pending",
      notes: {
        draft_mail: sentMail || proposal.draft_mail,
        mail_to: mailTo,
        mail_sent: !!d.sendMail,
        grokbot: proposal.grokbot,
        parked_for: d.sendMail ? "price_mail" : "price_park",
      },
    });
  }
  if (d.sendMail) {
    erp.log(`person:${d.by.trim()}`, "order.price_parked", c.subjectRef, {
      detail: { case: caseId, action: "mail", mail_to: mailTo },
    });
  }
  return { status: "parked", order_ref: c.subjectRef };
}

/**
 * Stock short: operator chooses **split** (accept available qty, re-enter checks → confirm → ORDRSP
 * for that qty only) or **mail** (park pending with the draft, no ORDRSP). The feed does not wait.
 */
export async function resolveQtyCase(
  erp: Erp,
  caseId: string,
  d: {
    by: string;
    reason: string;
    action: "split" | "mail";
    caller?: Caller | null;
    /** Edited mail body from the compose UI (falls back to the case draft). */
    draftMail?: string | null;
    mailTo?: string | null;
  },
): Promise<ReceiveResult | ParkedResult> {
  const c = erp.signoff(caseId);
  if (!c || c.kind !== "qty_choice") throw new Error(`${caseId} is not a qty choice case`);
  const proposal = (c.proposal ?? {}) as {
    edi?: string;
    lines?: QtyLineChoice[];
    draft_mail?: string;
    grokbot?: string[];
  };
  const lines = proposal.lines ?? [];
  if (d.action === "mail") {
    const sentMail = (d.draftMail?.trim() || proposal.draft_mail || "").trim();
    const mailTo = d.mailTo?.trim() || null;
    decide(erp, caseId, {
      approve: true,
      by: d.by,
      reason: d.reason,
      edits: { qty_action: "mail", draft_mail: sentMail || null, mail_to: mailTo },
    });
    if (c.subjectRef && erp.order(c.subjectRef)) {
      erp.setOrder(c.subjectRef, {
        status: "pending",
        notes: {
          draft_mail: sentMail || proposal.draft_mail,
          mail_to: mailTo,
          mail_sent: true,
          grokbot: proposal.grokbot,
          parked_for: "qty_short_mail",
        },
      });
    }
    erp.log(`person:${d.by.trim()}`, "order.qty_parked", c.subjectRef, {
      detail: { case: caseId, action: "mail", mail_to: mailTo },
    });
    return { status: "parked", order_ref: c.subjectRef };
  }

  if (!proposal.edi || !lines.length) throw new Error(`${caseId} has no EDI to split`);
  const order = c.subjectRef ? erp.order(c.subjectRef) : null;
  const parsed = order
    ? parsedFromErp(order)
    : runOrderPipeline(proposal.edi).parse?.order ?? null;
  if (!parsed) throw new Error(`${caseId}: cannot rebuild the order for a split`);

  const overrides = new Map<number, number>();
  const backorders: Backorder[] = [];
  const originalQty = new Map<number, number>();
  for (const line of lines) {
    overrides.set(line.line_no, line.now_qty);
    originalQty.set(line.line_no, line.ordered_qty);
    if (line.later_qty > 0) {
      backorders.push({ line_no: line.line_no, gtin: line.gtin, qty: line.later_qty, date: line.later_date });
    }
  }
  decide(erp, caseId, { approve: true, by: d.by, reason: d.reason, edits: { qty_action: "split" } });
  const revised = orderToEdi(parsed, overrides);
  erp.log(`person:${d.by.trim()}`, "order.qty_split", c.subjectRef, {
    detail: { case: caseId, overrides: Object.fromEntries(overrides), backorders },
  });
  const notes = [
    ...(proposal.grokbot ?? []),
    `Operator split: ship available qty now` +
      (backorders.length ? `; remainder noted as backorder` : ` (remainder off this ORDRSP)`),
  ];
  const personReasons = lines.map(
    (l) => `stock was short on line ${l.line_no}: operator split to ${pyG(l.now_qty)} of ${pyG(l.ordered_qty)}`,
  );
  return receiveOrder(erp, revised, {
    sourceName: `split for ${pyStr(c.subjectRef)}`,
    caller: d.caller,
    resume: { notes, personReasons, backorders, originalQty },
  });
}

export type SimulateFeedItemResult = {
  id: string;
  label: string;
  file: string;
  ok: boolean;
  result?: ReceiveResult;
  error?: string;
};

type BenchPoLine = {
  order_ref?: string;
  item_code?: string;
  quantity?: number;
  unit_price?: number;
};

type BenchCase = {
  id: string;
  kind?: string;
  description?: string;
  po?: BenchPoLine[];
};

/** Map item_code → GTIN from the shared product list (world/products.json). */
function gtinByItemCode(): Map<string, string> {
  const raw = JSON.parse(readFileSync(dataPath("world", "products.json"), "utf8")) as {
    products?: { gtin: string; item_code: string }[];
  };
  return new Map((raw.products ?? []).map((p) => [p.item_code, p.gtin]));
}

/** Build a minimal ORDERS EDI from one labelled bench case (the 22 simulation POs). */
export function ediFromBenchCase(c: BenchCase, gtinMap: Map<string, string>): string | null {
  const lines = c.po ?? [];
  if (!lines.length) return null;
  const orderRef = lines[0].order_ref || c.id;
  const segs = [
    "UNH+1+ORDERS:D:96A:UN'",
    `BGM+220+${orderRef}+9'`,
    "DTM+137:20261104:102'",
    "NAD+BY+BUYER001::9'",
    "NAD+SU+SUPPLIER001::9'",
  ];
  let n = 0;
  for (const line of lines) {
    const code = line.item_code || "";
    const gtin = gtinMap.get(code);
    if (!gtin || line.quantity == null) continue;
    n += 1;
    segs.push(`LIN+${n}++${gtin}:EN'`);
    segs.push(`QTY+21:${line.quantity}'`);
    if (line.unit_price != null) segs.push(`PRI+AAA:${line.unit_price}:CT'`);
  }
  if (!n) return null;
  segs.push("UNS+S'");
  segs.push(`UNT+${segs.length + 1}+1'`);
  return segs.join("\n");
}

/** The 22 labelled bench POs already in the repo (data/bench/cases.json), as ORDERS messages. */
export function benchSimulationOrders(): { id: string; label: string; file: string; edi: string }[] {
  const bench = JSON.parse(readFileSync(dataPath("bench", "cases.json"), "utf8")) as { cases?: BenchCase[] };
  const gtinMap = gtinByItemCode();
  const out: { id: string; label: string; file: string; edi: string }[] = [];
  for (const c of bench.cases ?? []) {
    const edi = ediFromBenchCase(c, gtinMap);
    if (!edi) continue;
    const ref = c.po?.[0]?.order_ref || c.id;
    out.push({
      id: c.id,
      label: `${c.id} ${ref} — ${c.kind || "case"}`,
      file: `bench/${c.id}.edi`,
      edi,
    });
  }
  return out;
}

/**
 * Run the full Order simulation without stopping the batch on a human gate:
 * 1) the 22 labelled bench POs already in the repo
 * 2) optional golden order
 * 3) the ESS scenario files in data/orders/feed.json (messy / qty short / price / …)
 */
export async function simulateOrderFeed(
  erp: Erp,
  opts: { caller?: Caller | null; includeGolden?: boolean; includeBench?: boolean } = {},
): Promise<{ results: SimulateFeedItemResult[] }> {
  const feedPath = dataPath("orders", "feed.json");
  const feed = JSON.parse(readFileSync(feedPath, "utf8")) as {
    orders?: { id?: string; label?: string; file: string }[];
  };
  type Item = { id: string; label: string; file: string; edi?: string; absolute?: string };
  const items: Item[] = [];

  if (opts.includeBench !== false) {
    for (const b of benchSimulationOrders()) {
      items.push({ id: b.id, label: b.label, file: b.file, edi: b.edi });
    }
  }
  if (opts.includeGolden !== false) {
    items.push({
      id: "golden",
      label: "Golden ESS-GOLD-001",
      file: "world/golden/ORDERS_ESS-GOLD-001.edi",
      absolute: dataPath("world", "golden", "ORDERS_ESS-GOLD-001.edi"),
    });
  }
  for (const o of feed.orders ?? []) {
    items.push({
      id: o.id || o.file,
      label: o.label || o.file,
      file: o.file,
      absolute: join(dataPath("orders", "edi"), o.file),
    });
  }

  const results: SimulateFeedItemResult[] = [];
  for (const item of items) {
    try {
      const raw = item.edi ?? readFileSync(item.absolute!, "utf8");
      const result = await receiveOrder(erp, raw, { sourceName: item.file, caller: opts.caller ?? null });
      results.push({ id: item.id, label: item.label, file: item.file, ok: true, result });
    } catch (err) {
      results.push({ id: item.id, label: item.label, file: item.file, ok: false, error: (err as Error).message });
    }
  }
  return { results };
}
