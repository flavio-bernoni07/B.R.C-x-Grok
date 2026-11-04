import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { readClaim } from "../lib/dispute/claim_reader";
import { callersFor, disputeStore } from "../lib/dispute/service";

export default defineTool({
  description:
    "Read a retailer claim email or short-payment remittance without recording anything: Grok extracts order ref, invoice ref, " +
    "product, quantity, amount, claim type and confidence (missing refs stay empty, never invented); then code checks whether " +
    "the order, DESADV and invoice exist. Sources: the email text (Grok), the Mini ERP via Shipping's export and " +
    "data/disputes/erp/catalog.json (code). Without an API key it only works for the recorded demo claims.",
  inputSchema: z.object({ email_text: z.string().min(1).describe("The claim email or remittance text, as received") }),
  label: { start: () => "Read the claim email" },
  async execute({ email_text }) {
    const { readCaller, mode } = callersFor(email_text);
    const extraction = await readClaim(email_text, { caller: readCaller });
    const erp = await getReadyErp();
    const store = disputeStore(erp);
    const [order, orderMiss] = store.findOrder(extraction.order_ref);
    const resolved = order ? String(order.order_ref) : extraction.order_ref;
    const [desadv, desadvMiss] = store.findDesadv(resolved);
    const [invoice, invoiceMiss] = store.findInvoice(extraction.invoice_ref, resolved);
    return {
      mode,
      extraction,
      ref_checks: {
        order: order ? { found: true, ref: order.order_ref ?? null, customer: order.customer ?? null } : { found: false, miss: orderMiss },
        desadv: desadv ? { found: true, ref: desadv.desadv_ref ?? null } : { found: false, miss: desadvMiss },
        invoice: invoice ? { found: true, ref: invoice.invoice_ref ?? null } : { found: false, miss: invoiceMiss },
      },
    };
  },
});
