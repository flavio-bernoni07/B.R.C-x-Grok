/**
 * DELETE rehearsal Phone DSP-… claims from Disputes (keeps email CLM-… rows).
 * POST with empty body. Used by `pnpm phone:clear` and after phone:demo smoke.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { clearPhoneClaims } from "@agent/lib/dispute/clear_phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const erp = await getReadyErp();
  const result = clearPhoneClaims(erp);
  return Response.json({ ok: true, ...result });
}
