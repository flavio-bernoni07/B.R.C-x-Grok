import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { claimDetail } from "../lib/dispute/views";

export default defineTool({
  description:
    "One retailer claim in full: the claim email, Grok's extraction, the facts pulled (order, DESADV, invoice, proofs such as " +
    "signed DDT/POD and warehouse events, lookup misses), the threeway match result, the verdict with a source for every point, " +
    "the outcome documents (FatturaPA TD04, EDI INVOIC 381 or the evidence reply), the sign-off case and the audit log. " +
    "Sources: Mini ERP claims, documents, signoffs and audit tables; facts from Shipping's export plus data/disputes/erp/catalog.json.",
  inputSchema: z.object({ claim_id: z.string().describe("Claim id, e.g. CLM-00001") }),
  label: { start: ({ claim_id }) => `Open claim ${claim_id}` },
  async execute({ claim_id }) {
    const erp = await getReadyErp();
    const detail = claimDetail(erp, claim_id.trim());
    if (!detail) throw new Error(`No claim ${claim_id}. Call dispute_list for the claim ids.`);
    return detail;
  },
});
