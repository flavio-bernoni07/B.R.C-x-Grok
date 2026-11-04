/**
 * Paddy purchase proposals: open a sign-off case, and what happens after a person decides.
 * Approve or reject only records the decision with its reason. Nothing is ever bought by the app:
 * the buyer places the order with the farmers outside it.
 */
import type { Erp } from "../core/erp";
import { decide, requestSignoff } from "../core/signoff";
import type { PaddyPlan, PaddyRow } from "./paddy";

/** Open (or return the open) `purchase` case for one variety. Safe to call twice. */
export function proposePurchase(erp: Erp, plan: PaddyPlan, variety: string): { case_id: string; created: boolean; row: PaddyRow } {
  const row = plan.rows.find((r) => r.variety === variety);
  if (!row) throw new Error(`There is no paddy plan for ${variety}.`);
  if (row.call === "NOTHING TO BUY" || row.suggested_t <= 0) throw new Error(`Nothing to buy for ${variety} right now, so there is nothing to propose.`);
  const subjectRef = `PADDY-${variety.toUpperCase()}-${plan.as_of}`;
  const open = erp.signoffs({ status: "pending", row: "purchasing" }).find((s) => s.subjectRef === subjectRef);
  if (open) return { case_id: open.caseId, created: false, row };
  const spend = row.spend_eur == null ? "spend not estimated" : `about €${row.spend_eur.toLocaleString("en-GB")}`;
  const caseId = requestSignoff(erp, {
    row: "purchasing",
    kind: "purchase",
    subjectRef,
    title: `Buy ${row.suggested_t} t of ${variety} paddy from farmers (${row.call}, ${spend})`,
    proposal: { ...row, steps: row.steps, horizon_weeks: plan.horizon_weeks, demo: plan.demo, assumptions: plan.assumptions },
    reasons: [
      "A person signs every paddy purchase.",
      ...(row.confidence === "low" ? ["The price model does not beat 'price stays the same', so the call has low confidence."] : []),
      ...(plan.demo ? ["Silo and contracted tonnes are demo data."] : []),
    ],
  });
  erp.log("code", "purchasing.proposed", subjectRef, { sourceDoc: caseId, detail: { variety, suggested_t: row.suggested_t, spend_eur: row.spend_eur, call: row.call } });
  return { case_id: caseId, created: true, row };
}

export async function decideSignoff(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  const so = erp.signoff(caseId);
  if (!so) throw new Error(`no sign-off ${caseId}`);
  if (so.row !== "purchasing") throw new Error(`${caseId} is a ${so.row} sign-off, not purchasing`);
  const done = decide(erp, caseId, d);
  erp.log(`person:${d.by.trim()}`, `purchasing.${d.approve ? "approved" : "rejected"}`, so.subjectRef, {
    sourceDoc: caseId,
    detail: { reason: d.reason.trim(), bought: false },
  });
  return {
    status: done.status,
    done: d.approve
      ? "Purchase proposal approved and recorded. Nothing was bought by the app: the buyer places the order with the farmers."
      : "Purchase proposal rejected and recorded. Nothing was bought.",
  };
}
