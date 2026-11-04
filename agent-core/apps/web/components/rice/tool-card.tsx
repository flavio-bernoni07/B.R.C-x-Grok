"use client";

import type { MarketSnapshot, NewsResult, PriceForecast } from "@agent/lib/rice";
import type { EveToolPart } from "eve/react";
import { ForecastCard } from "./forecast-card";
import { MarketOverview } from "./market-overview";
import { NewsCard } from "./news-card";

/** Tools whose finished output the chat draws as a card instead of a trace line. */
const CARD_TOOLS = new Set(["rice_price_forecast", "rice_market_snapshot", "rice_market_news"]);

export function isCardTool(part: EveToolPart): boolean {
  return CARD_TOOLS.has(part.name) && part.state === "completed" && part.output != null;
}

export function ToolCard({ part }: { readonly part: EveToolPart }) {
  switch (part.name) {
    case "rice_price_forecast":
      return <ForecastCard forecast={part.output as PriceForecast} />;
    case "rice_market_snapshot":
      return <MarketOverview market={part.output as MarketSnapshot} />;
    case "rice_market_news":
      return <NewsCard news={part.output as NewsResult} />;
    default:
      return null;
  }
}
