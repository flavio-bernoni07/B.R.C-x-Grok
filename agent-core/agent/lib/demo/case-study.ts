/**
 * The README case study, left open in the app (demo data, data/world/golden). With `caseStudy`,
 * runGolden stops ESS-GOLD-001 at the truck: one pallet was scanned onto the wrong truck and the
 * truck waits for a person. This file adds the rest:
 *
 * 1. `openShortShipment`: the packs the order still owes (confirmed minus picked, or minus shipped
 *    after dispatch) open a short-shipment case; Grok's proposal is checked against the next
 *    planned run and what other orders were already promised from it.
 * 2. `applyRemittance`: a retailer's REMADV. A deduction that equals one of our credit notes closes
 *    with no person; any other one becomes a Dispute claim (used by the history seed).
 *
 * Port of finance/receivables.py for the remittance: same tables, same rules.
 */
import type { Erp } from "../core/erp";
import { nowIso } from "../core/erp";
import { batches } from "../core/stock";
import type { Caller } from "../grok/client";
import { handleClaim } from "../dispute/service";
import * as cases from "../shipping/cases";
import * as wh from "../shipping/warehouse";

export const CASE_STUDY_ORDER = "ESS-GOLD-001";
const EPS = 0.01;
const round2 = (v: number) => Math.round(v * 100) / 100;
const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Same tables as finance/receivables.py; core/trace.ts reads them. */
const FINANCE_DDL = `
CREATE TABLE IF NOT EXISTS payments (payment_id TEXT PRIMARY KEY, remittance_ref TEXT, payer_gln TEXT,
    value_date TEXT, total REAL, source_doc TEXT);
CREATE TABLE IF NOT EXISTS payment_lines (payment_id TEXT NOT NULL, invoice_ref TEXT NOT NULL, amount_due REAL,
    amount_paid REAL NOT NULL);
CREATE TABLE IF NOT EXISTS deductions (deduction_id TEXT PRIMARY KEY, payment_id TEXT, invoice_ref TEXT NOT NULL,
    amount REAL NOT NULL, reason_code TEXT, note TEXT, status TEXT NOT NULL, credit_ref TEXT, claim_id TEXT,
    created_at TEXT);
`;

/** Demo adjustment codes -> Dispute claim types; anything else (PC, a promo contribution) is "other". */
const CLAIM_TYPE_BY_CODE: Record<string, string> = { PR: "pricing", SH: "shortage", DM: "damage", LT: "late_delivery" };

type Adjustment = { code: string; amount: number | null; note: string };
type RemittanceDoc = { invoiceRef: string; due: number | null; paid: number | null; adjustments: Adjustment[] };
export type Remittance = { ref: string | null; valueDate: string | null; payer: string | null; total: number | null; docs: RemittanceDoc[] };

/** BGM (number), DTM+209 (value date), NAD+PR (payer), MOA+9 (paid); per invoice DOC+380, MOA+12 due,
 *  MOA+9 paid, then AJT (adjustment) + MOA+5 + FTX. */
