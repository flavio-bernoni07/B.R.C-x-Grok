import { defineTool } from "eve/tools";
import { z } from "zod";
import { overviewSnapshot } from "../lib/core/overview";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "The general state of the back office right now: orders by status, shipments, invoices sent or held, claims, " +
    "credit notes, cases waiting for a person, stock on quality hold, the latest actions, and the weekly digest. " +
    "Source: the Mini ERP (orders, invoices, claims, signoffs, batches, audit tables).",
  inputSchema: z.object({}),
  label: { start: () => "Read the state of the back office" },
  async execute() {
    return overviewSnapshot(await getReadyErp());
  },
  toModelOutput(o) {
    const { digest, recent, ...rest } = o;
    return { type: "json", value: { ...rest, digest: digest.markdown, recent: recent.slice(0, 8) } };
  },
});
