import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { orderDetail } from "../lib/order/views";

export default defineTool({
  description:
    "One order in full: its lines (ordered, confirmed, unit price, contract price), each check with its source " +
    "(the ORDERS document for the EDI parse, Mini ERP available-to-promise for stock, the supply contract " +
    "CTR-SCOTTI-ESS-2026 for the price, the sign-off case for the person), the draft ORDRSP or the ORDRSP sent, " +
    "Grokbot's notes, the draft price mail, the documents and the audit trail. Sources: Mini ERP orders, documents, " +
    "signoffs and audit tables. Read-only.",
  inputSchema: z.object({ order_ref: z.string().min(1).describe("Order number from the BGM segment, e.g. ESS-GOLD-001") }),
  label: { start: ({ order_ref }) => `Open order ${order_ref}` },
  async execute({ order_ref }) {
    const erp = await getReadyErp();
    const order = orderDetail(erp, order_ref);
    if (!order) return { error: `No order ${order_ref} in the Mini ERP.` };
    return { order };
  },
});
