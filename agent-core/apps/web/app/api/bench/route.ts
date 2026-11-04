import { score } from "@agent/lib/bench/score";

export async function GET() {
  return Response.json(score());
}
