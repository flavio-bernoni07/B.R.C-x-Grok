/**
 * What code and Grok caught on one order (README case study), as short cards: the problem, what it
 * blocks, Grok's suggestion and the choices a person has. Read-only; the choice is posted to
 * /api/shipping/cases/[caseId]/choose. Every figure comes from a Mini ERP row: exception cases and
 * their pallets, the next planned run, remittance deductions, claims and the audit log.
 */
import { nextRun } from "../demo/case-study";
import type { Erp } from "../core/erp";
import * as cases from "../shipping/cases";
import * as wh from "../shipping/warehouse";

export type CaughtOption = { action: string; label: string; grok: boolean; params?: Record<string, unknown> | null };

export type Caught = {
  /** The case or deduction id. */
  key: string;
  /** The exception case a choice is posted to; null for a deduction. */
  caseId: string | null;
  problem: string;
  /** What waits until a person decides, e.g. the truck. */
  alert: string | null;
  atStake: number;
  /** Grok's suggestion in a few words. */
  grok: string | null;
  /** Empty once decided. Grok's own suggestion comes first. */
  options: CaughtOption[];
  /** The role that decides, sent as `by` with the choice. */
  role: string;
  done: boolean;
  /** What happened, once decided. */
  outcome: string | null;
  /** The full case (sign-off page or claim). */
  href: string | null;
};

