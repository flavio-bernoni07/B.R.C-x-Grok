/**
 * What the Shipping row does after a person decides a sign-off in the UI (PORTING.md).
 *
 * - `exception_case` (a validated resolution proposal): the person is the employee in the
 *   case's role. Approve runs what the Python row runs after approval: `decide_resolution`
 *   (which also records the sign-off), then `execute_resolution` once, then
 *   `recheck_exception_case`. Reject sends the case back to `open`.
 * - `reconcile` (an invoice held because the documents disagree): Python records the decision
 *   only and has no follow-up step. The port adds the two options the proposal offers:
 *   approve = "send as is" (draft invoices go out, the order becomes invoiced);
 *   reject = "correct the invoice and reconcile again" (the invoices stay draft, not sent; a new
 *   reconcileAndSend after the correction sends them).
 *
 * No agent tool calls this: the sign-off card posts to the API.
 */
import type { Erp } from "../core/erp";
import { decide } from "../core/signoff";
import { recordEvent } from "../core/stock";
import { decideResolution, executeResolution, recheckExceptionCase, viewExceptionCase } from "./cases";
import { applyDispatchPlan } from "./routes";

export async function decideSignoff(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  const so = erp.signoff(caseId);
  if (!so) throw new Error(`no sign-off ${caseId}`);
  if (so.row !== "shipping") throw new Error(`${caseId} is a ${so.row} sign-off, not shipping`);

  if (so.kind === "exception_case") {
    const exceptionCaseId = String((so.proposal ?? {}).exception_case ?? so.subjectRef);
    const c = viewExceptionCase(erp, exceptionCaseId);
    if (!c) throw new Error(`no exception case ${exceptionCaseId}`);
    // The person deciding in the UI acts in the case's role (the card is addressed to that role).
    const role = typeof d.edits?.role === "string" ? d.edits.role : c.role;
    const decided = decideResolution(erp, exceptionCaseId, {
      employeeId: d.by,
      role,
      decision: d.approve ? "approve" : "reject",
      reason: d.reason,
    });
    if (!d.approve) return { row: "shipping", kind: so.kind, case_id: caseId, exception_case: exceptionCaseId, status: decided.status };
    const execution = executeResolution(erp, exceptionCaseId);
    const recheck = recheckExceptionCase(erp, exceptionCaseId);
    return {
      row: "shipping",
      kind: so.kind,
      case_id: caseId,
      exception_case: exceptionCaseId,
      status: "executed",
      execution,
      resolution: recheck.resolution,
    };
  }

  if (so.kind === "reconcile") {
    const orderRef = so.subjectRef ?? "";
    const invoiceRefs = ((so.proposal ?? {}).invoices as string[] | undefined) ?? [];
    decide(erp, caseId, { approve: d.approve, by: d.by, reason: d.reason, edits: d.edits ?? null });
    const actor = `person:${d.by.trim()}`;
    if (d.approve) {
      for (const ref of invoiceRefs) {
        const inv = erp.invoice(ref);
        if (!inv || inv.status !== "draft") continue;
        erp.setInvoiceStatus(ref, "sent");
        erp.log(actor, "shipping.invoice_sent", orderRef, {
          sourceDoc: inv.sourceDoc,
          detail: { to: ["retailer (EDI INVOIC)", "SdI (FatturaPA)"], simulated: true, signoff: caseId },
        });
      }
      if (erp.order(orderRef)) erp.setOrder(orderRef, { status: "invoiced" });
      return { row: "shipping", kind: so.kind, case_id: caseId, order_ref: orderRef, status: "sent", invoices: invoiceRefs };
    }
    erp.log(actor, "shipping.invoice_held", orderRef, { sourceDoc: caseId, detail: { invoices: invoiceRefs, next: "correct the invoice and reconcile again" } });
    return { row: "shipping", kind: so.kind, case_id: caseId, order_ref: orderRef, status: "held", invoices: invoiceRefs };
  }

  if (so.kind === "dispatch_plan") {
    // The transport planner approves the route agent's plan: only then are trucks booked.
    const decided = decide(erp, caseId, { approve: d.approve, by: d.by, reason: d.reason, edits: d.edits ?? null });
    if (!d.approve) return { row: "shipping", kind: so.kind, case_id: caseId, status: decided.status };
    const booked = applyDispatchPlan(erp, caseId, d.by.trim());
    return { row: "shipping", kind: so.kind, case_id: caseId, status: "planned", ...booked };
  }

  if (so.kind === "compliance_docs") {
    // Quality / import papers: approve releases the held batch; reject leaves it on hold.
    const decided = decide(erp, caseId, { approve: d.approve, by: d.by, reason: d.reason, edits: d.edits ?? null });
    const batch = String((so.proposal ?? {}).batch ?? so.subjectRef ?? "");
    if (d.approve && batch) {
      recordEvent(erp, "hold_released", { batch, note: `compliance papers accepted: ${d.reason.trim()}` });
      return { row: "shipping", kind: so.kind, case_id: caseId, batch, status: "released" };
    }
    return { row: "shipping", kind: so.kind, case_id: caseId, batch, status: decided.status };
  }

  // Any other shipping sign-off: record the decision only.
  const decided = decide(erp, caseId, d);
  return { row: "shipping", kind: so.kind, case_id: caseId, status: decided.status };
}
