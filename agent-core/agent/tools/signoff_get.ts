import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "One sign-off case: what is proposed, the reasons a person is asked, and its status and decision. Use it to " +
    "show the person the case card so they can decide in the app; you never decide a case yourself. " +
    "Source: Mini ERP signoffs.",
  inputSchema: z.object({ caseId: z.string().describe("e.g. SO-00001") }),
  label: { start: ({ caseId }) => `Open sign-off ${caseId}` },
  async execute({ caseId }) {
    const erp = await getReadyErp();
    const c = erp.signoff(caseId);
    if (!c) throw new Error(`No sign-off case ${caseId}`);
    return { case: c, audit: erp.auditLog(c.subjectRef) };
  },
});
