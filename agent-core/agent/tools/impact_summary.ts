import { defineTool } from "eve/tools";
import { z } from "zod";
import { impactSummary } from "../lib/core/impact";
import { getReadyErp } from "../lib/db/app";

export default defineTool({
  description:
    "What the agents did, counted from the records: active orders, orders running automatically, orders needing a person, " +
    "deliveries at risk (with why), steps by agents (code and Grok) against steps by people, share of cases with no person, " +
    "invoice gaps caught by reconciliation, the benchmark against threeway, and recently completed work. " +
    "Source: the Mini ERP (orders, claims, sign-offs, shipping cases, audit log) and data/bench/cases.json.",
  inputSchema: z.object({}),
  label: { start: () => "Count what the agents did" },
  async execute() {
    return impactSummary(await getReadyErp());
  },
});
