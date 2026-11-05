/** GET /api/orders/board: every order with its desk pipeline stage. */
import { getReadyErp } from "@agent/lib/db/app";
import { BOARD_STAGE_LABEL, orderBoard } from "@agent/lib/order/board";

export async function GET() {
  const erp = await getReadyErp();
  const rows = orderBoard(erp);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  return Response.json({
    rows,
    counts,
    stages: Object.entries(BOARD_STAGE_LABEL).map(([id, label]) => ({ id, label, count: counts[id] ?? 0 })),
  });
}
