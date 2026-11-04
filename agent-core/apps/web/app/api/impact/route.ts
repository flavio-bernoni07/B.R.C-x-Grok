import { impactSummary } from "@agent/lib/core/impact";
import { getReadyErp } from "@agent/lib/db/app";

export async function GET() {
  return Response.json(impactSummary(await getReadyErp()));
}
