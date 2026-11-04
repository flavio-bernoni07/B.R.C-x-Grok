/**
 * Shipping and invoicing row on the shared Mini ERP (port of shipping/service.py).
 *
 *     ingestConfirmedOrder()  hand-over 1: the Order row's payload after the person confirmed
 *     shipOrder()             released stock only, first in first out; DESADV + DDT
 *     recordDelivery()        proof of delivery: the signed DDT at the retailer's dock
 *     invoiceShipment()       the invoice bills what shipped, once; FatturaPA TD01 + INVOIC 380
 *     reconcileAndSend()      order vs DESADV vs invoice; clean invoices go out, unclear ones wait
 *     exportForDispute()      hand-over 2: the catalog shape Dispute's pullFacts reads
 *
 * On top of the Python module, read-only views for the tools and the page: `shippingList`,
 * `shippingFile`, `reconcileView` (ours beside threeway's answer on the same documents).
 */
import { runThreeway } from "../bench/score";
import { unknownNumbers } from "../core/checks";
import type { Erp, Invoice, Shipment } from "../core/erp";
import { requestSignoff } from "../core/signoff";
import { allocate, batches } from "../core/stock";
import { type Caller, chatJson, hasKey } from "../grok/client";
import * as cases from "./cases";
import { buildDdt, buildDesadv, buildInvoic380, buildTd01Xml, type InvoiceDocLine, money } from "./documents";
import { Money, pyG } from "./format";
import { BILLING_CAUSES, type DocLine, explain, type ReportDict, reconcileDocuments } from "./reconcile";
import * as wh from "./warehouse";

export { proposeWithGrok } from "./cases";

type Json = Record<string, unknown>;

export class ShippingError extends Error {}

const productList = (erp: Erp) => erp.products().map(wh.productDict);

// ----- hand-over 1 ----------------------------------------------------------

/** The Order row's hand-over (Python `confirm_order` shape). */
export type ConfirmedOrderHandoff = {
  order_number: string;
  buyer_gln?: string | null;
  supplier_gln?: string | null;
  order_date?: string | null;
  lines: { line_no?: number; gtin: string | null; quantity: number | null; unit_price?: number | null; [k: string]: unknown }[];
  ordrsp?: string;
  ordrsp_ref: string;
  backorders?: unknown[];
  signoff_case?: string;
  [k: string]: unknown;
};

/** Accept the Order row's hand-over. Only a confirmed order with its ORDRSP gets in. */
export function ingestConfirmedOrder(erp: Erp, handoff: ConfirmedOrderHandoff): string {
  const ref = handoff?.order_number;
  const order = ref ? erp.order(ref) : undefined;
  if (!order) throw new ShippingError(`unknown order ${ref == null ? "None" : `'${ref}'`}`);
  if (order.status !== "confirmed") throw new ShippingError(`order ${ref} is ${order.status}, not confirmed`);
  if (!handoff.ordrsp_ref || handoff.ordrsp_ref !== order.ordrspRef) throw new ShippingError(`order ${ref}: the hand-over has no matching ORDRSP`);
  const key = (gtin: string | null | undefined, q: number) => JSON.stringify([gtin ?? null, q]);
  const erpLines = new Set(order.lines.map((l) => key(l.gtin, Number(l.qtyConfirmed || l.qtyOrdered || 0))));
  const handoffLines = new Set((handoff.lines ?? []).map((l) => key(l.gtin, Number(l.quantity || 0))));
  const same = erpLines.size === handoffLines.size && [...erpLines].every((x) => handoffLines.has(x));
  if (!same) {
    throw new ShippingError(`order ${ref}: hand-over lines ${[...handoffLines].join(", ")} differ from the confirmed lines ${[...erpLines].join(", ")}`);
  }
  erp.setOrder(ref, { status: "ready_to_ship" });
  erp.log("code", "shipping.ingested", ref, { sourceDoc: order.ordrspRef, detail: { backorders: handoff.backorders ?? null } });
  return ref;
}

// ----- dispatch -------------------------------------------------------------

