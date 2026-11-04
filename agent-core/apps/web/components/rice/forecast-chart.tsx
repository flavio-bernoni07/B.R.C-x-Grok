"use client";

import type { PriceForecast } from "@agent/lib/rice";
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { eur, shortDate } from "./format";

type Row = { date: string; price?: number; mean?: number; band?: [number, number] };

export function ForecastChart({
  forecast,
  historyWeeks = 104,
  height = 260,
}: {
  readonly forecast: PriceForecast;
  readonly historyWeeks?: number;
  readonly height?: number;
}) {
  const rows = useMemo<Row[]>(() => {
    const hist = forecast.history.slice(-historyWeeks).map((h) => ({ date: h.date, price: h.price }));
    const last = hist.at(-1);
    if (last) {
      // Join the forecast to the last observed price so the lines connect.
      Object.assign(last, { mean: last.price, band: [last.price, last.price] as [number, number] });
    }
    const future = forecast.forecast.map((f) => ({
      date: f.date,
      mean: f.mean,
      band: [f.lower, f.upper] as [number, number],
    }));
    return [...hist, ...future];
  }, [forecast, historyWeeks]);

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) =>
              new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" })
            }
            minTickGap={40}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={52}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => `€${Math.round(v)}`}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--popover-foreground)",
            }}
            labelFormatter={(d) => shortDate(String(d))}
            formatter={(value, name) => {
              if (Array.isArray(value)) return [`${eur(value[0] as number)} – ${eur(value[1] as number)}`, "80% band"];
              return [eur(value as number), name === "price" ? "Paddy price" : "Baseline"];
            }}
          />
          <ReferenceLine x={forecast.as_of} stroke="var(--muted-foreground)" strokeDasharray="2 4" />
          <Area
            dataKey="band"
            stroke="none"
            fill="var(--rice-band)"
            isAnimationActive={false}
            connectNulls
          />
          <Line
            dataKey="price"
            stroke="var(--rice-history)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            dataKey="mean"
            stroke="var(--rice-forecast)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
