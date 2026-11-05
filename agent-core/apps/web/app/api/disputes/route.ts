import { getReadyErp } from "@agent/lib/db/app";
import { backfillPortalVerdicts } from "@agent/lib/dispute/portal";
import { callersFor, demoClaims, handleClaim } from "@agent/lib/dispute/service";
import { claimDetail, listClaims } from "@agent/lib/dispute/views";

/** GET /api/disputes: every claim (same function as the dispute_list tool) and the demo claim emails. */
export async function GET() {
  const erp = await getReadyErp();
  // Phone/chat claims saved before the normal pipeline had no verdict → "–" in the table.
  await backfillPortalVerdicts(erp);
  return Response.json({ claims: listClaims(erp), samples: demoClaims() });
}

/**
 * POST /api/disputes { text, source_name? }: run the Dispute row on a claim email (same function as
 * the dispute_handle_claim tool). Opens a sign-off when the case is ambiguous; never approves one.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; source_name?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return Response.json({ error: "Paste the claim email text" }, { status: 400 });
  const erp = await getReadyErp();
  try {
    const { readCaller, verdictCaller, mode } = callersFor(text);
    const result = await handleClaim(erp, text, {
      readCaller,
      verdictCaller,
      sourceName: typeof body.source_name === "string" && body.source_name ? body.source_name : "claim email (web)",
    });
    return Response.json({ mode, result, claim: claimDetail(erp, result.claim_id) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 422 });
  }
}
