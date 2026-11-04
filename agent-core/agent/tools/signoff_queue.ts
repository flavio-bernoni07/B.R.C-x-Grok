import { defineTool } from "eve/tools";
import { z } from "zod";
import { pending } from "../lib/core/signoff";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "List the cases waiting for a person in the one sign-off queue (all rows: order, shipping, dispute), " +
    "with what is proposed and why a person is asked. Source: the Mini ERP signoffs table.",
  inputSchema: z.object({ row: z.enum(["order", "shipping", "dispute"]).optional() }),
  label: { start: () => "Read the sign-off queue" },
  async execute({ row }) {
    const erp = await getReadyErp();
    return { pending: pending(erp, row) };
  },
});
