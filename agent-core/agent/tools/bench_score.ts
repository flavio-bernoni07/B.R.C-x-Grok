import { defineTool } from "eve/tools";
import { z } from "zod";
import { score } from "../lib/bench/score";

export default defineTool({
  description:
    "The benchmark: our reconciliation against the threeway baseline on 22 labelled cases (data/bench/cases.json). " +
    "Two scores per matcher: right call on whether someone must act, and every cause named with nothing extra; plus " +
    "each case's right answer, threeway's and ours. The cases and labels were written by the team before either " +
    "matcher ran; our one miss (C19) is a labelling slip. Sources: data/bench/cases.json, data/world/products.json.",
  inputSchema: z.object({}),
  label: { start: () => "Score reconciliation against threeway" },
  async execute() {
    return score();
  },
});
