import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { shippingList } from "../lib/shipping/service";

export default defineTool({
  description:
    "List the orders in Shipping and invoicing (ready to ship, shipped, invoiced) with their invoices, invoice status, " +
    "short deliveries, truck, open exception cases, and the reconciliation result: our causes beside threeway's answer " +
    "on the same order, DESADV and invoice. Sources: Mini ERP orders, shipments (DESADV), invoices (FatturaPA TD01 / " +
    "INVOIC 380), si_exception_cases; reconciliation computed by code (shipping/reconcile, threeway baseline).",
  inputSchema: z.object({}),
  label: { start: () => "Read shipments and invoices" },
  async execute() {
    const erp = await getReadyErp();
    return { orders: shippingList(erp) };
  },
});
