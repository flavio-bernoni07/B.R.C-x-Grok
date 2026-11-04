import type { MarketSnapshot, NewsResult, PriceForecast } from "@agent/lib/rice";
import { createElement, type ReactNode } from "react";
import { ForecastCard } from "./forecast-card";
import { MarketOverview } from "./market-overview";
import { NewsCard } from "./news-card";

/** Chat cards for the paddy price tools. */
export const cards: Record<string, (props: { output: unknown }) => ReactNode> = {
  rice_price_forecast: ({ output }) => createElement(ForecastCard, { forecast: output as PriceForecast }),
  rice_market_snapshot: ({ output }) => createElement(MarketOverview, { market: output as MarketSnapshot }),
  rice_market_news: ({ output }) => createElement(NewsCard, { news: output as NewsResult }),
};
