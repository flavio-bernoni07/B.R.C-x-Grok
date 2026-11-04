import { getReadyErp } from "@agent/lib/db/app";
import { receiveOrder } from "@agent/lib/order/service";
import { listOrders, orderDetail } from "@agent/lib/order/views";

/** GET /api/orders[?status=...]: the orders with their pill and deciding check. */
export async function GET(req: Request) {
  const erp = await getReadyErp();
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  return Response.json({ orders: listOrders(erp, { status }) });
}

/**
 * POST /api/orders { edi, source_name? }: receive one ORDERS message. Runs parse, checks and
 * Grokbot on exceptions, and stops at a person (it never confirms).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { edi?: unknown; source_name?: unknown } | null;
  const edi = typeof body?.edi === "string" ? body.edi : "";
  if (!edi.trim()) return Response.json({ error: "Send the ORDERS EDI text as { edi }." }, { status: 400 });
  const erp = await getReadyErp();
  try {
    const result = await receiveOrder(erp, edi, { sourceName: typeof body?.source_name === "string" ? body.source_name : "ORDERS" });
    return Response.json({ result, order: result.order_ref ? orderDetail(erp, result.order_ref) : null });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
