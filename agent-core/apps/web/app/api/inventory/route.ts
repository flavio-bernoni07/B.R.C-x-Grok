import { inventory } from "@agent/lib/core/inventory";
import { getReadyErp } from "@agent/lib/db/app";
import { ESTIMATE_LABEL, forecast, PRODUCTS, stockProjection, productionSuggestion } from "@agent/lib/forecast/demand";
import { todayIso } from "@agent/lib/core/stock";

/** Stock by product and batch, plus the demand forecast and weekly projection (estimates). */
export async function GET() {
  const erp = await getReadyErp();
  const start = todayIso();
  const projections = Object.entries(PRODUCTS).map(([gtin, [itemCode]]) => {
    const rows = stockProjection(erp, gtin, { start, weeks: 8 });
    return { gtin, itemCode, forecast: forecast(gtin, start, 8), rows, suggestion: productionSuggestion(rows) };
  });
  return Response.json({ ...inventory(erp), forecast: { label: ESTIMATE_LABEL, start, projections } });
}
