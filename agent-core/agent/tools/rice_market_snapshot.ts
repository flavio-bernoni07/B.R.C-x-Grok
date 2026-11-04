import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMarketSnapshot } from "../lib/rice";

export default defineTool({
  description:
    "Latest Italian paddy prices per variety (EUR/t, with 4-week and 52-week change) and world " +
    "export rice prices (Thai 5% and Vietnam 5%, in USD and converted to EUR with the ECB rate). " +
    "Sources: EU Agri-food Data Portal, World Bank Pink Sheet, ECB.",
  inputSchema: z.object({}),
  label: { start: () => "Read rice market prices" },
  async execute() {
    return getMarketSnapshot();
  },
});
