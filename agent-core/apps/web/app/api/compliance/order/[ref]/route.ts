import { orderCompliance } from "@agent/lib/compliance/passport";
import { getReadyErp } from "@agent/lib/db/app";

/** Compliance passports for every lot on an order (shipped lines, else product batches). */
export async function GET(_request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return Response.json(orderCompliance(await getReadyErp(), decodeURIComponent(ref)));
}
