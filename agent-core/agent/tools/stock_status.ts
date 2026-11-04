import { defineTool } from "eve/tools";
import { z } from "zod";
import { stockStatus } from "../lib/core/overview";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "Stock per product: released, planned (ready by a date), on quality hold, committed to confirmed orders, and " +
    "available to promise (released + planned − committed; held batches never count). Also every batch and the " +
    "production events behind it. Source: Mini ERP batches and production_events.",
  inputSchema: z.object({
    gtin: z.string().optional().describe("Only this product's GTIN"),
    byDate: z.string().optional().describe("Count planned batches ready by this date (YYYY-MM-DD)"),
  }),
  label: { start: ({ gtin }) => (gtin ? `Check stock for ${gtin}` : "Check stock") },
  async execute({ gtin, byDate }) {
    return stockStatus(await getReadyErp(), { gtin, byDate });
  },
});
