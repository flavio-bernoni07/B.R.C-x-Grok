import { getReadyErp } from "@agent/lib/db/app";
import { openCases } from "@agent/lib/shipping/service";

export async function GET(req: Request) {
  const orderRef = new URL(req.url).searchParams.get("order_ref") ?? undefined;
  const erp = await getReadyErp();
  return Response.json({ cases: openCases(erp, orderRef) });
}
