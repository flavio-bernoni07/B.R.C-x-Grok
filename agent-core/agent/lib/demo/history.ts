/**
 * Three months of orders (demo data, data/world/history): after the dispatch day, the split order
 * and the case study, the seed replays past orders for the other retailers and products through
 * the real rows, so the app opens on a back office with a past and not only on one order.
 *
 * For each order in history.json:
 *
 * 1. Its production lots are finished first (`lots`), so the order ships from its own stock and the
 *    stock on hand on 4 Nov stays what data/world/stock.json says (Arborio is never touched: the
 *    ambiguous-order scenario ESS-AMB-001 needs 6,000 packs of it).
 * 2. Order:    the retailer's ORDERS (ORDERS_<ref>.edi) is received and checked. A clean order is
 *              confirmed by Grok under the policy auto_when_clean (by the order desk under
 *              always_person); Bennet's wrong price and Auchan's garbled EDI wait for a person.
 * 3. Shipping: a truck of its own (`planTruckLoads`), picking list, pallet scans, loading, dispatch
 *              (DESADV + DDT), invoice (FatturaPA TD01 + INVOIC 380), reconciliation; then the
 *              retailer signs the DDT (proof of delivery), with any reservation it wrote.
 *              LID-40388 only gets its truck for 5 Nov: no order is left ready to ship without a
 *              truck, so the 6 Nov plan keeps its seven orders.
 * 4. Dispute:  claim emails (claims/*.txt) read and decided with Grok's recorded answers
 *              (grok_recorded.json): two credit notes with no person, two evidence replies, one
 *              case for a person.
 * 5. Finance:  the month's remittances (REMADV): a deduction that equals our credit note is matched,
 *              an unexplained one, or Esselunga's €300 flyer contribution (AJT PC, no promo annex in the
 *              contract), becomes a claim for a person (case-study.ts `applyRemittance`).
 *
 * Every amount in a claim email or a remittance is filled in from the Mini ERP documents of that
 * order (invoice line price, quantity, invoice total); none is typed in by hand.
 */
import { readFileSync } from "node:fs";
import { contractFor } from "../core/contracts";
import type { Erp } from "../core/erp";
import { readPolicy } from "../core/policy";
import { recordEvent } from "../core/stock";
import { handleClaim } from "../dispute/service";
import type { Caller } from "../grok/client";
import { confirmOrder, receiveOrder } from "../order/service";
import { dataPath } from "../paths";
import { ingestConfirmedOrder, invoiceShipment, reconcileAndSend, recordDelivery } from "../shipping/service";
import * as wh from "../shipping/warehouse";
import { applyRemittance } from "./case-study";

type Lot = { batch: string; item: string; qty: number; note: string };
type HistoryOrder = {
  ref: string;
  lots?: Lot[];
  ship?: { date: string; truck: string; plate: string; planned_only?: boolean };
  deliver?: { date: string; signed_by: string; received?: Record<string, number>; note?: string };
  /** What the order row must stop at: "clean" (default: confirmed), or the sign-off step a person gets. */
  expect?: "clean" | "confirm" | "price_fix" | "manual_edi" | "stock_short";
};
type HistoryClaim = { key: string; order: string; file: string; date: string; item?: string; qty?: number; claimed_price?: number; penalty_pct?: number; expect: "closed" | "awaiting_person" };
/** A deduction the retailer explains with an EDI adjustment code (AJT), e.g. PC for a promo contribution. */
type HistoryAdjustment = { code: string; amount: number; note: string };
type HistoryRemittance = {
  ref: string;
  date: string;
  orders: { order: string; credit_from?: string; short_unexplained?: number; adjustments?: HistoryAdjustment[] }[];
  verdict?: string;
};
export type HistorySpec = { orders: HistoryOrder[]; claims: HistoryClaim[]; remittances: HistoryRemittance[] };

type Obj = Record<string, unknown>;
type Vars = Record<string, string | number>;

const dir = (...f: string[]) => dataPath("world", "history", ...f);
const read = (f: string) => readFileSync(dir(f), "utf8");
export const loadHistorySpec = () => JSON.parse(read("history.json")) as HistorySpec;
const recordedAnswers = () => JSON.parse(read("grok_recorded.json")) as Obj;

const round2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;
const eur = (v: number) => v.toFixed(2);
const itNum = (v: number, decimals = 0) => v.toLocaleString("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const itDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const ymd = (iso: string) => iso.replace(/-/g, "");

/** {{name}} -> the value; a placeholder with no value is an error (the world changed). */
export function fillText(text: string, vars: Vars): string {
  const out = text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  const left = out.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`no value for ${left[0]}`);
  return out;
}

