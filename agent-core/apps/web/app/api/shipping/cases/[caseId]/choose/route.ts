import { getReadyErp } from "@agent/lib/db/app";
import { chooseResolution } from "@agent/lib/shipping/choose";
import { viewExceptionCase } from "@agent/lib/shipping/cases";

/**
 * A person picks one option of an exception case from the order panel (Grok's suggestion or another
 * allowed action). Code checks the action and the sign-off records who chose it and why.
 */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: string; params?: Record<string, unknown>; by?: string; reason?: string };
  if (!body.action) return Response.json({ error: "action is required" }, { status: 400 });
  if (!body.by?.trim()) return Response.json({ error: "Say who decides" }, { status: 400 });
  const erp = await getReadyErp();
  if (!viewExceptionCase(erp, caseId)) return Response.json({ error: `No exception case ${caseId}` }, { status: 404 });
  try {
    const result = await chooseResolution(erp, caseId, { action: body.action, params: body.params ?? null, by: body.by, reason: body.reason ?? null });
    return Response.json({ result, case: viewExceptionCase(erp, caseId) });
  } catch (err) {
    return Response.json({ error: (err as Error).message, case: viewExceptionCase(erp, caseId) }, { status: 422 });
  }
}
