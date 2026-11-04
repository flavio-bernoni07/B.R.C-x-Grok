import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchMarketNews } from "../lib/rice";

export default defineTool({
  description:
    "Search recent news on the web and X with Grok's live search, for anything that moves rice " +
    "prices: export bans and quotas, EU tariffs and trade deals, Asian export prices, harvests and " +
    "weather, currency. Returns a short summary with source URLs. Each call takes 30-90 seconds, " +
    "so call it once per answer with one query that names everything you need.",
  inputSchema: z.object({
    query: z.string().min(3).describe("What to look for, e.g. 'India rice export policy October 2026'"),
    days: z.number().int().min(1).max(365).default(30).describe("How far back to search"),
  }),
  label: { start: ({ query }) => `Search news: ${query}` },
  async execute({ query, days }) {
    return searchMarketNews(query, days);
  },
});
