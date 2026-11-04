import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import type { OrderWorkspace } from "../lib/order/workspace";
import { orderWorkspace } from "../lib/order/workspace";

export default defineTool({
  description:
    "The workspace of one order: where it is in its journey (Received, Confirmed, Reserved, Planned, Picked, Loaded, " +
    "Dispatched, Invoiced, Received by retailer, Paid, plus Claim) with who did each step, when and the document; " +
    "confirmed, reserved, shipped and remaining quantities; money at stake; open exceptions; the next step; and how many " +
    "steps code and Grok did against approvals by people. Sources: core trace chain (ORDERS, sign-offs, ORDRSP, batches, " +
    "DESADV, DDT, invoices, proofs of delivery, claims, payments) and the audit log. Read-only.",
  inputSchema: z.object({ order_ref: z.string().min(1).describe("Order number, e.g. ESS-GOLD-001") }),
  label: { start: ({ order_ref }) => `Open the journey of ${order_ref}` },
  async execute({ order_ref }) {
    const erp = await getReadyErp();
    const workspace = orderWorkspace(erp, order_ref);
    if (!workspace) return { error: `There is no order ${order_ref} in the records.` };
    return { workspace };
  },
  toModelOutput(output) {
    const w = (output as { workspace?: OrderWorkspace }).workspace;
    if (!w) return { type: "json", value: output as never };
    const { history, inventory, ...rest } = w;
    return { type: "json", value: { ...rest, history_entries: history.length, batches: inventory.batches.length } as never };
  },
});
