import { stockStatus } from "@agent/lib/core/overview";
import { getReadyErp } from "@agent/lib/db/app";

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  return Response.json(stockStatus(await getReadyErp(), { gtin: p.get("gtin") ?? undefined, byDate: p.get("by") }));
}
