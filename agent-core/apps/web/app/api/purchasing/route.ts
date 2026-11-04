import { getReadyErp } from "@agent/lib/db/app";
import { paddyToBuy } from "@agent/lib/purchasing/paddy";

// Same function the agent's purchasing_paddy_to_buy tool calls.
export async function GET() {
  return Response.json(await paddyToBuy(await getReadyErp()));
}
