import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { DISPATCH_DAY } from "../lib/demo/dispatch";
import { proposeDispatchPlan, readyOrders, RoutePlanError } from "../lib/shipping/routes";

export default defineTool({
  description:
    "The logistics agent: plan which ready-to-ship orders share a truck and in which order each truck drives, for one " +
    "ship date. Orders for the same delivery point go on one stop; code tries every grouping and stop order on real " +
    "road distances and keeps the shortest plan that fits each truck (33 pallets, 24,000 kg), reaches every retailer " +
    "on the ship date within the 9-hour driving limit and adds no driver day. It compares the plan with one truck per " +
    "order (trucks, km, litres, diesel €, CO2 estimate) and Grok writes the briefing (figures checked by code). The " +
    "plan goes to the transport planner's sign-off queue; this tool never books a truck. Asking again for the same " +
    "date returns the waiting plan. Sources: Mini ERP orders and products, data/world/logistics.json (OSRM road " +
    "distances, ICCT fuel use, MASE diesel price, EU 561/2006).",
  inputSchema: z.object({
    ship_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Ship date, YYYY-MM-DD (default ${DISPATCH_DAY}, the demo dispatch day)`),
  }),
  label: { start: ({ ship_date }) => `Plan the trucks for ${ship_date ?? DISPATCH_DAY}` },
  async execute({ ship_date }) {
    const erp = await getReadyErp();
    const shipDate = ship_date ?? DISPATCH_DAY;
    try {
      const r = await proposeDispatchPlan(erp, { shipDate });
      return { ...r, ship_date: shipDate, ready: readyOrders(erp), plan_case: erp.signoff(r.case_id) };
    } catch (err) {
      if (err instanceof RoutePlanError) return { ship_date: shipDate, ready: readyOrders(erp), error: err.message };
      throw err;
    }
  },
});
