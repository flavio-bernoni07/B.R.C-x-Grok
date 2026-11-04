import { getReadyErp } from "@agent/lib/db/app";
import { shippingList } from "@agent/lib/shipping/service";

export async function GET() {
  const erp = await getReadyErp();
  return Response.json({ orders: shippingList(erp) });
}
