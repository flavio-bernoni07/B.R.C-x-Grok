import { defineTool } from "eve/tools";
import { z } from "zod";
import { refreshData } from "../lib/rice";

export default defineTool({
  description:
    "Download the latest EU paddy prices, World Bank world rice prices and ECB exchange rates " +
    "into data/raw/. Use only when the user asks for fresh data or the data looks out of date.",
  inputSchema: z.object({}),
  label: { start: () => "Refresh price data" },
  async execute() {
    return refreshData();
  },
});
