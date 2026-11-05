/**
 * Suggested batches and paddy purchases, week by week: what to make (or buy), when, and how much.
 * Code only: it extends the weekly projection (demand.ts) with the batches a planner would add,
 * so the chart can show each suggestion as a spike and the stock it keeps above zero. A suggestion,
 * never an order: production and purchases are decided by people (Sign-off for paddy).
 */
import type { ProjectionRow } from "./demand";

export type PlanWeek = {
  week: string;
  /** Expected orders for the week (the demand forecast, an estimate). */
  demand: number;
  /** Batches already planned in the Mini ERP that land this week. */
  production: number;
  /** Confirmed orders not shipped (week one only). */
  confirmed: number;
  /** The batch code suggests making this week (0 when none). */
  suggested: number;
  /** Closing stock with no new batch (the projection as it is). */
  without: number;
  /** Closing stock with the suggested batches. */
  with: number;
};

export type ProductionPlan = { weeks: PlanWeek[]; batches: { week: string; qty: number }[]; coverWeeks: number; safetyWeeks: number; lot: number };

const roundUp = (x: number, lot: number) => Math.ceil(x / lot) * lot;

/**
 * Walk the weeks; when stock after this week's demand would fall under `safetyWeeks` of next week's
 * demand, a batch lands this week, big enough for `coverWeeks` of demand plus the safety stock,
 * rounded up to the production lot.
 */
export function productionPlan(rows: ProjectionRow[], opts: { coverWeeks?: number; safetyWeeks?: number; lot?: number } = {}): ProductionPlan {
  const coverWeeks = opts.coverWeeks ?? 4;
  const safetyWeeks = opts.safetyWeeks ?? 1;
  const lot = opts.lot ?? 1000;
  const weeks: PlanWeek[] = [];
  const batches: { week: string; qty: number }[] = [];
  let stock = rows[0]?.opening ?? 0;
  // Past the horizon, demand is taken as the average of the last four weeks, so the last batch is not cut short.
  const tail = rows.slice(-4);
  const after = tail.length ? tail.reduce((a, x) => a + x.expected_orders, 0) / tail.length : 0;
  const demandAt = (j: number) => rows[j]?.expected_orders ?? after;
  rows.forEach((r, k) => {
    const before = stock + r.production - r.confirmed_orders;
    const next = demandAt(k + 1);
    let suggested = 0;
    if (before - r.expected_orders < safetyWeeks * next) {
      let cover = 0;
      for (let j = k; j < k + coverWeeks; j++) cover += demandAt(j);
      const need = cover + safetyWeeks * next - before;
      suggested = need > 0 ? roundUp(need, lot) : 0;
      if (suggested) batches.push({ week: r.week, qty: suggested });
    }
    stock = before + suggested - r.expected_orders;
    weeks.push({ week: r.week, demand: r.expected_orders, production: r.production, confirmed: r.confirmed_orders, suggested, without: r.closing, with: stock });
  });
  return { weeks, batches, coverWeeks, safetyWeeks, lot };
}

export type PaddyWeek = { week: number; date: string; use: number; buy: number; stock: number };

/**
 * Paddy in the silos over the next weeks at this week's use: the purchasing agent's suggested
 * quantity bought now, and another lot whenever cover would fall under `safetyWeeks`, back up to
 * the target cover. Tonnes; a suggestion for the buyer.
 */
export function paddyPlan(
  row: { on_hand_t: number; weekly_use_t: number; target_weeks: number; suggested_t: number },
  opts: { start: string; weeks?: number; safetyWeeks?: number },
): PaddyWeek[] {
  const weeks = opts.weeks ?? 12;
  const safety = opts.safetyWeeks ?? 4;
  const out: PaddyWeek[] = [];
  let stock = row.on_hand_t;
  const t0 = new Date(`${opts.start}T00:00:00Z`).getTime();
  for (let k = 0; k < weeks; k++) {
    let buy = k === 0 ? row.suggested_t : 0;
    if (k > 0 && row.weekly_use_t > 0 && (stock - row.weekly_use_t) / row.weekly_use_t < safety) {
      buy = Math.max(0, Math.round((row.target_weeks * row.weekly_use_t - stock) * 10) / 10);
    }
    stock = Math.round((stock + buy - row.weekly_use_t) * 10) / 10;
    out.push({ week: k, date: new Date(t0 + k * 7 * 864e5).toISOString().slice(0, 10), use: row.weekly_use_t, buy, stock });
  }
  return out;
}