const money = (v: number) => `€${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const shortPallet = (id: string | null) => (id ? `Pallet ${id.split("-").at(-1)}` : "A pallet");
const dayMonth = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const roleText = (role: string) => role.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());

export function caughtProblems(erp: Erp, orderRef: string): Caught[] {
  const order = erp.order(orderRef);
  if (!order) return [];
  const retailer = erp.retailer(order.buyerGln)?.name ?? "The retailer";
  const priceOf = (gtin: string | null | undefined) => order.lines.find((l) => l.gtin === gtin)?.unitPrice ?? order.lines[0]?.unitPrice ?? 0;
  const pending = erp.signoffs({ status: "pending" });
  const out: Caught[] = [];

  let exceptionCases: cases.ExceptionCase[] = [];
  try {
    exceptionCases = cases.exceptionCases(erp, orderRef);
  } catch {
    // the shipping tables exist only once a truck was planned
  }
  const plannedTruck = wh.manifestForOrder(erp, orderRef)?.truck_id ?? (typeof order.notes?.truck_id === "string" ? order.notes.truck_id : null);
  const loss = new Map(
    erp
      .auditLog(orderRef)
      .filter((a) => a.action === "shipping.loss_booked")
      .map((a) => [a.sourceDoc ?? "", Number((a.detail as { eur?: number } | null)?.eur ?? 0)]),
  );

  for (const c of exceptionCases) {
    const done = c.status === "executed";
    const waiting = pending.find((s) => s.subjectRef === c.case_id);
    const prop = waiting ? cases.proposal(erp, String((waiting.proposal ?? {}).proposal_id ?? "")) : undefined;
    const groks = new Set(prop && prop.by.startsWith("grok") ? prop.actions.map((a) => a.action) : []);
    const chosen = c.possible_actions.find((a) => a.selected)?.action ?? null;
    const href = waiting ? `/signoff?case=${encodeURIComponent(waiting.caseId)}` : `/signoff?case=${encodeURIComponent(c.case_id)}`;
    const base = { key: c.case_id, caseId: c.case_id, role: roleText(c.role), done, href };

    if (c.type === "WRONG_TRUCK") {
      const p = wh.pallet(erp, c.pallet_id);
      const eur = p ? Math.round(p.qty * priceOf(p.gtin) * 100) / 100 : (c.financial_impact_eur ?? 0);
      const options: CaughtOption[] = [
        { action: "RESCAN_PALLET", label: "Fix now, truck waits", grok: groks.has("RESCAN_PALLET") },
        { action: "SHIP_WITHOUT_PALLET", label: `Let it go, book ${money(eur)} loss`, grok: groks.has("SHIP_WITHOUT_PALLET") },
      ].filter((o) => c.possible_actions.some((a) => a.action === o.action));
      out.push({
        ...base,
        problem: `${shortPallet(c.pallet_id)} on the wrong truck`,
        alert: done ? null : `${plannedTruck ?? "The truck"} stopped until you decide`,
        atStake: eur,
        grok: groks.has("RESCAN_PALLET") ? `Scan it onto ${plannedTruck ?? "the planned truck"}` : groks.size ? "Ship without it" : null,
        options: done ? [] : options.sort((a, b) => Number(b.grok) - Number(a.grok)),
        outcome: !done ? null : chosen === "SHIP_WITHOUT_PALLET" ? `Truck left without it, ${money(loss.get(c.case_id) ?? eur)} loss booked` : "Fixed, truck released",
      });
    } else if (c.type === "SHORT_SHIPMENT") {
      const ev = (c.evidence ?? {}) as { gtin?: string; owed?: number };
      const owed = Number(ev.owed ?? 0);
      const next = ev.gtin ? nextRun(erp, ev.gtin, orderRef) : null;
      const options: CaughtOption[] = [
        { action: "CONFIRM_SHORT_SHIPMENT", label: `Tell ${retailer}`, grok: groks.has("CONFIRM_SHORT_SHIPMENT") },
        ...(next ? [{ action: "BACKORDER", label: `Send on ${dayMonth(next.date)}`, grok: groks.has("BACKORDER"), params: { date: next.date } }] : []),
      ];
      out.push({
        ...base,
        problem: c.explanation.replace(/^./, (x) => x.toUpperCase()).replace(/, not on the truck$/, ""),
        alert: done ? null : `${retailer} expects ${n(owed)} more`,
        atStake: c.financial_impact_eur ?? 0,
        grok: groks.has("BACKORDER") && next ? `Send them on ${dayMonth(next.date)}` : groks.has("CONFIRM_SHORT_SHIPMENT") ? `Tell ${retailer} they won't come${next && next.free < owed ? `: the ${dayMonth(next.date)} run is promised` : ""}` : null,
        options: done ? [] : options.sort((a, b) => Number(b.grok) - Number(a.grok)),
        outcome: !done ? null : chosen === "BACKORDER" ? `Backorder${next ? ` for ${dayMonth(next.date)}` : ""}` : `${retailer} told, ${n(owed)} cancelled`,
      });
    } else {
      out.push({
        ...base,
        problem: c.explanation.replace(/^./, (x) => x.toUpperCase()),
        alert: null,
        atStake: c.financial_impact_eur ?? 0,
        grok: null,
        options: [],
        outcome: done ? "Resolved" : null,
      });
    }
  }

  // Deductions on a remittance that no credit note of ours explains.
  const invoiceRefs = erp.invoices(orderRef).map((i) => i.invoiceRef);
  let deductions: { deduction_id: string; amount: number; note: string | null; status: string; claim_id: string | null }[] = [];
  if (invoiceRefs.length) {
    try {
      deductions = erp.sqlite
        .prepare(`SELECT deduction_id, amount, note, status, claim_id FROM deductions WHERE status != 'matched_credit' AND invoice_ref IN (${invoiceRefs.map(() => "?").join(",")}) ORDER BY deduction_id`)
        .all(...invoiceRefs) as typeof deductions;
    } catch {
      // finance tables exist once a remittance was recorded
    }
  }
  for (const d of deductions) {
    const waiting = d.claim_id ? pending.find((s) => s.subjectRef === d.claim_id) : undefined;
    out.push({
      key: d.deduction_id,
      caseId: null,
      problem: `${money(d.amount)} deducted${d.note ? `: "${d.note}"` : ""}`,
      alert: null,
      atStake: d.amount,
      grok: d.status === "claim_opened" ? "No clause in the contract: ask it back" : null,
      options: [],
      role: "Credit desk",
      done: d.status !== "claim_opened",
      outcome: d.status === "disputed" ? `Asked ${retailer} to repay` : d.status === "accepted" ? "Accepted" : null,
      href: waiting ? `/signoff?case=${encodeURIComponent(waiting.caseId)}` : d.claim_id ? `/disputes?claim=${encodeURIComponent(d.claim_id)}` : null,
    });
  }
  return out;
}
