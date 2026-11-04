import { defineTool } from "eve/tools";
import { z } from "zod";
import { auditTrail } from "../lib/core/overview";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "Every action recorded on one reference (an order, invoice, claim, batch or sign-off case), oldest first, " +
    "with who did it (code, grok, retailer or a named person) and the source document. Without a reference, " +
    "the latest actions. Source: the Mini ERP audit table.",
  inputSchema: z.object({ ref: z.string().optional().describe("e.g. ESS-GOLD-001, FT-2026/0001, CLM-00001") }),
  label: { start: ({ ref }) => (ref ? `Read the audit trail of ${ref}` : "Read the latest actions") },
  async execute({ ref }) {
    return { ref: ref ?? null, entries: auditTrail(await getReadyErp(), ref) };
  },
});
