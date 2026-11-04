/**
 * POST /api/signoffs/send-off-all: release every pending confirm (Send-off) case in one batch.
 * Uses the prior stock check so later cases are not blocked by ATP committed by earlier ones.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { sendOffConfirmBatch } from "@agent/lib/order/service";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { by?: string; reason?: string; caseIds?: string[] };
  if (!body.by?.trim()) {
    return Response.json({ error: "Enter your name before Send-off all." }, { status: 400 });
  }
  const erp = await getReadyErp();
  try {
    const batch = sendOffConfirmBatch(erp, {
      by: body.by.trim(),
      reason: body.reason?.trim() || "Send-off all: checks already passed; release ORDRSP batch",
      caseIds: Array.isArray(body.caseIds) ? body.caseIds : undefined,
    });
    return Response.json(batch);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
