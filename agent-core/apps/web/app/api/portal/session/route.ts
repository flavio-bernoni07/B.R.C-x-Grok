/**
 * Simulated retailer session for the hackathon customer portal.
 * Not a production login — the response always carries `simulated: true`.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { DEMO_RETAILER_GLN, simulatedSession } from "@agent/lib/dispute/portal";
import { cookies } from "next/headers";

export const COOKIE = "brc_portal_retailer";

export async function GET() {
  const erp = await getReadyErp();
  const jar = await cookies();
  const gln = jar.get(COOKIE)?.value || DEMO_RETAILER_GLN;
  try {
    const session = simulatedSession(erp, gln);
    return Response.json({
      session,
      retailers: erp.retailers().map((r) => ({ gln: r.gln, name: r.name })),
      warning: "Simulated hackathon session — not a secure production customer portal.",
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { retailer_gln?: string };
  const erp = await getReadyErp();
  const gln = body.retailer_gln || DEMO_RETAILER_GLN;
  try {
    const session = simulatedSession(erp, gln);
    const jar = await cookies();
    jar.set(COOKIE, session.retailer_id, { httpOnly: true, sameSite: "lax", path: "/" });
    return Response.json({
      session,
      warning: "Simulated hackathon session — not a secure production customer portal.",
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
