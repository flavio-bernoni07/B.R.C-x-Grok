/**
 * What the Order row does after a person decides a sign-off (PORTING.md "Sign-off decisions").
 *
 *   confirm      approve -> confirmOrder: ORDRSP written, hand-over for Shipping returned
 *                reject  -> rejectOrder: order status "rejected"
 *   price_fix,   approve -> resolvePriceCase: with `edits.manual_edi` (the EDI text) the order
 *   manual_edi              goes back to Parse; without it the order is parked as "pending"
 *                           (DECISIONS.md: a separate human step, never the confirm sign-off)
 *                reject  -> rejectOrder
 *   qty_choice   approve -> resolveQtyCase: `edits.qty_action` = "split" (re-enter checks with
 *                           available qty → confirm → ORDRSP for that qty) or "mail" (park, no
 *                           ORDRSP). Reject records the decision only.
 *   stock_short  the decision is recorded; nothing else runs (no qty available to ship)
 *
 * No agent tool calls this; the sign-off card in the UI does, through the generic route.
 */
import type { Erp } from "../core/erp";
import { decide } from "../core/signoff";
import { confirmOrder, rejectOrder, resolvePriceCase, resolveQtyCase } from "./service";

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

  if (c.kind === "qty_choice") {
    if (!d.approve) {
      rejectOrder(erp, caseId, d);
      return { ...base, status: "rejected" };
    }
    const action = d.edits?.qty_action === "mail" ? "mail" : "split";
    const result = await resolveQtyCase(erp, caseId, { by: d.by, reason: d.reason, action });
    return { ...base, status: result.status, qty_action: action, result };
  }

  const decided = decide(erp, caseId, d);
  return { ...base, status: decided.status };
}
