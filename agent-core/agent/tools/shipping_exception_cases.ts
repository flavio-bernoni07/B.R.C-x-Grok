import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { openCases } from "../lib/shipping/service";

export default defineTool({
  description:
    "List the open shipping exception cases (failed truck plan, pallet scan, loading or dispatch checks), each with " +
    "the role that must approve, the actions that may be proposed, the actions that are never allowed, the proposals " +
    "so far and their validation. Sources: Mini ERP si_exception_cases and si_proposals (shipping/cases).",
  inputSchema: z.object({ order_ref: z.string().optional().describe("Only the cases of this order") }),
  label: { start: () => "Read the shipping exception cases" },
  async execute({ order_ref }) {
    const erp = await getReadyErp();
    return { cases: openCases(erp, order_ref) };
  },
});
