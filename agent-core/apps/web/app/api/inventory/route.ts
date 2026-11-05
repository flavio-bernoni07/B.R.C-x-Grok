import { inventory } from "@agent/lib/core/inventory";
import { getReadyErp } from "@agent/lib/db/app";
import { ESTIMATE_LABEL, forecast, PRODUCTS, stockProjection, productionSuggestion } from "@agent/lib/forecast/demand";
import { todayIso } from "@agent/lib/core/stock";
import { productionPlan } from "@agent/lib/forecast/plan";

/** Stock by product and batch, plus the demand forecast and weekly projection (estimates). */
export async function GET() {
  const erp = await getReadyErp();
  const start = todayIso();
  const projections = Object.entries(PRODUCTS).map(([gtin, [itemCode]]) => {
    const rows = stockProjection(erp, gtin, { start, weeks: 8 });
    return { gtin, itemCode, forecast: forecast(gtin, start, 8), rows, suggestion: productionSuggestion(rows), plan: productionPlan(rows) };
  });
  // Backorders from split deliveries: stock a person already promised from a batch that is not made yet.
  const backorders: Record<string, { order: string; qty: number; date: string | null }[]> = {};
  for (const o of erp.orders()) {
    if (!["ready_to_ship", "awaiting_confirmation", "confirmed", "shipped", "invoiced"].includes(o.status)) continue;
    for (const b of ((o.notes ?? {}) as { backorders?: { gtin: string | null; qty: number; date: string | null }[] }).backorders ?? []) {
      if (b.gtin) (backorders[b.gtin] ??= []).push({ order: o.orderRef, qty: b.qty, date: b.date });
    }
  }
  return Response.json({ ...inventory(erp), backorders, forecast: { label: ESTIMATE_LABEL, start, projections } });
}
