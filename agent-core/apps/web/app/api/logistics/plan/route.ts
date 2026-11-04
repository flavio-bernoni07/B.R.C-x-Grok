import { getReadyErp } from "@agent/lib/db/app";
import { logisticsPlan } from "@agent/lib/logistics/plan";

// Same function the agent's logistics_plan tool calls; one planner with /api/shipping/routes. ?date=YYYY-MM-DD.
export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date") ?? undefined;
  return Response.json(logisticsPlan(await getReadyErp(), { shipDate: date }));
}
