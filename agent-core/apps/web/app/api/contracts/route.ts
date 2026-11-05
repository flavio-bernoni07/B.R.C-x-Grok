import { contracts } from "@agent/lib/core/contracts";

/** Every retailer's annual contract (billed monthly), summarised. */
export async function GET() {
  return Response.json({ contracts: contracts() });
}
