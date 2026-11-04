import { getReadyErp } from "@agent/lib/db/app";
import { claimDetail } from "@agent/lib/dispute/views";

/** GET /api/disputes/:claimId: one claim in full (same function as the dispute_get tool). */
export async function GET(_req: Request, ctx: { params: Promise<{ claimId: string }> }) {
  const { claimId } = await ctx.params;
  const erp = await getReadyErp();
  const claim = claimDetail(erp, claimId);
  if (!claim) return Response.json({ error: `No claim ${claimId}` }, { status: 404 });
  return Response.json({ claim });
}
