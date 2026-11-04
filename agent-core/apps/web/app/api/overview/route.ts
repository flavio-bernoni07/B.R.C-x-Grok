import { overviewSnapshot } from "@agent/lib/core/overview";
import { getReadyErp } from "@agent/lib/db/app";

export async function GET() {
  return Response.json(overviewSnapshot(await getReadyErp()));
}
