import { getReadyErp } from "@agent/lib/db/app";
import { ShippingError, reconcileView } from "@agent/lib/shipping/service";

/** Reconcile one order (read only: sends and holds nothing). */
export async function GET(_req: Request, { params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params;
  const erp = await getReadyErp();
  try {
    return Response.json(reconcileView(erp, decodeURIComponent(orderRef)));
  } catch (err) {
    if (err instanceof ShippingError) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