export function parseRemadv(text: string): Remittance {
  const out: Remittance = { ref: null, valueDate: null, payer: null, total: null, docs: [] };
  let doc: RemittanceDoc | null = null;
  let adj: Adjustment | null = null;
  for (const raw of text.replace(/\n/g, "").split("'")) {
    const seg = raw.trim();
    if (!seg) continue;
    const parts = seg.split("+");
    const tag = parts[0];
    if (tag === "BGM" && parts.length > 2) out.ref = parts[2];
    else if (tag === "DTM" && parts.length > 1 && ["209", "137"].includes(parts[1].split(":")[0])) {
      const d = parts[1].split(":")[1];
      const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      if (parts[1].startsWith("209") || !out.valueDate) out.valueDate = iso;
    } else if (tag === "NAD" && parts.length > 2 && parts[1] === "PR") out.payer = parts[2].split(":")[0];
    else if (tag === "DOC" && parts.length > 2) {
      doc = { invoiceRef: parts[2], due: null, paid: null, adjustments: [] };
      adj = null;
      out.docs.push(doc);
    } else if (tag === "AJT" && doc && parts.length > 1) {
      adj = { code: parts[1], amount: null, note: "" };
      doc.adjustments.push(adj);
    } else if (tag === "FTX" && adj) adj.note = `${adj.note} ${parts.at(-1)!.replace(/:/g, " ")}`.trim();
    else if (tag === "MOA" && parts.length > 1) {
      const [qual, value] = parts[1].split(":");
      const amount = Number.parseFloat(value);
      if (adj && qual === "5") adj.amount = amount;
      else if (doc && qual === "12") doc.due = amount;
      else if (doc && qual === "9") doc.paid = amount;
      else if (!doc && qual === "9") out.total = amount;
    }
  }
  if (!out.ref || !out.docs.length) throw new Error("REMADV without a number or documents");
  for (const d of out.docs) if (d.paid == null) throw new Error(`REMADV ${out.ref}: no paid amount for ${d.invoiceRef}`);
  return out;
}

/** Credit notes we already wrote against this invoice (accepted or partial disputes). */
function issuedCredits(erp: Erp, invoiceRef: string) {
  return erp
    .claims()
    .filter((c) => c.invoiceRef === invoiceRef && c.outcome?.kind === "credit_note")
    .map((c) => ({ claimId: c.claimId, creditRef: String(c.outcome?.credit_note_number ?? ""), amount: Number(c.outcome?.amount ?? 0) }));
}

export type RemittanceResult = {
  paymentId: string;
  remittanceRef: string;
  lines: { invoiceRef: string; paid: number; deductions: { deductionId: string; amount: number; status: string; creditRef?: string; claimId?: string; caseId?: string }[] }[];
};

