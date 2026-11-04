/**
 * Demand forecast per product and week, and the weekly stock projection (port of
 * forecast_quality/demand.py, one to one).
 *
 * The order history is invented (data/world/order_history.csv): risotto rice peaks in winter,
 * flyer weeks sell more, August is slow, Christmas week is busy. It shows the pipeline works; it
 * proves nothing about accuracy on Riso Scotti's real orders. Every number here is an estimate.
 *
 * Forecast = recent level x last year's seasonal shape x a promo uplift learned from past flyer
 * weeks. Baseline = same week last year. Both are scored on the last 12 weeks, each forecast made
 * with only the weeks before it.
 *
 * Python's `make_history` (seeded random) is not ported: the CSV is the shared fixture.
 */
import { readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { batches, committedQty } from "../core/stock";
import { dataPath } from "../paths";
import { pyRound } from "../shipping/format";

export const PRODUCTS: Record<string, [string, number]> = {
  "8000000000001": ["CAR-1KG", 9000],
  "8000000000000": ["ARB-1KG", 12000],
  "8000000000049": ["RSP-FUNGHI-210", 4000],
};

export const ESTIMATE_LABEL = "Estimate built on invented order history (demo data), not on Riso Scotti's real orders.";

export type Week = { week_start: string; qty: number; promo: boolean };
export type History = Record<string, Week[]>;

const DAY = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => toIso(new Date(toDate(iso).getTime() + days * DAY));
const addWeeks = (iso: string, weeks: number) => addDays(iso, weeks * 7);

export function isoWeek(iso: string): string {
  const d = toDate(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(d.getTime() + (3 - dow) * DAY);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function monday(iso: string): string {
  const d = toDate(iso.slice(0, 10));
  return addDays(toIso(d), -((d.getUTCDay() + 6) % 7));
}

let cached: History | null = null;

export function loadHistory(path = dataPath("world", "order_history.csv")): History {
  if (cached && path === dataPath("world", "order_history.csv")) return cached;
  const [head, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const at = (name: string) => cols.indexOf(name);
  const out: History = {};
  for (const line of lines) {
    const f = line.split(",");
    (out[f[at("gtin")]] ??= []).push({ week_start: f[at("week_start")], qty: Number(f[at("qty")]), promo: f[at("promo")] === "1" });
  }
  cached = out;
  return out;
}

function uplift(past: Week[]): number {
  const promo = past.filter((p) => p.promo).map((p) => p.qty);
  const normal = past.filter((p) => !p.promo).map((p) => p.qty);
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  return promo.length && normal.length ? sum(promo) / promo.length / (sum(normal) / normal.length) : 1.0;
}

/** Recent level x seasonal shape from last year x promo uplift. Uses only `past`. */
export function forecastWeek(past: Week[], target: string, opts: { promo?: boolean } = {}): number {
  const byWeek = new Map(past.map((p) => [p.week_start, p]));
  const up = uplift(past);
  const clean = (p: Week) => (p.promo ? p.qty / up : p.qty);
  const recent = past.slice(-8);
  const ly = recent.map((w) => byWeek.get(addWeeks(w.week_start, -52)));
  const ratios: number[] = [];
  recent.forEach((r, i) => {
    const l = ly[i];
    if (l) ratios.push(clean(r) / clean(l));
  });
  const levelRatio = ratios.length ? ratios.reduce((a, x) => a + x, 0) / ratios.length : 1.0;
  const lastYear = byWeek.get(addWeeks(target, -52));
  let base: number;
  if (lastYear === undefined) {
    base = recent.reduce((a, p) => a + clean(p), 0) / recent.length;
  } else {
    const neigh = [-1, 0, 1].map((k) => byWeek.get(addWeeks(target, -(52 + k)))).filter((n): n is Week => !!n);
    base = (neigh.reduce((a, n) => a + clean(n), 0) / neigh.length) * levelRatio;
  }
  return base * (opts.promo ? up : 1.0);
}

export type ScoreRow = { gtin: string; week: string; actual: number; ours: number; same_week_last_year: number; promo: boolean };

export function score(history?: History | null, testWeeks = 12): { rows: ScoreRow[]; wape_ours: number; wape_baseline: number } {
  const h = history ?? loadHistory();
  const rows: ScoreRow[] = [];
  let oursErr = 0;
  let baseErr = 0;
  let total = 0;
  for (const [gtin, series] of Object.entries(h)) {
    for (let i = series.length - testWeeks; i < series.length; i++) {
      const past = series.slice(0, i);
      const actual = series[i];
      const ly = new Map(past.map((p) => [p.week_start, p.qty])).get(addWeeks(actual.week_start, -52));
      if (ly === undefined) continue;
      const ours = forecastWeek(past, actual.week_start, { promo: actual.promo });
      oursErr += Math.abs(ours - actual.qty);
      baseErr += Math.abs(ly - actual.qty);
      total += actual.qty;
      rows.push({ gtin, week: isoWeek(actual.week_start), actual: actual.qty, ours: pyRound(ours), same_week_last_year: ly, promo: actual.promo });
    }
  }
  return { rows, wape_ours: oursErr / total, wape_baseline: baseErr / total };
}

export function forecast(gtin: string, start: string, weeks = 8, promoWeeks?: Set<string> | null): { week: string; qty: number }[] {
  const series = loadHistory()[gtin];
  if (!series) return [];
  const m = monday(start);
  const past = series.filter((p) => p.week_start < m);
  const out: { week: string; qty: number }[] = [];
  for (let k = 0; k < weeks; k++) {
    const wk = addWeeks(m, k);
    out.push({ week: isoWeek(wk), qty: pyRound(forecastWeek(past, wk, { promo: promoWeeks?.has(isoWeek(wk)) ?? false })) });
  }
  return out;
}

export type ProjectionRow = {
  week: string;
  opening: number;
  production: number;
  confirmed_orders: number;
  expected_orders: number;
  closing: number;
  held: number;
  available_to_promise: number;
  sources: string[];
};

/**
 * What we can promise per week: stock + production due - confirmed orders - expected orders.
 * Confirmed orders not shipped count in the first week; held batches never count.
 */
export function stockProjection(erp: Erp, gtin: string, opts: { start: string; weeks?: number; promoWeeks?: Set<string> | null }): ProjectionRow[] {
  const weeks = opts.weeks ?? 8;
  const released = batches(erp, gtin, "released").reduce((a, b) => a + b.qty, 0);
  const held = batches(erp, gtin, "hold").reduce((a, b) => a + b.qty, 0);
  const planned = batches(erp, gtin, "planned");
  const expected = new Map(forecast(gtin, opts.start, weeks, opts.promoWeeks).map((f) => [f.week, f.qty]));
  const rows: ProjectionRow[] = [];
  let stock = released;
  for (let k = 0; k < weeks; k++) {
    const label = isoWeek(addWeeks(monday(opts.start), k));
    const due = planned.filter((b) => b.availableFrom && isoWeek(b.availableFrom) === label);
    const production = due.reduce((a, b) => a + b.qty, 0);
    const confirmed = k === 0 ? committedQty(erp, gtin) : 0;
    const demand = expected.get(label) ?? 0;
    const opening = stock;
    stock = opening + production - confirmed - demand;
    rows.push({
      week: label,
      opening,
      production,
      confirmed_orders: confirmed,
      expected_orders: demand,
      closing: stock,
      held,
      available_to_promise: Math.max(stock, 0),
      sources: [...due.map((b) => b.batch), ...(confirmed ? ["confirmed orders"] : []), "demand forecast"],
    });
  }
  return rows;
}

/**
 * Predictive planning: the first week the projection goes short, and how much to make before it
 * to cover that week and the next ones. A suggestion for the planner, never an order.
 */
export function productionSuggestion(rows: ProjectionRow[], coverWeeks = 4) {
  const i = rows.findIndex((r) => r.closing < 0);
  if (i < 0) return null;
  const short = rows[i];
  const need =
    rows.slice(i, i + coverWeeks).reduce((a, r) => a + r.expected_orders, 0) -
    Math.max(rows[i].opening + rows[i].production - rows[i].confirmed_orders, 0);
  return {
    short_from: short.week,
    make_before: rows[i].week,
    qty: pyRound(Math.max(need, 0)),
    covers_weeks: Math.min(coverWeeks, rows.length - i),
    why: `projected stock ${Math.round(short.closing).toLocaleString("en-US")} in ${short.week}`,
  };
}
