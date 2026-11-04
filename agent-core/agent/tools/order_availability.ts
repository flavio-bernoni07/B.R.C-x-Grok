import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { orderAvailability } from "../lib/order/views";

export default defineTool({
  description:
    "Available to promise for one product (GTIN) by a date: released batches plus planned batches ready by that " +
    "date, minus confirmed orders not shipped yet; batches on quality hold never count. Also gives the next date a " +
    "planned batch is ready. Source: the Mini ERP batches and production events, and its confirmed orders. " +
    "This is the same number the Order row's stock check uses.",
  inputSchema: z.object({
    gtin: z.string().min(8).describe("Product barcode, e.g. 8000000000001"),
    date: z.string().optional().describe("Delivery or order date, YYYY-MM-DD or YYYYMMDD; omit for all planned batches"),
  }),
  label: { start: ({ gtin }) => `Check stock for ${gtin}` },
  async execute({ gtin, date }) {
    const erp = await getReadyErp();
    const availability = orderAvailability(erp, gtin, date ?? null);
    if (!availability) return { error: `GTIN ${gtin} is not a product in the Mini ERP.` };
    return { availability };
  },
});
