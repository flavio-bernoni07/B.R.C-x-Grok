import { getMarketSnapshot } from "@agent/lib/rice";

// Same function the agent's rice_market_snapshot tool calls.
export async function GET() {
  try {
    return Response.json(await getMarketSnapshot());
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
