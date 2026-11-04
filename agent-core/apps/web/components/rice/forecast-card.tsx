"use client";

import type { PriceForecast } from "@agent/lib/rice";
import type { ReactNode } from "react";
import { ForecastChart } from "./forecast-chart";
import { eur, pct, shortDate, trendClass } from "./format";

/** One variety's price and baseline, told as a short story with one chart. */
export function ForecastCard({
  forecast,
  picker,
}: {
  readonly forecast: PriceForecast;
  /** Optional control in the header, e.g. a variety select on the intro. */
  readonly picker?: ReactNode;
}) {
  const end = forecast.forecast_end;
  const bt = forecast.backtest;
  return (
    <section className="w-full space-y-3 rounded-[14px] bg-hh-seasalt p-4 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
      <header className="flex items-center justify-between gap-3">
        {picker ?? <h3 className="font-medium">{forecast.variety}</h3>}
        <span className="text-muted-foreground text-xs">paddy · week of {shortDate(forecast.as_of)}</span>
      </header>

      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium text-3xl tabular-nums tracking-tight">{eur(forecast.last_price)}/t</span>
        <span className={`text-sm tabular-nums ${trendClass(forecast.change_52w_pct)}`}>
          {pct(forecast.change_52w_pct)} vs a year ago
        </span>
      </div>

      <ForecastChart forecast={forecast} height={220} />

      <p className="text-sm">
        By {shortDate(end.date)}, past prices alone point to about <b>{eur(end.mean)}/t</b>, likely between{" "}
        {eur(end.lower)} and {eur(end.upper)}.
      </p>

      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer select-none">How this is made</summary>
        <div className="mt-2 space-y-1.5 leading-relaxed">
          <p>
            {forecast.model}. Weekly Italian paddy prices since 2015 from the{" "}
            {forecast.sources.map((s) => (
              <a key={s.url ?? s.file} className="underline underline-offset-2" href={s.url} target="_blank" rel="noreferrer">
                EU Agri-food Data Portal
              </a>
            ))}
            .
          </p>
          {bt.origins > 0 ? (
            <p>
              Backtest on {bt.origins} past dates: average error {eur(bt.mae_prophet_eur_t)}/t, against{" "}
              {eur(bt.mae_naive_eur_t)}/t for “price stays the same”. The range held the real price{" "}
              {bt.band_coverage_pct}% of the time.
            </p>
          ) : null}
          <p>{forecast.caveat}</p>
        </div>
      </details>
    </section>
  );
}