export function shipOrder(erp: Erp, orderRef: string, opts: { shipDate: string }): { desadv_ref: string; ddt_ref: string; lines: { gtin: string; batch: string; qty: number }[]; short: string[] } {
  const order = erp.order(orderRef);
  if (!order || order.status !== "ready_to_ship") throw new ShippingError(`order ${orderRef} is not ready to ship`);
  const products = wh.productsByGtin(erp);
  const retailer = wh.retailerDict(erp.retailer(order.buyerGln));
  const n = erp.shipments(orderRef).length + 1;
  const desadvRef = `DESADV-${orderRef}-${n}`;
  const ddtRef = `DDT-${orderRef}-${n}`;
  const lines: { gtin: string; batch: string; qty: number }[] = [];
  const gaps: string[] = [];
  for (const line of order.lines) {
    const gtin = line.gtin ?? "";
    const want = wh.lineWant(line);
    const { taken, shortfall } = allocate(erp, gtin, want);
    lines.push(...taken.map((t) => ({ gtin, batch: t.batch, qty: t.qty })));
    if (shortfall) {
      const held = batches(erp, gtin, "hold").map((b) => b.batch);
      const why = held.length ? `quality hold on ${held.join(", ")}` : "no released stock";
      gaps.push(`${products[gtin].item_code}: ${pyG(shortfall)} of ${pyG(want)} not shipped (${why})`);
    }
  }
  if (!lines.length) throw new ShippingError(`order ${orderRef}: nothing could be shipped (${gaps.join("; ")})`);
  const desadv = buildDesadv({
    desadvRef,
    orderRef,
    shipDate: opts.shipDate,
    buyerGln: order.buyerGln,
    supplierGln: order.supplierGln,
    deliveryPoint: retailer?.delivery_point ?? null,
    lines,
  });
  const desadvDoc = erp.addDocument("DESADV", desadvRef, desadv);
  const ddtDoc = erp.addDocument("DDT", ddtRef, buildDdt({ ddtRef, desadvRef, orderRef, shipDate: opts.shipDate, buyer: retailer, lines, products }));
  const note = gaps.length ? gaps.join("; ") : null;
  erp.saveShipment({ desadvRef, orderRef, shipDate: opts.shipDate, ddtRef, lines, sourceDoc: desadvDoc, notes: note });
  const notes: Json = { ...(order.notes ?? {}) };
  if (gaps.length) notes.fulfilment_gap = note;
  erp.setOrder(orderRef, { status: "shipped", notes });
  erp.log("code", "shipping.dispatched", orderRef, { sourceDoc: desadvDoc, detail: { desadv: desadvRef, ddt: ddtRef, ddt_doc: ddtDoc, short: gaps } });
  return { desadv_ref: desadvRef, ddt_ref: ddtRef, lines, short: gaps };
}

/** The retailer signs the DDT at the dock. Stored as proof for any later claim. */
export function recordDelivery(
  erp: Erp,
  desadvRef: string,
  opts: { signedBy: string; received?: Record<string, number> | null; note?: string | null; when?: string | null },
): string {
  const shipment = erp.shipment(desadvRef);
  if (!shipment) throw new ShippingError(`no shipment ${desadvRef}`);
  const products = wh.productsByGtin(erp);
  const shipped: Record<string, number> = {};
  for (const line of shipment.lines) shipped[line.gtin] = (shipped[line.gtin] ?? 0) + line.qty;
  const got = opts.received && Object.keys(opts.received).length ? opts.received : shipped;
  const parts: string[] = [];
  for (const [gtin, q] of Object.entries(shipped)) {
    const r = got[gtin] ?? q;
    const item = products[gtin].item_code;
    parts.push(r !== q ? `${item} ${pyG(r)} received of ${pyG(q)} shipped` : `${item} ${pyG(q)} received`);
  }
  const reserve = opts.note ? `, with reservation: ${opts.note}` : ", no notes";
  const summary = `Signed DDT ${shipment.ddtRef} by ${opts.signedBy}${opts.when ? ` on ${opts.when}` : ""}: ${parts.join("; ")}${reserve}`;
  const docId = `POD-${desadvRef}`;
  erp.addProof({ docId, orderRef: shipment.orderRef, kind: "pod", ref: shipment.ddtRef, summary });
  erp.log("retailer", "shipping.delivered", shipment.orderRef, { sourceDoc: docId, detail: { received: got, note: opts.note ?? null } });
  return docId;
}

