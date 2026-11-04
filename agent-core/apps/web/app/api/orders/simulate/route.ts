/**
 * POST /api/orders/simulate: run every ORDERS in data/orders/feed.json (plus the golden order).
 * Human gates go to Sign-off Pending; the batch never stops on the first one.
 */
import { getReadyErp } from "@agent/lib/db/app";
import { simulateOrderFeed } from "@agent/lib/order/service";
import { listOrders } from "@agent/lib/order/views";

export async function POST() {
  const erp = await getReadyErp();
  try {
    const { results } = await simulateOrderFeed(erp);
    const waiting = results.filter((r) => r.ok && r.result?.status === "awaiting_person").length;
    return Response.json({
      results,
      summary: {
        total: results.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        awaiting_person: waiting,
      },
      orders: listOrders(erp),
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
