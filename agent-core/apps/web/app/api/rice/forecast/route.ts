import { getPriceForecast } from "@agent/lib/rice";

// Same function the agent's rice_price_forecast tool calls.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const variety = params.get("variety") ?? "Carnaroli";
  const horizon = Math.min(26, Math.max(1, Number(params.get("horizon") ?? 8) || 8));
  try {
    return Response.json(await getPriceForecast(variety, horizon));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