// ----- invoice --------------------------------------------------------------

export type InvoiceResult = { invoice_ref: string; net: number; vat: number; total: number; td01_doc: string; invoic_doc: string };

/** Bill the shipped quantity at the confirmed price. A shipment is invoiced once. */
export function invoiceShipment(erp: Erp, desadvRef: string, opts: { invoiceDate: string }): InvoiceResult {
  const shipment = erp.shipment(desadvRef);
  if (!shipment) throw new ShippingError(`no shipment ${desadvRef}`);
  if (erp.invoices(shipment.orderRef).some((i) => i.desadvRef === desadvRef)) throw new ShippingError(`${desadvRef} is already invoiced`);
  const order = erp.order(shipment.orderRef)!;
  const products = wh.productsByGtin(erp);
  const prices = new Map(order.lines.map((l) => [l.gtin, l.unitPrice]));
  const qtyByGtin = new Map<string, number>();
  for (const line of shipment.lines) qtyByGtin.set(line.gtin, (qtyByGtin.get(line.gtin) ?? 0) + line.qty);
  const lines: InvoiceDocLine[] = [];
  for (const [gtin, q] of qtyByGtin) {
    const price = prices.get(gtin);
    if (price == null) throw new ShippingError(`no confirmed price for ${gtin} on ${order.orderRef}: an invoice never guesses a price`);
    lines.push({ gtin, qty: q, unit_price: price, vat_rate: products[gtin].vat_rate });
  }

  const invoiceRef = `FT-2026/${erp.nextId("invoice", "", 4)}`;
  const lineNet = (l: InvoiceDocLine) => money(Money.of(l.qty).mul(Money.of(l.unit_price)));
  let net = Money.of("0");
  for (const l of lines) net = net.add(lineNet(l));
  const vatByRate = new Map<number, Money>();
  for (const l of lines) vatByRate.set(l.vat_rate, (vatByRate.get(l.vat_rate) ?? Money.of("0")).add(lineNet(l)));
  let vat = Money.of("0");
  for (const [rate, base] of vatByRate) vat = vat.add(money(base.mul(Money.of(rate)).divPow10(2)));
  const total = net.add(vat);
  const retailer = wh.retailerDict(erp.retailer(order.buyerGln)) ?? { name: order.buyerGln };
  const [xml, a38Total] = buildTd01Xml({
    invoiceRef,
    invoiceDate: opts.invoiceDate,
    orderRef: order.orderRef,
    ddtRef: shipment.ddtRef ?? "",
    shipDate: shipment.shipDate ?? "",
    buyer: retailer,
    lines,
    products,
  });
  if (!a38Total.eq(total)) throw new ShippingError(`invoice total mismatch: code ${total}, a38 ${a38Total}`);
  const edi = buildInvoic380({
    invoiceRef,
    invoiceDate: opts.invoiceDate,
    orderRef: order.orderRef,
    desadvRef,
    buyerGln: order.buyerGln,
    supplierGln: order.supplierGln,
    lines,
    totalNet: net,
    totalVat: vat,
    total,
  });
  const xmlDoc = erp.addDocument("FatturaPA TD01", invoiceRef, xml);
  const ediDoc = erp.addDocument("INVOIC 380", invoiceRef, edi);
  erp.saveInvoice({
    invoiceRef,
    orderRef: order.orderRef,
    desadvRef,
    invoiceDate: opts.invoiceDate,
    lines: lines.map((l) => ({ gtin: l.gtin, qty: l.qty, unitPrice: l.unit_price, vatRate: l.vat_rate })),
    totalNet: net.toNumber(),
    totalVat: vat.toNumber(),
    total: total.toNumber(),
    status: "draft",
    sourceDoc: xmlDoc,
  });
  erp.log("code", "shipping.invoiced", order.orderRef, { sourceDoc: xmlDoc, detail: { invoice: invoiceRef, edi_doc: ediDoc, net: net.toNumber(), vat: vat.toNumber() } });
  return { invoice_ref: invoiceRef, net: net.toNumber(), vat: vat.toNumber(), total: total.toNumber(), td01_doc: xmlDoc, invoic_doc: ediDoc };
}