/** Post a REMADV: the payment, deductions matched to our credit notes, and a Dispute claim for every other one. */
export async function applyRemittance(erp: Erp, text: string, opts: { sourceName?: string; verdictCaller?: Caller | null } = {}): Promise<RemittanceResult> {
  erp.sqlite.exec(FINANCE_DDL);
  const advice = parseRemadv(text);
  const docId = erp.addDocument("REMADV", advice.ref, text, { path: opts.sourceName ?? "REMADV" });
  const paymentId = erp.nextId("payment", "PAY-");
  erp.sqlite
    .prepare("INSERT INTO payments(payment_id, remittance_ref, payer_gln, value_date, total, source_doc) VALUES(?,?,?,?,?,?)")
    .run(paymentId, advice.ref, advice.payer, advice.valueDate, advice.total, docId);
  erp.log("retailer", "finance.remittance_received", advice.ref, { sourceDoc: docId, detail: advice });
  const addDeduction = erp.sqlite.prepare("INSERT INTO deductions VALUES(?,?,?,?,?,?,?,?,?,?)");
  const result: RemittanceResult = { paymentId, remittanceRef: advice.ref!, lines: [] };

  for (const d of advice.docs) {
    const inv = erp.invoice(d.invoiceRef);
    if (!inv) {
      erp.log("code", "finance.unknown_invoice", advice.ref, { sourceDoc: docId, detail: d });
      continue;
    }
    erp.sqlite.prepare("INSERT INTO payment_lines(payment_id, invoice_ref, amount_due, amount_paid) VALUES(?,?,?,?)").run(paymentId, inv.invoiceRef, d.due, d.paid);
    erp.log("retailer", "finance.payment_posted", inv.orderRef, { sourceDoc: docId, detail: { invoice: inv.invoiceRef, paid: d.paid } });
    const short = round2((d.due ?? inv.total ?? 0) - (d.paid ?? 0));
    const adjustments = [...d.adjustments];
    const explained = round2(adjustments.reduce((a, x) => a + (x.amount ?? 0), 0));
    if (short - explained > EPS) adjustments.push({ code: "UNEXPLAINED", amount: round2(short - explained), note: "short payment with no reason given" });
    const credits = issuedCredits(erp, inv.invoiceRef);
    const line: RemittanceResult["lines"][number] = { invoiceRef: inv.invoiceRef, paid: d.paid ?? 0, deductions: [] };

    for (const a of adjustments) {
      if (!a.amount) continue;
      const dedId = erp.nextId("deduction", "DED-");
      const amount = a.amount;
      const match = credits.find((c) => Math.abs(c.amount - amount) <= EPS);
      if (match) {
        credits.splice(credits.indexOf(match), 1);
        addDeduction.run(dedId, paymentId, inv.invoiceRef, a.amount, a.code, a.note, "matched_credit", match.creditRef, match.claimId, nowIso());
        erp.log("code", "finance.credit_matched", inv.orderRef, { sourceDoc: docId, detail: { deduction: dedId, credit_note: match.creditRef, amount: a.amount } });
        line.deductions.push({ deductionId: dedId, amount: a.amount, status: "matched_credit", creditRef: match.creditRef });
        continue;
      }
      // No credit note behind it: code writes the claim from the remittance (nothing to read), Grok decides.
      const extraction = {
        order_ref: inv.orderRef,
        invoice_ref: inv.invoiceRef,
        product: null,
        quantity: null,
        amount: a.amount,
        claim_type: CLAIM_TYPE_BY_CODE[a.code] ?? "other",
        confidence: 1,
        raw_notes: `Deduction ${a.code} on payment advice ${advice.ref}: ${a.note}`,
      };
      // Worded as a payment advice: the claim reader upgrades "other" to "pricing" on remittance + € text
      // (for portal claims with no type), but here the type comes from the AJT code, not from reading.
      const claim = await handleClaim(
        erp,
        `Payment advice (REMADV) ${advice.ref} deducts ${a.amount.toFixed(2)} from invoice ${inv.invoiceRef} (order ${inv.orderRef}). Reason given: ${a.code} ${a.note}`,
        { sourceName: `REMADV ${advice.ref}`, readCaller: () => ({ ...extraction }), verdictCaller: opts.verdictCaller, issueDate: advice.valueDate },
      );
      const decided = claim.status === "closed";
      const accepted = decided && ["accept", "partial"].includes(String((claim.verdict as Record<string, unknown>).decision));
      const status = !decided ? "claim_opened" : accepted ? "accepted" : "disputed";
      addDeduction.run(dedId, paymentId, inv.invoiceRef, a.amount, a.code, a.note, status, null, claim.claim_id, nowIso());
      erp.log("code", "finance.deduction_to_dispute", inv.orderRef, { sourceDoc: docId, detail: { deduction: dedId, claim: claim.claim_id, amount: a.amount } });
      line.deductions.push({ deductionId: dedId, amount: a.amount, status, claimId: claim.claim_id, caseId: "case_id" in claim ? claim.case_id : undefined });
    }
    result.lines.push(line);
  }
  return result;
}

/** Packs the order still owes: confirmed minus shipped, or, before dispatch, minus the pallets picked
 *  for the truck. A gap opens a short-shipment case with Grok's proposal, checked by code. */
