import { getReadyErp } from "@agent/lib/db/app";
import { orderDetail } from "@agent/lib/order/views";

/** GET /api/orders/:ref: one order with lines, checks, documents, sign-off cases and audit trail. */
export async function GET(_req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const erp = await getReadyErp();
  const order = orderDetail(erp, ref);
  if (!order) return Response.json({ error: `No order ${ref}` }, { status: 404 });
  return Response.json({ order });
}
