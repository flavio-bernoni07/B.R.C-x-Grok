import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { callersFor, handleClaim } from "../lib/dispute/service";
import { claimDetail } from "../lib/dispute/views";

export default defineTool({
  description:
    "Run the whole Dispute row on a claim email and record it: Grok reads the claim, code pulls the facts (order, DESADV, " +
    "invoice, proofs, threeway match), Grok proposes accept / partial / reject citing a source per point, and code checks it. " +
    "If nothing is ambiguous, code writes the outcome (FatturaPA TD04 + EDI INVOIC 381, or an evidence reply). If anything is " +
    "ambiguous (Grok unsure or confidence under 0.55, a point with no source, claim type not in the Playbook, a missing document, " +
    "an amount not in the documents) it opens a sign-off for a person and sends nothing. There is no euro threshold. " +
    "This tool never approves a sign-off. Sources: the email, the Mini ERP (Shipping's export), data/disputes/erp/catalog.json, " +
    "the Playbook and contract excerpt. Without an API key it replays recorded answers for the demo claims only.",
  inputSchema: z.object({
    email_text: z.string().min(1).describe("The claim email or remittance text, as received"),
    source_name: z.string().optional().describe("Where the email came from, e.g. a file name or mailbox"),
  }),
  label: { start: () => "Handle the claim" },
  async execute({ email_text, source_name }) {
    const erp = await getReadyErp();
    const { readCaller, verdictCaller, mode } = callersFor(email_text);
    const result = await handleClaim(erp, email_text, { readCaller, verdictCaller, sourceName: source_name ?? "claim email (chat)" });
    return { mode, result, claim: claimDetail(erp, result.claim_id) };
  },
});
