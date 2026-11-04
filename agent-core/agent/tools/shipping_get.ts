import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { shippingFile } from "../lib/shipping/service";

export default defineTool({
  description:
    "One order's shipping file, step by step: truck plan and load, pallets and scans, loading record, dispatch " +
    "(DESADV and DDT), invoice (FatturaPA TD01 and INVOIC 380 document ids), proofs of delivery, reconciliation causes " +
    "with euro amounts (ours and threeway's), exception cases with their allowed actions, Grok's proposals, sign-offs " +
    "and the audit log. Sources: Mini ERP (orders, shipments, invoices, documents, proofs, si_* tables, signoffs, audit).",
  inputSchema: z.object({ order_ref: z.string().min(1).describe("Order reference, e.g. ESS-GOLD-001") }),
  label: { start: ({ order_ref }) => `Open the shipping file of ${order_ref}` },
  async execute({ order_ref }) {
    const erp = await getReadyErp();
    return shippingFile(erp, order_ref);
  },
  toModelOutput(output) {
    const { audit, scans, ...rest } = output;
    return { type: "json", value: { ...rest, scans: scans.length, audit_entries: audit.length } as never };
  },
});
