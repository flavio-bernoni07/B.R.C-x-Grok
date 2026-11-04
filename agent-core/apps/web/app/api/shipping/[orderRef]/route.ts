import { getReadyErp } from "@agent/lib/db/app";
import { ShippingError, shippingFile } from "@agent/lib/shipping/service";

export async function GET(_req: Request, { params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params;
  const erp = await getReadyErp();
  try {
    return Response.json(shippingFile(erp, decodeURIComponent(orderRef)));
  } catch (err) {
    if (err instanceof ShippingError) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
