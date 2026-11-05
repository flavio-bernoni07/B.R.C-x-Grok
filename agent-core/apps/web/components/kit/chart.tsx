"use client";

/**
 * The launch film's line chart (HeyHandy CRM "Results"): a smooth line over a soft Flex Green
 * area, light gridlines, quiet axis labels, and a hover readout with the exact values. An optional
 * dashed forecast continues the line with its band; markers label single points (a suggested batch,
 * a purchase) without adding bars. The y axis starts at zero unless `min` says otherwise.
 */
import { type ReactNode, useId, useMemo, useState } from "react";

export type ChartPoint = { x: string; y: number; label?: string };
export type ChartMarker = { index: number; label: string };

const W = 1000;

/** Catmull-Rom through the points as cubic Béziers: a smooth line that still passes every value. */
function smooth(pts: { x: number; y: number }[]): string {
  if (!pts.length) return "";
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Monotone cubic through the points (Fritsch–Carlson, as d3's curveMonotoneX): smooth, but never
 * overshoots, so a steep rise stays a clean rounded step instead of a wobble.
 */
function monotone(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (!n) return "";
  if (n < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const h = pts.slice(0, -1).map((p, i) => pts[i + 1].x - p.x);
  const m = pts.slice(0, -1).map((p, i) => (pts[i + 1].y - p.y) / (h[i] || 1));
  const t = pts.map((_, i) => {
    if (i === 0) return m[0];
    if (i === n - 1) return m[n - 2];
    const a = m[i - 1];
    const b = m[i];
    if (a * b <= 0) return 0;
    return (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / a + (h[i] + 2 * h[i - 1]) / b);
  });
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i] / 3;
    d += ` C${(pts[i].x + dx).toFixed(1)},${(pts[i].y + t[i] * dx).toFixed(1)} ${(pts[i + 1].x - dx).toFixed(1)},${(pts[i + 1].y - t[i + 1] * dx).toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

/** The next round number at or above v (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × a power of ten). */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => n <= x) ?? 10;
  return step * p;
}

export function LineChart({
  data,
  forecast,
  band,
  markers = [],
  height = 260,
  format = (v) => Math.round(v).toLocaleString("en-GB"),
  tick,
  min,
  xLabel = (x) => x,
  readout,
  jumps,
  ariaLabel,
}: {
  readonly data: ChartPoint[];
  /** Continues the line, dashed, after the last data point. */
  readonly forecast?: ChartPoint[];
  /** Lower and upper bound for each forecast point. */
  readonly band?: { lo: number; hi: number }[];
  readonly markers?: ChartMarker[];
  readonly height?: number;
  readonly format?: (v: number) => string;
  /** Axis tick text; defaults to `format`. */
  readonly tick?: (v: number) => string;
  /** Lower bound of the y axis (default 0). */
  readonly min?: number;
  readonly xLabel?: (x: string) => string;
  /** Extra lines in the hover readout for point i of the joined series. */
  readonly readout?: (i: number) => ReactNode;
  /**
   * What arrived at each data point (a batch made, paddy bought). When given, the line drops
   * straight from week to week and rises as a sharp vertical spike at the moment of the arrival.
   */
  readonly jumps?: number[];
  readonly ariaLabel: string;
}) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const all = useMemo(() => [...data, ...(forecast ?? [])], [data, forecast]);
  const L = 64;
  const R = 24;
  const T = 26;
  const B = 34;
  const H = height;
  const values = [...all.map((p) => p.y), ...(band ?? []).flatMap((b) => [b.lo, b.hi])];
  const lo = min ?? 0;
  const hi = niceMax(Math.max(...values, lo + 1) - lo) + lo;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(all.length - 1, 1);
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo || 1);
  const dataPts = data.map((p, i) => ({ x: x(i), y: y(p.y) }));
  const fcPts = forecast?.length ? [dataPts[dataPts.length - 1], ...forecast.map((p, i) => ({ x: x(data.length + i), y: y(p.y) }))].filter(Boolean) : [];
  // With jumps the line falls week to week and climbs steeply in the few days before stock arrives
  // (the foot sits a quarter of a week earlier), drawn as one smooth monotone curve.
  const step = dataPts.length > 1 ? dataPts[1].x - dataPts[0].x : 0;
  const line = jumps
    ? monotone(
        dataPts.flatMap((p, i) => {
          const j = jumps[i] ?? 0;
          return j > 0 && i > 0 ? [{ x: p.x - step * 0.25, y: y(Math.max(data[i].y - j, lo)) }, p] : [p];
        }),
      )
    : smooth(dataPts);
  const area = dataPts.length ? `${line} L${dataPts[dataPts.length - 1].x.toFixed(1)},${y(lo).toFixed(1)} L${dataPts[0].x.toFixed(1)},${y(lo).toFixed(1)} Z` : "";
  const bandPath =
    band?.length && forecast?.length
      ? [
          ...band.map((b, i) => `${i ? "L" : "M"}${x(data.length + i).toFixed(1)},${y(b.hi).toFixed(1)}`),
          ...[...band].reverse().map((b, i) => `L${x(data.length + band.length - 1 - i).toFixed(1)},${y(b.lo).toFixed(1)}`),
          "Z",
        ].join(" ")
      : "";
  const ticks = [lo, (lo + hi) / 2, hi];
  const every = Math.max(1, Math.ceil(all.length / 7));
  const tickText = tick ?? format;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (W - L - R);
    setHover(Math.max(0, Math.min(all.length - 1, Math.round((px / (W - L - R)) * (all.length - 1)))));
  };
  const hp = hover != null ? all[hover] : null;
  const leftPct = hover != null ? (x(hover) / W) * 100 : 0;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#bfff80" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#bfff80" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="rgb(32 49 25 / 0.07)" />
            <text x={L - 12} y={y(t) + 4} textAnchor="end" fontSize="13" fill="rgb(32 49 25 / 0.62)">
              {tickText(t)}
            </text>
          </g>
        ))}
        {bandPath ? <path d={bandPath} fill="#bfff80" opacity="0.3" /> : null}
        <path d={area} fill={`url(#a${id})`} />
        <path d={line} fill="none" stroke="#559646" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
        {fcPts.length > 1 ? <path d={smooth(fcPts)} fill="none" stroke="#559646" strokeWidth="2.4" strokeDasharray="6 6" strokeLinecap="round" /> : null}
        {markers.map((m) => {
          const p = all[m.index];
          if (!p) return null;
          const w = m.label.length * 7.4 + 18;
          return (
            <g key={m.index}>
              <circle cx={x(m.index)} cy={y(p.y)} r="5" fill="#203119" stroke="#f9f9f9" strokeWidth="2" />
              <rect x={x(m.index) - w / 2} y={y(p.y) - 34} width={w} height="22" rx="11" fill="#203119" />
              <text x={x(m.index)} y={y(p.y) - 19} textAnchor="middle" fontSize="12.5" fontWeight="700" fill="#bfff80">
                {m.label}
              </text>
            </g>
          );
        })}
        {all.map((p, i) =>
          i % every === 0 || i === all.length - 1 ? (
            <text key={`${p.x}${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize="13" fill="rgb(32 49 25 / 0.62)">
              {xLabel(p.x)}
            </text>
          ) : null,
        )}
        {hover != null && hp ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={T - 6} y2={H - B} stroke="rgb(32 49 25 / 0.25)" />
            <circle cx={x(hover)} cy={y(hp.y)} r="5" fill="#f9f9f9" stroke="#203119" strokeWidth="2.2" />
          </g>
        ) : null}
        <rect x={L} y={0} width={W - L - R} height={H - B} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover != null && hp ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] -translate-x-1/2 rounded-[12px] bg-hh-dark px-3 py-2 text-[12px] text-hh-honeydew shadow-[0_12px_30px_-12px_rgb(32_49_25/0.6)]"
          style={{ left: `clamp(80px, ${leftPct}%, calc(100% - 80px))` }}
        >
          <div className="text-hh-honeydew/70">{xLabel(hp.x)}{hover >= data.length ? " · forecast" : ""}</div>
          <div className="font-bold text-[15px] tabular-nums text-white">{format(hp.y)}</div>
          {readout ? <div className="mt-0.5 space-y-0.5 tabular-nums text-hh-honeydew/85">{readout(hover)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
