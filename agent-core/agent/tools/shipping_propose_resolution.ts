import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { proposeWithGrok, viewExceptionCase } from "../lib/shipping/cases";

export default defineTool({
  description:
    "Ask Grok to propose a resolution for one open shipping exception case, choosing only from the case's allowed " +
    "actions. Code validates every action against the stored facts (trucks, batches, stock, rules); one bad action " +
    "rejects the whole proposal. A validated proposal goes to the sign-off queue for an employee in the case's role. " +
    "This tool never approves or executes anything. Without an API key it returns no proposal and the case waits for " +
    "a person. Sources: Mini ERP si_exception_cases, trucks, pallets, batches; Grok (xAI).",
  inputSchema: z.object({ case_id: z.string().min(1).describe("Exception case id, e.g. CASE-00001") }),
  label: { start: ({ case_id }) => `Ask Grok to propose a resolution for ${case_id}` },
  async execute({ case_id }) {
    const erp = await getReadyErp();
    const before = viewExceptionCase(erp, case_id);
    if (!before) return { case_id, error: `No exception case ${case_id}` };
    if (before.status !== "open" && before.status !== "clarification_requested") {
      return { case_id, status: before.status, proposal: null, note: "This case is not open for a new proposal." };
    }
    const proposal = await proposeWithGrok(erp, case_id);
    const after = viewExceptionCase(erp, case_id)!;
    return {
      case_id,
      status: after.status,
      role: after.role,
      signoff_case: after.signoff_case,
      proposal,
      note: proposal
        ? proposal.status === "validated"
          ? `Validated by code; waiting for an employee with role ${after.role} to approve in the sign-off queue.`
          : "Rejected by code; nothing changed."
        : "Grok gave no valid proposal (no key, no answer or rejected twice); the case waits for a person.",
    };
  },
});
