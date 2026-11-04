import { defineTool } from "eve/tools";
import { z } from "zod";
import { getReadyErp } from "../lib/db/app";
import { paddyToBuy } from "../lib/purchasing/paddy";

export default defineTool({
  description:
    "Purchasing agent, 'Paddy to buy': per paddy variety (Arborio, Carnaroli), buy now, buy as usual or wait, and how " +
    "many tonnes to buy from farmers in the next 8 weeks, with the estimated spend. Code computes every figure from " +
    "confirmed orders not shipped (Mini ERP), the demand forecast (estimate on invented history), released and planned " +
    "batches, demo silo and contract data (data/world/paddy.json) and the Prophet paddy price forecast. Each row has " +
    "'steps' with one source per step. A suggestion only: a person signs every purchase; this tool buys nothing.",
  inputSchema: z.object({}),
  label: { start: () => "Work out paddy to buy" },
  async execute() {
    return paddyToBuy(await getReadyErp());
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: {
        ...output,
        rows: output.rows.map(({ steps, price, ...r }) => ({ ...r, price: price && { ...price, sources: price.sources.map((s) => s.name) } })),
      },
    };
  },
});