/** Fill a recorded answer: a string that is only a numeric placeholder becomes that number. */
export function fillJson(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") {
    const only = /^\{\{(\w+)\}\}$/.exec(value);
    if (only && typeof vars[only[1]] === "number") return vars[only[1]];
    return fillText(value, vars);
  }
  if (Array.isArray(value)) return value.map((v) => fillJson(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Obj).filter(([k]) => k !== "_comment").map(([k, v]) => [k, fillJson(v, vars)]));
  }
  return value;
}

/** Recorded order answers (EDI fix, price mail), picked by the task the system prompt names. */
function orderCaller(recorded: Obj, ref: string): Caller {
  return (messages) => {
    const system = String(messages[0]?.content ?? "");
    const task = system.includes("repair EDIFACT") ? "order.fix_parse" : system.includes("price-discrepancy") ? "order.price_mail" : null;
    const answer = task ? ((recorded[task] ?? {}) as Obj)[ref] : undefined;
    if (!answer) throw new Error(`no recorded Grok answer for ${ref} (${task ?? "unknown task"})`);
    return JSON.parse(JSON.stringify(answer));
  };
}

function gtinOf(erp: Erp, item: string): string {
  const p = erp.product({ itemCode: item });
  if (!p) throw new Error(`no product ${item}`);
  return p.gtin;
}

/** What every claim and remittance about this order may quote: its documents, from the Mini ERP. */
function orderVars(erp: Erp, spec: HistorySpec, ref: string): Vars {
  const order = erp.order(ref);
  if (!order) throw new Error(`no order ${ref}`);
  const shipment = erp.shipments(ref).at(-1);
  const invoice = erp.invoices(ref).at(-1);
  const proof = erp.proofs(ref).at(-1);
  if (!shipment || !invoice) throw new Error(`${ref} has no shipment or invoice to quote`);
  const deliver = spec.orders.find((o) => o.ref === ref)?.deliver;
  const net = invoice.totalNet ?? 0;
  return {
    order: ref,
    invoice: invoice.invoiceRef,
    desadv: shipment.desadvRef,
    ddt: shipment.ddtRef ?? "",
    pod: proof?.docId ?? "",
    contract: contractFor(order.buyerGln)?.id ?? order.contractId ?? "",
    net,
    net_it: itNum(net, 2),
    total: invoice.total ?? 0,
    ship_date: shipment.shipDate ?? "",
    deliver_date: deliver?.date ?? "",
    deliver_date_it: deliver ? itDate(deliver.date) : "",
  };
}

function claimVars(erp: Erp, spec: HistorySpec, c: HistoryClaim): Vars {
  const vars = orderVars(erp, spec, c.order);
  if (c.penalty_pct != null) {
    const penalty = round2((Number(vars.net) * c.penalty_pct) / 100);
    Object.assign(vars, { penalty_pct: c.penalty_pct, penalty, penalty_it: itNum(penalty, 2) });
  }
  if (!c.item) return vars;
  const gtin = gtinOf(erp, c.item);
  const line = erp.invoices(c.order).at(-1)!.lines.find((l) => l.gtin === gtin);
  if (!line) throw new Error(`${c.order}: no invoice line for ${c.item}`);
  const price = line.unitPrice;
  const qty = c.qty ?? line.qty;
  const shipped = erp.shipments(c.order).flatMap((s) => s.lines).filter((l) => l.gtin === gtin).reduce((a, l) => a + l.qty, 0);
  const received = spec.orders.find((o) => o.ref === c.order)?.deliver?.received?.[c.item] ?? shipped;
  // A price claim asks for the difference to the price the retailer expected; any other claim, the quantity at the invoice price.
  const amount = c.claimed_price != null ? round2((price - c.claimed_price) * qty) : round2(qty * price);
  return {
    ...vars,
    item: c.item,
    product: erp.product({ gtin })?.name ?? c.item,
    qty,
    price,
    price_it: itNum(price, 2),
    amount,
    amount_it: itNum(amount, 2),
    shipped,
    shipped_it: itNum(shipped),
    received,
    received_it: itNum(received),
    ...(c.claimed_price != null ? { claimed_price: c.claimed_price, claimed_price_it: itNum(c.claimed_price, 2) } : {}),
  };
}

