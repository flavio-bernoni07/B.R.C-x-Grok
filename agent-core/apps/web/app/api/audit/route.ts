import { auditTrail } from "@agent/lib/core/overview";
import { getReadyErp } from "@agent/lib/db/app";

export async function GET(request: Request) {
  const ref = new URL(request.url).searchParams.get("ref");
  return Response.json({ ref, entries: auditTrail(await getReadyErp(), ref) });
}
