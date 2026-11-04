"use client";

import type { MarketSnapshot, PriceForecast } from "@agent/lib/rice";
import { useEffect, useState } from "react";
import { ForecastCard } from "./forecast-card";
import { eur, pct } from "./format";

export type Ask = (text: string, context?: Record<string, string | number | boolean>) => void;

/**
 * The first message of every thread: this week's story in three sentences and one chart,
 * drawn from the same functions the agent's tools call. Questions continue below it.
 */
export function Intro({ onAsk }: { readonly onAsk: Ask }) {
  const [market, setMarket] = useState<MarketSnapshot>();
  const [variety, setVariety] = useState("Carnaroli");
  const [forecast, setForecast] = useState<PriceForecast>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch("/api/rice/market")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setMarket(d)))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`/api/rice/forecast?variety=${encodeURIComponent(variety)}&horizon=8`)
      .then((r) => r.json())
      .then((d) => live && (d.error ? setError(d.error) : setForecast(d)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [variety]);

  const thai = market?.world.thai_5pct;
  const yoy = forecast?.change_52w_pct;

  return (
    <div className="space-y-4">
      {error ? <p className="text-destructive text-sm">Could not load prices: {error}</p> : null}

      <p className="text-[15px] leading-relaxed">
        {forecast && thai ? (
          <>
            {forecast.variety} paddy is at <b>{eur(forecast.last_price)}/t</b>
            {yoy != null ? `, ${Math.abs(yoy).toFixed(1)}% ${yoy < 0 ? "below" : "above"} a year ago` : ""}. World rice is{" "}
            {(thai.change_12m_eur_pct ?? 0) >= 0 ? "up" : "down"} {pct(thai.change_12m_eur_pct).replace(/^[+−]/, "")} in
            euros over 12 months, so pressure from cheap imports is{" "}
            {(thai.change_12m_eur_pct ?? 0) >= 0 ? "easing" : "growing"}. Past prices alone see{" "}
            {forecast.variety} near {eur(forecast.forecast_end.mean)}/t in 8 weeks. Ask me to check the news before
            you decide.
          </>
        ) : (
          <span className="text-muted-foreground">Loading this week’s prices…</span>
        )}
      </p>

      {forecast ? (
        <ForecastCard
          forecast={forecast}
          picker={
            <select
              aria-label="Paddy variety"
              className="rounded-md border bg-background px-2 py-1 font-medium text-sm"
              value={variety}
              onChange={(e) => setVariety(e.target.value)}
            >
              {(market?.paddy.map((p) => p.variety) ?? [variety]).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          }
        />
      ) : (
        <div className="h-80 animate-pulse rounded-xl border bg-card" />
      )}

      <div className="flex flex-wrap gap-2">
        {[
          `Should we buy ${variety} now or wait?`,
          "What is moving world rice prices?",
        ].map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onAsk(text, { variety, horizonWeeks: 8 })}
            className="rounded-full border bg-card px-3 py-1.5 text-sm hover:bg-accent"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
