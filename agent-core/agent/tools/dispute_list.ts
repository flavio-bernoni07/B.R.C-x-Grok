import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { listClaims } from "../lib/dispute/views";

export default defineTool({
  description:
    "List the retailer claims (disputes), newest first: status, what the retailer claims (type, amount, product), " +
    "Grok's proposed verdict (decision, amount, confidence, number of cited sources, whether a person must sign off and why), " +
    "the outcome (TD04 credit note, evidence reply, or waiting for a person) and the sign-off case. " +
    "Sources: the Mini ERP claims, documents and sign-off tables; customer names from Shipping's export and data/disputes/erp/catalog.json.",
  inputSchema: z.object({}),
  label: { start: () => "Read the disputes" },
  async execute() {
    const erp = await getReadyErp();
    return { claims: listClaims(erp) };
  },
});