// ----- reconcile, explain, send --------------------------------------------

/** The three documents of an order as reconciliation lines: order, DESADV, invoice. */
export function docsFor(erp: Erp, orderRef: string): [DocLine[], DocLine[], DocLine[]] {
  const order = erp.order(orderRef);
  if (!order) throw new ShippingError(`unknown order '${orderRef}'`);
  const products = wh.productsByGtin(erp);
  const p = (gtin: string | null) => products[gtin ?? ""];
  const po: DocLine[] = order.lines.map((l) => ({
    order_ref: orderRef,
    item_code: p(l.gtin).item_code,
    quantity: l.qtyConfirmed !== null ? l.qtyConfirmed : l.qtyOrdered,
    unit_price: l.unitPrice,
    uom: p(l.gtin).uom,
  }));
  const received: DocLine[] = erp
    .shipments(orderRef)
    .flatMap((s) => s.lines.map((l) => ({ order_ref: s.orderRef, item_code: p(l.gtin).item_code, quantity: l.qty, uom: p(l.gtin).uom })));
  const invoiced: DocLine[] = erp
    .invoices(orderRef)
    .flatMap((i) => i.lines.map((l) => ({ order_ref: i.orderRef, item_code: p(l.gtin).item_code, quantity: l.qty, unit_price: l.unitPrice, uom: p(l.gtin).uom })));
  return [po, received, invoiced];
}

/** Grok rewrites the code's explanation for the person; every figure must already be in the facts. */
export async function explainFlags(reportText: string, factsText: string, opts: { caller?: Caller | null } = {}): Promise<[string, "code" | "grok"]> {
  const caller = opts.caller ?? null;
  if (caller === null && !hasKey()) return [reportText, "code"];
  const messages = [
    {
      role: "system" as const,
      content:
        "You explain reconciliation flags to the Riso Scotti invoicing desk in two or three short sentences. " +
        "Name every cause and its euro amount. Use only figures from the facts. " +
        'Return one JSON object: {"explanation": string, "confidence": number}.',
    },
    { role: "user" as const, content: `Code findings: ${reportText}\n\nFacts: ${factsText}` },
  ];
  const validate = (payload: Json): string[] => {
    const text = String(payload.explanation || "");
    if (!text) return ["explanation is empty"];
    const extra = unknownNumbers(text, `${reportText} ${factsText}`);
    return extra.size ? [`figures not in the facts: ${JSON.stringify([...extra].sort())}`] : [];
  };
  try {
    const payload = await chatJson(messages, { task: "shipping.explain_flags", validate, caller });
    return [String(payload.explanation), "grok"];
  } catch {
    return [reportText, "code"];
  }
}

export type ReconcileSendResult = {
  status: "sent" | "awaiting_person";
  report: ReportDict;
  explanation: string;
  explained_by: "code" | "grok";
  follow_up?: unknown;
  case_id?: string;
};

/**
 * Clean invoices go out. A short delivery with a recorded cause goes out too, and is followed
 * up. Anything else (a billing error, an unexplained gap) waits for a person.
 */
