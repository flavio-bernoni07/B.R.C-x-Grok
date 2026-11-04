import { defineTool } from "eve/tools";
import { z } from "zod";
import { getPriceForecast } from "../lib/rice";

export default defineTool({
  description:
    "Statistical baseline forecast of the Italian paddy price (EUR/t) for one variety: last price, " +
    "Prophet seasonal drift anchored on the last price, an 80% band from past price moves, and a " +
    "backtest against the naive 'price stays the same' forecast. Data: EU Agri-food Data Portal, " +
    "weekly since 2015. This is statistics only; it knows nothing about news. " +
    "Common varieties: Carnaroli, Arborio, Baldo, Roma, S. Andrea, Selenio, Long B.",
  inputSchema: z.object({
    variety: z.string().min(1).describe("Paddy variety name as in the EU data, e.g. Carnaroli"),
    horizonWeeks: z.number().int().min(1).max(26).default(8),
  }),
  label: { start: ({ variety }) => `Forecast ${variety} paddy price` },
  async execute({ variety, horizonWeeks }) {
    return getPriceForecast(variety, horizonWeeks);
  },
  // The UI draws the full history; the model only needs the numbers.
  toModelOutput(output) {
    const { history, ...rest } = output;
    return { type: "json", value: { ...rest, history_points: history.length } };
  },
});
