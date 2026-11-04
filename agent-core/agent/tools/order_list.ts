import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { listOrders } from "../lib/order/views";

export default defineTool({
  description:
    "List the orders in the Order row with their status pill (Confirmed, Grok: fixed, Grok: split, Needs a person, " +
    "Parked, Rejected) and the one check that decided where each order is now (EDI parse, stock, price vs contract, " +
    "or the person's sign-off). Sources: the Mini ERP orders table, the sign-off queue and the audit log. " +
    "Read-only: it never confirms or rejects an order.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe("Filter on the ERP status, e.g. awaiting_confirmation, pending_price, pending_manual_edi, pending, confirmed, rejected"),
  }),
  label: { start: () => "Read the orders" },
  async execute({ status }) {
    const erp = await getReadyErp();
    return { orders: listOrders(erp, { status }) };
  },
});
