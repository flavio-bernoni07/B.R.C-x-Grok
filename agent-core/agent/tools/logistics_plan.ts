import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { logisticsPlan } from "../lib/logistics/plan";

export default defineTool({
  description:
    "Logistics agent: shared trucks and shorter routes for confirmed orders waiting to ship. Groups orders by delivery " +
    "date, fills 33 pallet / 24 t trucks largest first, lets nearby delivery points (within 40 km) share a truck, orders " +
    "the stops from and back to Pavia, and compares km, litres, euros and CO2 with one truck per order. Distances are " +
    "estimates on demo coordinates. Orders are never split. With scenario=true it adds a few marked demo orders (not " +
    "saved) to show consolidation. A plan only: it books or dispatches nothing.",
  inputSchema: z.object({ scenario: z.boolean().default(false).describe("Add the marked demo orders to show consolidation") }),
  label: { start: () => "Plan shared trucks" },
  async execute({ scenario }) {
    return logisticsPlan(await getReadyErp(), { scenario });
  },
});
