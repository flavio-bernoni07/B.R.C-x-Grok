/**
 * What the Dispute row runs after a person decides a sign-off (PORTING.md "Sign-off decisions").
 * Approve: the verdict's outcome (TD04 + INVOIC 381, or the evidence reply) is written and the
 * case is added to the Playbook's past cases. Reject: nothing is sent, the claim is reopened and
 * the overturn is added to the Playbook (dispute/service.py approve_verdict / reject_verdict).
 *
 * Legacy portal cases (`kind: customer_dispute`) never auto-issue money: they update portal status
 * only. New phone/chat intake uses `kind: verdict` and the normal approve/reject outcome path.
 */
import type { Erp } from "../core/erp";
import { decideCustomerDispute } from "./portal";
import { approveVerdict, rejectVerdict } from "./service";

export async function decideSignoff(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  const c = erp.signoff(caseId);
  if (c?.kind === "customer_dispute") return decideCustomerDispute(erp, caseId, d);
  if (d.approve) return approveVerdict(erp, caseId, { by: d.by, reason: d.reason, edits: d.edits ?? null });
  return rejectVerdict(erp, caseId, { by: d.by, reason: d.reason, edits: d.edits ?? null });
}