/** The retailer's REMADV for this month's invoices: what is due, our credit notes it deducts, what it pays. */
function remadvText(erp: Erp, r: HistoryRemittance, credits: Map<string, { number: string; amount: number }>): { text: string; vars: Vars } {
  const payer = erp.order(r.orders[0].order)?.buyerGln;
  const docs: string[] = [];
  let total = 0;
  let vars: Vars = { remittance: r.ref };
  for (const x of r.orders) {
    const inv = erp.invoices(x.order).at(-1);
    if (!inv?.total) throw new Error(`${r.ref}: ${x.order} has no invoice to pay`);
    const credit = x.credit_from ? credits.get(x.credit_from) : undefined;
    if (x.credit_from && !credit) throw new Error(`${r.ref}: no credit note from claim ${x.credit_from}`);
    const adjusted = round2((x.adjustments ?? []).reduce((a, j) => a + j.amount, 0));
    const paid = round2(inv.total - (credit?.amount ?? 0) - (x.short_unexplained ?? 0) - adjusted);
    total = round2(total + paid);
    docs.push(`DOC+380+${inv.invoiceRef}'`, `MOA+12:${eur(inv.total)}'`, `MOA+9:${eur(paid)}'`);
    if (credit) docs.push("AJT+CN'", `MOA+5:${eur(credit.amount)}'`, `FTX+AAI+++Nota di credito ${credit.number}'`);
    for (const j of x.adjustments ?? []) docs.push(`AJT+${j.code}'`, `MOA+5:${eur(j.amount)}'`, `FTX+AAI+++${j.note}'`);
    if (x.short_unexplained) vars = { ...vars, ...orderVars(erp, { orders: [], claims: [], remittances: [] }, x.order), short: `€${eur(x.short_unexplained)}` };
    if (adjusted) {
      const first = x.adjustments![0];
      vars = { ...vars, ...orderVars(erp, { orders: [], claims: [], remittances: [] }, x.order), deducted: `€${eur(adjusted)}`, adjustment: `${first.code} ${first.note}` };
    }
  }
  const seg = [
    "UNH+1+REMADV:D:96A:UN:EAN002'",
    `BGM+481+${r.ref}+9'`,
    `DTM+137:${ymd(r.date)}:102'`,
    `DTM+209:${ymd(r.date)}:102'`,
    "NAD+PE+SUPPLIER001::9'",
    `NAD+PR+${payer}::9'`,
    "CUX+2:EUR:11'",
    `MOA+9:${eur(total)}'`,
    ...docs,
  ];
  seg.push(`UNT+${seg.length}+1'`);
  return { text: `${seg.join("\n")}\n`, vars };
}

export type HistoryResult = { orders: string[]; claims: Record<string, string>; remittances: string[] };

