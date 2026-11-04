/** Stock for this order's lines checked again now (agent/lib/order/stock_now.ts). */
import { getReadyErp } from "@agent/lib/db/app";
import { stockNow } from "@agent/lib/order/stock_now";

export async function GET(_request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return Response.json({ order_ref: ref, checks: stockNow(await getReadyErp(), decodeURIComponent(ref)), at: new Date().toISOString() });
}
