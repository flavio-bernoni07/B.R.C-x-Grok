/** Customer status lookup for one of their disputes. */
import { getReadyErp } from "@agent/lib/db/app";
import { claimToPortalRecord, DEMO_RETAILER_GLN, simulatedSession } from "@agent/lib/dispute/portal";
import { cookies } from "next/headers";
import { COOKIE } from "../../session/route";

export async function GET(_request: Request, { params }: { params: Promise<{ disputeId: string }> }) {
  const { disputeId } = await params;
  const erp = await getReadyErp();
  const jar = await cookies();
  const gln = jar.get(COOKIE)?.value || DEMO_RETAILER_GLN;
  try {
    const session = simulatedSession(erp, gln);
    const rec = claimToPortalRecord(erp, disputeId);
    if (!rec || rec.retailer_id !== session.retailer_id) {
      return Response.json({ error: "Dispute not found for this retailer session" }, { status: 404 });
    }
    return Response.json({ session, dispute: rec });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 401 });
  }
}