export async function reconcileAndSend(erp: Erp, orderRef: string, opts: { caller?: Caller | null } = {}): Promise<ReconcileSendResult> {
  const [po, received, invoiced] = docsFor(erp, orderRef);
  const report = reconcileDocuments(po, received, invoiced, { products: productList(erp) });
  const codeText = explain(report);
  const order = erp.order(orderRef)!;
  const shipments = erp.shipments(orderRef);
  const factsText = shipments.map((s) => `${s.desadvRef} notes: ${s.notes || "none"}`).join("; ");
  const pendingInvoices = erp.invoices(orderRef).filter((i) => i.status === "draft");

  const gapExplained = report.status === "fulfilment_gap" ? shipments.every((s) => !!s.notes) : true;
  const clear = report.status === "matched" || (report.status === "fulfilment_gap" && gapExplained);
  const result: ReconcileSendResult = { status: "sent", report: report.toDict(), explanation: codeText, explained_by: "code" };

  if (clear) {
    for (const inv of pendingInvoices) {
      erp.setInvoiceStatus(inv.invoiceRef, "sent");
      erp.log("code", "shipping.invoice_sent", orderRef, { sourceDoc: inv.sourceDoc, detail: { to: ["retailer (EDI INVOIC)", "SdI (FatturaPA)"], simulated: true } });
    }
    erp.setOrder(orderRef, { status: "invoiced" });
    result.status = "sent";
    if (report.status === "fulfilment_gap") result.follow_up = (order.notes ?? {}).fulfilment_gap ?? null;
    erp.log("code", "shipping.reconciled", orderRef, { detail: report.toDict() });
    return result;
  }

  const [text, by] = await explainFlags(codeText, factsText, { caller: opts.caller });
  const reasons: string[] = [];
  const billing = [...report.causes].filter((c) => BILLING_CAUSES.has(c)).sort();
  if (billing.length) reasons.push(`billing error found: ${billing.join(", ")}`);
  if (report.status === "fulfilment_gap" && !gapExplained) reasons.push("a short delivery has no recorded cause");
  if (report.notes.some((n) => n.includes("several orders"))) reasons.push("a reference matches more than one order");
  const caseId = requestSignoff(erp, {
    row: "shipping",
    kind: "reconcile",
    subjectRef: orderRef,
    title: `Order ${orderRef}: invoice held, the documents disagree`,
    proposal: {
      report: report.toDict(),
      explanation: text,
      explained_by: by,
      invoices: pendingInvoices.map((i) => i.invoiceRef),
      options: ["correct the invoice and reconcile again", "send as is"],
    },
    reasons: reasons.length ? reasons : ["the documents disagree"],
  });
  erp.log("code", "shipping.held", orderRef, { sourceDoc: caseId, detail: report.toDict() });
  return { ...result, status: "awaiting_person", case_id: caseId, explanation: text, explained_by: by };
}

// ----- hand-over 2 ----------------------------------------------------------

export type DisputeCatalog = {
  orders: Json[];
  desadv: Json[];
  invoices: Json[];
  proofs: Json[];
};

/**
 * Everything shipped and invoiced, in the shape of data/disputes/erp/catalog.json. With
 * `orderRef`, only that order (the Python function always exports every shipped order).
 */
