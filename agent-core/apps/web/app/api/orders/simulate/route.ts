/**
 * POST /api/orders/simulate: the 22 labelled bench POs (data/bench/cases.json), the golden order,
 * and every ORDERS in data/orders/feed.json. Human gates go to Sign-off Pending; the batch never
 * stops on the first one.
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
