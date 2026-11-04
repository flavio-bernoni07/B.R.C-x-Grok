/**
 * A person decides a sign-off case. The row's own decision path runs after it (order: confirm and
 * ORDRSP or reject; shipping: decide and execute the resolution; dispute: approve or reject the
 * verdict and write the outcome). Only people reach this route, through the sign-off card.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { decideSignoff as decideDispute } from "@agent/lib/dispute/decide";
import { decideSignoff as decideOrder } from "@agent/lib/order/decide";
import { decideSignoff as decidePurchasing } from "@agent/lib/purchasing/decide";
import { decideSignoff as decideShipping } from "@agent/lib/shipping/decide";
import { ingestConfirmedOrder } from "@agent/lib/shipping/service";
import type { ConfirmedOrderHandoff } from "@agent/lib/order/service";

const BY_ROW = { order: decideOrder, shipping: decideShipping, dispute: decideDispute, purchasing: decidePurchasing } as const;

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const body = (await request.json().catch(() => ({}))) as { approve?: boolean; by?: string; reason?: string; edits?: Record<string, unknown> };
  if (typeof body.approve !== "boolean") return Response.json({ error: "approve must be true or false" }, { status: 400 });
  if (!body.by?.trim() || !body.reason?.trim()) {
    return Response.json({ error: "Say who decides and write one line on why: it is what the Playbook learns from." }, { status: 400 });
  }
  const erp = await getReadyErp();
  const c = erp.signoff(caseId);
  if (!c) return Response.json({ error: `No sign-off case ${caseId}` }, { status: 404 });
  const decide = BY_ROW[c.row as keyof typeof BY_ROW];
  if (!decide) return Response.json({ error: `No decision path for row ${c.row}` }, { status: 400 });
  try {
    const result = await decide(erp, caseId, { approve: body.approve, by: body.by, reason: body.reason, edits: body.edits ?? null });
    // Order → Shipping hand-over: a confirmed order goes straight to the Shipping row (order-dec.md).
    const handoff = (result as { handoff?: ConfirmedOrderHandoff }).handoff;
    if (c.row === "order" && handoff) (result as Record<string, unknown>).shipping_ref = ingestConfirmedOrder(erp, handoff);
    return Response.json({ case: erp.signoff(caseId), result });
  } catch (err) {
    return Response.json({ error: (err as Error).message, case: erp.signoff(caseId) }, { status: 422 });
  }
}