export function exportForDispute(erp: Erp, orderRef?: string | null): DisputeCatalog {
  const products = wh.productsByGtin(erp);
  const p = (gtin: string | null) => products[gtin ?? ""];
  const out: DisputeCatalog = { orders: [], desadv: [], invoices: [], proofs: [] };
  const orders = orderRef ? [erp.order(orderRef)].filter((o) => o !== undefined) : erp.orders();
  for (const order of orders) {
    const shipments = erp.shipments(order.orderRef);
    if (!shipments.length) continue;
    const retailer = erp.retailer(order.buyerGln);
    const date = order.orderDate || "";
    out.orders.push({
      doc_id: `ORD-${order.orderRef}`,
      order_ref: order.orderRef,
      aliases: [],
      customer: retailer?.name || order.buyerGln,
      order_date: date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date,
      lines: order.lines.map((l) => ({
        item_code: p(l.gtin).item_code,
        product: p(l.gtin).name,
        quantity: l.qtyConfirmed !== null ? l.qtyConfirmed : l.qtyOrdered,
        unit_price: l.unitPrice,
        uom: p(l.gtin).uom,
      })),
    });
    for (const s of shipments) {
      const merged = new Map<string, number>();
      for (const l of s.lines) merged.set(l.gtin, (merged.get(l.gtin) ?? 0) + l.qty);
      out.desadv.push({
        doc_id: s.sourceDoc,
        desadv_ref: s.desadvRef,
        order_ref: s.orderRef,
        ship_date: s.shipDate,
        lines: [...merged].map(([g, q]) => ({ item_code: p(g).item_code, product: p(g).name, quantity: q, uom: p(g).uom })),
        notes: s.notes || "",
      });
      out.proofs.push({ doc_id: `DDT-DOC-${s.ddtRef}`, order_ref: s.orderRef, kind: "ddt", ref: s.ddtRef, summary: `DDT ${s.ddtRef} issued with ${s.desadvRef}` });
    }
    for (const inv of erp.invoices(order.orderRef)) {
      const ref = inv.invoiceRef;
      out.invoices.push({
        doc_id: inv.sourceDoc,
        invoice_ref: ref,
        aliases: [ref.replace(/\//g, "-"), ref.replace(/\//g, "").replace(/-/g, "")],
        order_ref: inv.orderRef,
        invoice_date: inv.invoiceDate,
        currency: "EUR",
        total: inv.totalNet,
        lines: inv.lines.map((l) => ({ item_code: p(l.gtin).item_code, product: p(l.gtin).name, quantity: l.qty, unit_price: l.unitPrice, uom: p(l.gtin).uom })),
        notes: `status ${inv.status}`,
      });
    }
    for (const proof of erp.proofs(order.orderRef)) {
      out.proofs.push({ doc_id: proof.docId, order_ref: proof.orderRef, kind: proof.kind, ref: proof.ref, summary: proof.summary });
    }
  }
  return out;
}

// ----- read-only views for the tools and the Shipping page -------------------

export type Answer = { attention: boolean; causes: string[] };

export type ReconcileView = {
  order_ref: string;
  report: ReportDict;
  explanation: string;
  /** Our answer and threeway's on the same three documents (threeway with default settings). */
  ours: Answer;
  threeway: Answer;
  threeway_wrong: boolean;
  invoiced_total: number;
};

/** Reconcile an order's documents without sending or holding anything. */
export function reconcileView(erp: Erp, orderRef: string): ReconcileView {
  const [po, received, invoiced] = docsFor(erp, orderRef);
  const report = reconcileDocuments(po, received, invoiced, { products: productList(erp) });
  const ours = { attention: report.status !== "matched", causes: [...report.causes].sort() };
  const threeway = runThreeway({ po, received, invoiced });
  const threewayWrong = threeway.attention !== ours.attention || threeway.causes.join(",") !== ours.causes.join(",");
  const invoicedTotal = erp.invoices(orderRef).reduce((a, i) => a + (i.totalNet ?? 0), 0);
  return { order_ref: orderRef, report: report.toDict(), explanation: explain(report), ours, threeway, threeway_wrong: threewayWrong, invoiced_total: invoicedTotal };
}

export type ShippingListRow = {
  order_ref: string;
  customer: string | null;
  order_status: string;
  invoice_refs: string[];
  invoice_status: string | null;
  invoiced_net: number | null;
  shipments: number;
  short: string | null;
  truck_id: string | null;
  open_cases: number;
  pending_signoffs: number;
  reconcile: (ReconcileView & { status: string }) | null;
};

const SHIPPING_STATUSES = new Set(["ready_to_ship", "shipped", "invoiced"]);

/** Orders in the Shipping row: ready to ship, shipped or invoiced, with the reconcile result. */
export function shippingList(erp: Erp): ShippingListRow[] {
  const allCases = cases.exceptionCases(erp);
  const signoffs = erp.signoffs({ row: "shipping", status: "pending" });
  return erp
    .orders()
    .filter((o) => SHIPPING_STATUSES.has(o.status) || erp.shipments(o.orderRef).length > 0)
    .map((o) => {
      const shipments = erp.shipments(o.orderRef);
      const invoices = erp.invoices(o.orderRef);
      let rec: ShippingListRow["reconcile"] = null;
      if (shipments.length && invoices.length) {
        const view = reconcileView(erp, o.orderRef);
        rec = { ...view, status: view.report.status };
      }
      const caseIds = new Set(allCases.filter((c) => c.order_ref === o.orderRef).map((c) => c.case_id));
      return {
        order_ref: o.orderRef,
        customer: erp.retailer(o.buyerGln)?.name ?? o.buyerGln,
        order_status: o.status,
        invoice_refs: invoices.map((i) => i.invoiceRef),
        invoice_status: invoices.length ? invoices[invoices.length - 1].status : null,
        invoiced_net: invoices.length ? invoices.reduce((a, i) => a + (i.totalNet ?? 0), 0) : null,
        shipments: shipments.length,
        short: shipments.map((s) => s.notes).filter(Boolean).join("; ") || null,
        truck_id: ((o.notes ?? {}).truck_id as string | undefined) ?? wh.manifestForOrder(erp, o.orderRef)?.truck_id ?? null,
        open_cases: allCases.filter((c) => c.order_ref === o.orderRef && !["executed", "rejected"].includes(c.status)).length,
        pending_signoffs: signoffs.filter((s) => s.subjectRef === o.orderRef || caseIds.has(s.subjectRef ?? "")).length,
        reconcile: rec,
      };
    });
}

export type ShippingFile = {
  order: Json | null;
  customer: string | null;
  plan: { manifest: wh.Manifest | null; truck: wh.Truck | null; load: wh.OrderLoad | null };
  pallets: wh.Pallet[];
  scans: wh.ScanRow[];
  loading: wh.Loading | null;
  shipments: (Shipment & { documents: { doc_id: string; kind: string; ref: string | null }[] })[];
  invoices: (Invoice & { documents: { doc_id: string; kind: string; ref: string | null }[] })[];
  proofs: Json[];
  reconcile: ReconcileView | null;
  exceptions: wh.ShippingException[];
  exception_cases: (cases.ExceptionCase & { proposal_records: cases.Proposal[] })[];
  signoffs: Json[];
  audit: Json[];
};

/** One order's whole shipping file: each step from plan to approval, with its sources. */
export function shippingFile(erp: Erp, orderRef: string): ShippingFile {
  const order = erp.order(orderRef);
  if (!order) throw new ShippingError(`unknown order '${orderRef}'`);
  const docsOf = (ref: string | null) =>
    ref ? erp.documents({ ref }).map((d) => ({ doc_id: d.docId, kind: d.kind, ref: d.ref })) : [];
  const manifest = wh.manifestForOrder(erp, orderRef) ?? null;
  let load: wh.OrderLoad | null = null;
  try {
    load = wh.orderLoad(erp, orderRef);
  } catch {
    load = null;
  }
  const shipments = erp.shipments(orderRef);
  const invoices = erp.invoices(orderRef);
  const exceptionCases = cases.exceptionCases(erp, orderRef).map((c) => ({ ...c, proposal_records: cases.proposals(erp, c.case_id) }));
  const subjects = new Set([orderRef, ...exceptionCases.map((c) => c.case_id)]);
  return {
    order: cases.orderDict(order),
    customer: erp.retailer(order.buyerGln)?.name ?? order.buyerGln,
    plan: { manifest, truck: manifest ? (wh.truck(erp, manifest.truck_id) ?? null) : null, load },
    pallets: wh.pallets(erp, orderRef),
    scans: wh.scans(erp, orderRef),
    loading: wh.loadingFor(erp, orderRef) ?? null,
    shipments: shipments.map((s) => ({ ...s, documents: [...docsOf(s.desadvRef), ...docsOf(s.ddtRef)] })),
    invoices: invoices.map((i) => ({ ...i, documents: docsOf(i.invoiceRef) })),
    proofs: erp.proofs(orderRef).map((p) => ({ doc_id: p.docId, order_ref: p.orderRef, kind: p.kind, ref: p.ref, summary: p.summary })),
    reconcile: shipments.length && invoices.length ? reconcileView(erp, orderRef) : null,
    exceptions: wh.exceptions(erp, orderRef),
    exception_cases: exceptionCases,
    signoffs: erp.signoffs({ row: "shipping" }).filter((s) => subjects.has(s.subjectRef ?? "")) as unknown as Json[],
    audit: erp.auditLog(orderRef) as unknown as Json[],
  };
}

/** Open exception cases with what may be proposed for each. */
export function openCases(erp: Erp, orderRef?: string) {
  return cases
    .exceptionCases(erp, orderRef)
    .filter((c) => !["executed"].includes(c.status))
    .map((c) => ({
      case_id: c.case_id,
      type: c.type,
      severity: c.severity,
      order_ref: c.order_ref,
      pallet_id: c.pallet_id,
      truck_id: c.truck_id,
      explanation: c.explanation,
      role: c.role,
      department: c.department,
      status: c.status,
      allowed_actions: c.possible_actions.map((a) => a.action),
      never_allowed: [...cases.FORBIDDEN].sort(),
      selected: c.possible_actions.filter((a) => a.selected).map((a) => a.action),
      proposals: cases.proposals(erp, c.case_id),
      signoff_case: c.signoff_case,
      resolution: c.resolution ?? null,
    }));
}
