/**
 * What the Order row does after a person decides a sign-off (PORTING.md "Sign-off decisions").
 *
 *   confirm      approve -> confirmOrder: ORDRSP written, hand-over for Shipping returned
 *                reject  -> rejectOrder: order status "rejected"
 *   price_fix,   approve -> resolvePriceCase: with `edits.manual_edi` (the EDI text) the order
 *   manual_edi              goes back to Parse; without it the order is parked as "pending"
 *                           (DECISIONS.md: a separate human step, never the confirm sign-off)
 *                reject  -> rejectOrder
 *   stock_short  the Python row has no action here: the decision is recorded, nothing else runs
 *
 * No agent tool calls this; the sign-off card in the UI does, through the generic route.
 */
import type { Erp } from "../core/erp";
import { decide } from "../core/signoff";
import { confirmOrder, rejectOrder, resolvePriceCase } from "./service";

export async function decideSignoff(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  const c = erp.signoff(caseId);
  if (!c || c.row !== "order") throw new Error(`${caseId} is not an order sign-off`);
  const base = { row: "order", case_id: caseId, kind: c.kind, order_ref: c.subjectRef };

  if (c.kind === "confirm") {
    if (!d.approve) {
      rejectOrder(erp, caseId, d);
      return { ...base, status: "rejected" };
    }
    const handoff = confirmOrder(erp, caseId, d);
    return { ...base, status: "confirmed", ordrsp_ref: handoff.ordrsp_ref, handoff };
  }

  if (c.kind === "price_fix" || c.kind === "manual_edi") {
    if (!d.approve) {
      rejectOrder(erp, caseId, d);
      return { ...base, status: "rejected" };
    }
    const manual = d.edits?.manual_edi;
    const result = await resolvePriceCase(erp, caseId, {
      by: d.by,
      reason: d.reason,
      manualEdi: typeof manual === "string" && manual.trim() ? manual : null,
    });
    return { ...base, status: result.status, result };
  }

  const decided = decide(erp, caseId, d);
  return { ...base, status: decided.status };
}