export async function seedHistory(erp: Erp, opts: { say?: (line: string) => void; live?: boolean } = {}): Promise<HistoryResult> {
  const say = opts.say ?? (() => {});
  const live = !!opts.live;
  const spec = loadHistorySpec();
  const recorded = recordedAnswers();
  const byPerson = readPolicy().order_confirmation === "always_person";
  const out: HistoryResult = { orders: [], claims: {}, remittances: [] };

  // 1-3. Orders, shipping, delivery
  for (const o of spec.orders) {
    for (const lot of o.lots ?? []) {
      recordEvent(erp, "batch_finished", { batch: lot.batch, gtin: gtinOf(erp, lot.item), qty: lot.qty, note: `${lot.note} (order history)` });
    }
    const file = `ORDERS_${o.ref}.edi`;
    const r = await receiveOrder(erp, read(file), { sourceName: `history/${file}`, caller: live ? null : orderCaller(recorded, o.ref) });
    const expect = o.expect ?? "clean";
    if (expect === "clean") {
      if (r.step === "confirm" && byPerson) {
        ingestConfirmedOrder(erp, confirmOrder(erp, r.case_id, { by: "Giulia, order desk", reason: "Stock and contract price check out" }));
      } else if (r.step !== "auto_confirmed") {
        throw new Error(`${file}: expected a clean order, got step ${r.step} (${r.case_id})`);
      }
    } else if (r.step !== expect && !live) {
      throw new Error(`${file}: expected step ${expect}, got ${r.step} (${r.case_id})`);
    }
    out.orders.push(o.ref);
    if (!o.ship) {
      say(`${o.ref}: waits for a person (${r.step.replace(/_/g, " ")}, ${r.case_id})`);
      continue;
    }

    const order = erp.order(o.ref)!;
    const destination = erp.retailer(order.buyerGln)?.deliveryPoint ?? null;
    wh.registerTrucks(erp, [
      { truck_id: o.ship.truck, plate: o.ship.plate, destination, pallet_capacity: 33, max_payload_kg: 24000, window: [o.ship.date, o.ship.date] },
    ]);
    const plan = wh.planTruckLoads(erp, [o.ref], { onlyTruckId: o.ship.truck });
    if (!plan.planned.length) throw new Error(`${o.ref}: no truck (${plan.exceptions.map((e) => e.explanation).join("; ")})`);
    if (o.ship.planned_only) {
      say(`${o.ref}: confirmed, on ${o.ship.truck} for ${o.ship.date} (${plan.planned[0].manifest_id})`);
      continue;
    }
    const picks = wh.createPickingList(erp, o.ref);
    const scans = wh.verifyScans(
      erp,
      o.ref,
      picks.map((p) => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: o.ship!.truck })),
    );
    if (scans.exceptions.length) throw new Error(`${o.ref}: scans flagged ${scans.exceptions.map((e) => e.explanation).join("; ")}`);
    wh.confirmLoading(erp, o.ref);
    const sent = wh.authorizeDispatch(erp, o.ref, { shipDate: o.ship.date });
    if (!sent.dispatched || sent.short?.length) throw new Error(`${o.ref}: not dispatched in full (${(sent.short ?? []).join("; ")})`);
    const inv = invoiceShipment(erp, sent.desadv_ref!, { invoiceDate: o.ship.date });
    const rec = await reconcileAndSend(erp, o.ref);
    if (rec.status !== "sent") throw new Error(`${o.ref}: invoice held (${rec.case_id})`);
    if (o.deliver) {
      const received = o.deliver.received
        ? Object.fromEntries(Object.entries(o.deliver.received).map(([item, q]) => [gtinOf(erp, item), q]))
        : null;
      recordDelivery(erp, sent.desadv_ref!, { signedBy: o.deliver.signed_by, received, note: o.deliver.note ?? null, when: o.deliver.date });
    }
    say(`${o.ref}: ${picks.length} pallets on ${o.ship.truck} ${o.ship.date}, invoice ${inv.invoice_ref} €${eur(inv.total)}${o.deliver ? `, delivered ${o.deliver.date}` : ", on the road"}`);
  }

  // 4. Claims
  const answers = (recorded.claims ?? {}) as Record<string, { read_claim: Obj; verdict: Obj }>;
  const credits = new Map<string, { number: string; amount: number }>();
  for (const c of spec.claims) {
    const vars = claimVars(erp, spec, c);
    const text = fillText(read(c.file), vars);
    const rec = answers[c.key];
    if (!rec && !live) throw new Error(`no recorded Grok answer for claim ${c.key}`);
    const result = await handleClaim(erp, text, {
      sourceName: `history/${c.file}`,
      readCaller: live ? null : () => fillJson(rec.read_claim, vars),
      verdictCaller: live ? null : () => fillJson(rec.verdict, vars),
      issueDate: c.date,
    });
    const status = result.status === "closed" ? "closed" : "awaiting_person";
    if (!live && status !== c.expect) throw new Error(`claim ${c.key}: expected ${c.expect}, got ${status}`);
    if (result.status === "closed" && result.outcome.kind === "credit_note") {
      credits.set(c.key, { number: result.outcome.credit_note_number!, amount: result.outcome.amount! });
    }
    out.claims[c.key] = result.claim_id;
    say(
      `Claim ${result.claim_id} on ${c.order}: ${result.status === "closed" ? `${result.outcome.kind.replace(/_/g, " ")}${result.outcome.credit_note_number ? ` ${result.outcome.credit_note_number}` : ""}, no person` : `waits for a person (${result.case_id})`}`,
    );
  }

  // 5. Remittances
  const deductions = (recorded.deductions ?? {}) as Record<string, Obj>;
  for (const r of spec.remittances) {
    const { text, vars } = remadvText(erp, r, credits);
    const verdict = r.verdict ? deductions[r.verdict] : null;
    const paid = await applyRemittance(erp, text, {
      sourceName: `REMADV ${r.ref} (demo: the retailer's remittance, amounts from the Mini ERP invoices)`,
      verdictCaller: live || !verdict ? null : () => fillJson(verdict, vars),
    });
    out.remittances.push(paid.paymentId);
    for (const l of paid.lines) {
      const ded = l.deductions.map((d) => (d.creditRef ? `€${eur(d.amount)} matched to ${d.creditRef}` : `€${eur(d.amount)} to claim ${d.claimId} (${d.status})`));
      say(`Remittance ${r.ref}: €${eur(l.paid)} on ${l.invoiceRef}${ded.length ? `, ${ded.join(", ")}` : ""}`);
    }
  }
  return out;
}
