/** List disputes for the simulated retailer session only. */
import { getReadyErp } from "@agent/lib/db/app";
import { DEMO_RETAILER_GLN, listCustomerDisputes, simulatedSession } from "@agent/lib/dispute/portal";
import { cookies } from "next/headers";
import { COOKIE } from "../session/route";

export async function GET() {
  const erp = await getReadyErp();
  const jar = await cookies();
  const gln = jar.get(COOKIE)?.value || DEMO_RETAILER_GLN;
  try {
    const session = simulatedSession(erp, gln);
    return Response.json({ session, disputes: listCustomerDisputes(erp, session) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 401 });
  }
}
