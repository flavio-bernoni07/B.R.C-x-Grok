import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { DISPATCH_DAY } from "../lib/demo/dispatch";
import { logisticsPlan } from "../lib/logistics/plan";

export default defineTool({
  description:
    "Logistics agent, read only: the current plan for shared trucks and stop order for one ship date, with km, " +
    "litres, diesel € and CO2 (an estimate) against one truck per order. Same planner as shipping_plan_routes: real " +
    "road distances (OSRM), ICCT fuel use, MASE diesel price, 33 pallets / 24 t per truck, the 9-hour driving limit. " +
    "Orders not confirmed yet are shown as a preview. It books nothing: use shipping_plan_routes to send a plan to the " +
    "transport planner's sign-off. Sources: Mini ERP orders, data/world/logistics.json.",
  inputSchema: z.object({
    ship_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`Ship date, YYYY-MM-DD (default ${DISPATCH_DAY})`),
  }),
  label: { start: () => "Plan shared trucks" },
  async execute({ ship_date }) {
    return logisticsPlan(await getReadyErp(), { shipDate: ship_date });
  },
});