export function openShortShipment(erp: Erp, orderRef: string, opts: { by?: string } = {}): string | null {
  const order = erp.order(orderRef);
  if (!order) return null;
  const shipments = erp.shipments(orderRef);
  const dispatched = shipments.length > 0;
  const going = new Map<string, number>();
  if (dispatched) for (const sh of shipments) for (const l of sh.lines) going.set(l.gtin, (going.get(l.gtin) ?? 0) + l.qty);
  else for (const p of wh.pallets(erp, orderRef)) if (p.status !== "excluded" && p.gtin) going.set(p.gtin, (going.get(p.gtin) ?? 0) + p.qty);
  const line = order.lines.find((l) => (l.qtyConfirmed ?? l.qtyOrdered ?? 0) - (going.get(l.gtin ?? "") ?? 0) > 0);
  if (!line?.gtin) return null;
  const confirmed = line.qtyConfirmed ?? line.qtyOrdered ?? 0;
  const sent = going.get(line.gtin) ?? 0;
  const owed = confirmed - sent;
  const eur = round2(owed * (line.unitPrice ?? 0));
  const invoice = erp.invoices(orderRef).at(-1);
  const held = batches(erp, line.gtin, "hold");
  const heldQty = held.reduce((a, b) => a + b.qty, 0);
  const onHold = heldQty >= owed;
  const cause = String(
    order.notes?.fulfilment_gap ?? (held.length ? `${n(heldQty)} packs on quality hold (${held.map((b) => b.batch).join(", ")})` : "not enough released stock"),
  );
  const exc = wh.recordException(erp, {
    type: "SHORT_SHIPMENT",
    severity: "high",
    orderRef,
    explanation: dispatched
      ? `${n(owed)} of ${n(confirmed)} packs never shipped and nobody is sending them`
      : `${n(owed)} packs ${onHold ? "on quality hold" : "short"}, not on the truck`,
    evidence: { gtin: line.gtin, confirmed, going: sent, owed, cause, dispatched, invoice: invoice?.invoiceRef ?? null },
    financialImpactEur: eur,
    invoiceRef: invoice?.invoiceRef ?? null,
  });
  const [caseId] = cases.openExceptionCases(erp, [exc]);

  // What can Grok promise? The next planned run, less what other orders were already promised from it.
  const next = nextRun(erp, line.gtin, orderRef);
  const retailer = erp.retailer(order.buyerGln)?.name ?? "the retailer";
  const proposal =
    next && next.free >= owed
      ? {
          actions: [{ action: "BACKORDER", params: { date: next.date } }],
          rationale: `${cause}. The next run, ${next.batch} (${n(next.qty)} packs on ${next.date}), has ${n(next.free)} free: send the ${n(owed)} then.`,
          confidence: 0.7,
        }
      : {
          actions: [{ action: "CONFIRM_SHORT_SHIPMENT" }],
          rationale:
            `${cause}. ${next ? `The next run, ${next.batch} (${n(next.qty)} packs on ${next.date}), is already promised to other orders (${n(next.qty - next.free)} packs)` : "No run is planned"}. ` +
            `Tell ${retailer} now that ${n(owed)} packs will not come with this order, so they can reorder; the invoice bills only the ${n(sent)} shipped.`,
          confidence: 0.7,
        };
  cases.submitResolutionProposal(erp, caseId, proposal, { by: opts.by ?? "grok (recorded)" });
  return caseId;
}

/** The next planned run of a product and how much of it other orders were not yet promised. */
export function nextRun(erp: Erp, gtin: string, exceptOrder?: string): { batch: string; date: string; qty: number; free: number } | null {
  const next = batches(erp, gtin, "planned")
    .filter((b) => b.availableFrom)
    .sort((a, b) => String(a.availableFrom).localeCompare(String(b.availableFrom)))[0];
  if (!next?.availableFrom) return null;
  const promised = erp
    .orders()
    .filter((o) => o.orderRef !== exceptOrder)
    .flatMap((o) => (Array.isArray(o.notes?.backorders) ? (o.notes!.backorders as { gtin?: string; qty?: number; date?: string }[]) : []))
    .filter((b) => b.gtin === gtin && (b.date ?? "") >= next.availableFrom!)
    .reduce((a, b) => a + (b.qty ?? 0), 0);
  return { batch: next.batch, date: next.availableFrom, qty: next.qty, free: Math.max(next.qty - promised, 0) };
}

/** The case study's open item on ESS-GOLD-001 besides the wrong truck: the packs it still owes. Run
 *  after runGolden's split order, so the next run's promises are known. */
export async function seedCaseStudy(erp: Erp, opts: { say?: (line: string) => void; live?: boolean } = {}): Promise<void> {
  const say = opts.say ?? (() => {});
  const caseId = openShortShipment(erp, CASE_STUDY_ORDER);
  if (caseId) say(`${caseId}: ${cases.viewExceptionCase(erp, caseId)?.explanation}; the account manager decides`);
}
