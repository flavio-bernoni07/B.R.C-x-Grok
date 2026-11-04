import { getReadyErp } from "@agent/lib/db/app";
import { orderWorkspace } from "@agent/lib/order/workspace";

/** GET /api/orders/:ref/workspace: the order workspace (journey, summary, sections, history). */
export async function GET(_req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  const erp = await getReadyErp();
  const workspace = orderWorkspace(erp, ref);
  if (!workspace) return Response.json({ error: `There is no order ${ref} in the records.` }, { status: 404 });
  return Response.json({ workspace });
}
