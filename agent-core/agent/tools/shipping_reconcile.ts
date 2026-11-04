import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { reconcileView } from "../lib/shipping/service";

export default defineTool({
  description:
    "Reconcile one order: the order, the DESADV (what shipped) and the invoice, compared by code. Returns every cause " +
    "on every line with its euro amount (short_delivery, over_delivery, overbilled, underbilled, price_difference, " +
    "orphan_invoice, not_shipped, uom_unknown), a plain explanation written by code, and threeway's answer on the same " +
    "documents (the track baseline, default settings) so the two can be compared. Read only: it sends and holds nothing. " +
    "Sources: Mini ERP orders, shipments, invoices; shipping/reconcile and threeway core.",
  inputSchema: z.object({ order_ref: z.string().min(1).describe("Order reference, e.g. ESS-GOLD-001") }),
  label: { start: ({ order_ref }) => `Reconcile ${order_ref}` },
  async execute({ order_ref }) {
    const erp = await getReadyErp();
    return reconcileView(erp, order_ref);
  },
});
