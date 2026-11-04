import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { receiveOrder } from "../lib/order/service";
import { orderDetail } from "../lib/order/views";

export default defineTool({
  description:
    "Take an EDIFACT ORDERS message (the EDI text) and run the Order row on it: code parses the EDI, checks stock " +
    "(Mini ERP available-to-promise) and the price (supply contract CTR-SCOTTI-ESS-2026); Grok is asked only on " +
    "exceptions (an EDI fix that is parsed again, a split or reduced quantity computed by code, a price mail with " +
    "the code's figures). It always stops at a person: a confirm sign-off when checks pass, or a price / manual EDI / " +
    "stock case. It never confirms the order and never sends ORDRSP; a person does that in the sign-off page.",
  inputSchema: z.object({
    edi: z.string().min(1).describe("The ORDERS EDI text, segments ending with '"),
    source_name: z.string().optional().describe("Where the message came from, e.g. a file name"),
  }),
  label: { start: () => "Check the ORDERS message" },
  async execute({ edi, source_name }) {
    const erp = await getReadyErp();
    const result = await receiveOrder(erp, edi, { sourceName: source_name ?? "ORDERS" });
    return { result, order: result.order_ref ? orderDetail(erp, result.order_ref) : null };
  },
});
