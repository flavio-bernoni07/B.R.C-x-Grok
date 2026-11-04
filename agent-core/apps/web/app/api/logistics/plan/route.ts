import { getReadyErp } from "@agent/lib/db/app";
import { logisticsPlan } from "@agent/lib/logistics/plan";

// Same function the agent's logistics_plan tool calls. ?scenario=1 adds marked demo orders (not saved).
export async function GET(request: Request) {
  const s = new URL(request.url).searchParams.get("scenario");
  return Response.json(logisticsPlan(await getReadyErp(), { scenario: s === "1" || s === "true" }));
}
