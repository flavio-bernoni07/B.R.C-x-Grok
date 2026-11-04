/**
 * Purchasing agent, "Paddy to buy" (OPS-WORKSPACE-PROMPT.md section 5A). Per paddy variety: buy
 * now, buy as usual or wait, and how many tonnes to buy from farmers. Code does every figure; it
 * is a suggestion. A person signs every purchase, and nothing is ever bought by the app.
 *
 * Horizon H = 8 weeks:
 *   need_milled_t = max(0, confirmed_not_shipped_t + forecast_t − finished_released_t − finished_planned_t)
 *   need_paddy_t  = need_milled_t / MILLING_YIELD
 *   weekly_use_t  = need_paddy_t / H
 *   on_hand_t     = silo_t + contracted_not_delivered_t
 *   cover_weeks   = on_hand_t / weekly_use_t
 *   target_weeks  = 16 if BUY NOW, 8 if WAIT, 12 otherwise
 *   suggested_t   = FARMER_SHARE × max(0, target_weeks × weekly_use_t − on_hand_t)
 *   spend_eur     = suggested_t × last_price
 */
import { readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { batches, committedQty, todayIso } from "../core/stock";
import { ESTIMATE_LABEL, forecast as demandForecast } from "../forecast/demand";
import { dataPath } from "../paths";
import { getPriceForecast, type PriceForecast } from "../rice";

export const H = 8;
/** Tonnes of milled rice per tonne of paddy (demo value). */
export const MILLING_YIELD = 0.7;
/** Share of paddy bought from farmers (from Flavio, to confirm with the mentor). */
export const FARMER_SHARE = 0.7;
export const TARGET_WEEKS = { "BUY NOW": 16, WAIT: 8, "BUY AS USUAL": 12 } as const;
export const THRESHOLD_PCT = 2;
export const LOW_CONFIDENCE = "low confidence: the model does not beat 'price stays the same'";

export type Call = "BUY NOW" | "WAIT" | "BUY AS USUAL" | "NOTHING TO BUY";
export type PriceInput = Pick<PriceForecast, "variety" | "as_of" | "last_price" | "forecast_end" | "backtest" | "sources">;

export type PaddyData = {
  demo: boolean;
  as_of: string;
  varieties: { variety: string; silo_t: number; contracted_not_delivered_t: number }[];
  products: Record<string, { variety: string; kg_per_unit: number; excluded?: string }>;
};

export const loadPaddyData = (): PaddyData => JSON.parse(readFileSync(dataPath("world", "paddy.json"), "utf8")) as PaddyData;

export type Step = { step: string; value: string; source: string };

export type PaddyRow = {
  variety: string;
  call: Call;
  confidence: "ok" | "low" | "no price";
  confidence_note: string | null;
  confirmed_not_shipped_t: number;
  forecast_t: number;
  finished_released_t: number;
  finished_planned_t: number;
  need_milled_t: number;
  need_paddy_t: number;
  weekly_use_t: number;
  on_hand_t: number;
  silo_t: number;
  contracted_not_delivered_t: number;
  cover_weeks: number | null;
  target_weeks: number;
  suggested_t: number;
  spend_eur: number | null;
  price: {
    last: number;
    forecast: number;
    lower: number;
    upper: number;
    change_pct: number;
    forecast_date: string;
    mape_prophet_pct: number | null;
    mape_naive_pct: number | null;
    beats_naive: boolean;
    as_of: string;
    sources: PriceForecast["sources"];
  } | null;
  steps: Step[];
};

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The call from the price forecast alone. */
export function decideCall(price: PriceInput | null): { call: Exclude<Call, "NOTHING TO BUY">; confidence: PaddyRow["confidence"]; change_pct: number | null } {
  if (!price) return { call: "BUY AS USUAL", confidence: "no price", change_pct: null };
  const change = ((price.forecast_end.mean - price.last_price) / price.last_price) * 100;
  if (!price.backtest.prophet_beats_naive) return { call: "BUY AS USUAL", confidence: "low", change_pct: change };
  if (change > THRESHOLD_PCT) return { call: "BUY NOW", confidence: "ok", change_pct: change };
  if (change < -THRESHOLD_PCT) return { call: "WAIT", confidence: "ok", change_pct: change };
  return { call: "BUY AS USUAL", confidence: "ok", change_pct: change };
}

/** One variety, from tonnes already computed. Pure: the unit test runs the worked example on it. */
export function paddyRow(input: {
  variety: string;
  confirmed_not_shipped_t: number;
  forecast_t: number;
  finished_released_t: number;
  finished_planned_t: number;
  silo_t: number;
  contracted_not_delivered_t: number;
  price: PriceInput | null;
  sources?: { confirmed?: string; forecast?: string; stock?: string; supply?: string };
}): PaddyRow {
  const src = { confirmed: "confirmed orders not shipped (Mini ERP)", forecast: "demand forecast (estimate)", stock: "released and planned batches (Mini ERP)", supply: "data/world/paddy.json (demo data)", ...input.sources };
  const needMilled = Math.max(0, input.confirmed_not_shipped_t + input.forecast_t - input.finished_released_t - input.finished_planned_t);
  const needPaddy = needMilled / MILLING_YIELD;
  const weekly = needPaddy / H;
  const onHand = input.silo_t + input.contracted_not_delivered_t;
  const { call: priceCall, confidence, change_pct } = decideCall(input.price);
  const call: Call = weekly === 0 ? "NOTHING TO BUY" : priceCall;
  const target = TARGET_WEEKS[priceCall];
  const suggested = weekly === 0 ? 0 : r1(FARMER_SHARE * Math.max(0, target * weekly - onHand));
  const spend = input.price ? Math.round(suggested * input.price.last_price) : null;
  const p = input.price;
  const priceOut = p
    ? {
        last: p.last_price,
        forecast: p.forecast_end.mean,
        lower: p.forecast_end.lower,
        upper: p.forecast_end.upper,
        change_pct: r2(change_pct ?? 0),
        forecast_date: p.forecast_end.date,
        mape_prophet_pct: p.backtest.mape_prophet_pct ?? null,
        mape_naive_pct: p.backtest.mape_naive_pct ?? null,
        beats_naive: !!p.backtest.prophet_beats_naive,
        as_of: p.as_of,
        sources: p.sources,
      }
    : null;
  const t = (x: number) => `${r1(x).toLocaleString("en-GB")} t`;
  const priceSource = p?.sources?.[0]?.name ?? "paddy price forecast";
  const steps: Step[] = [
    { step: "Confirmed orders not shipped, as milled rice", value: t(input.confirmed_not_shipped_t), source: src.confirmed },
    { step: `Expected orders in the next ${H} weeks, as milled rice`, value: t(input.forecast_t), source: src.forecast },
    { step: "Finished rice released, minus", value: t(input.finished_released_t), source: src.stock },
    { step: "Planned production, minus", value: t(input.finished_planned_t), source: src.stock },
    { step: "Milled rice still needed", value: t(needMilled), source: "code: max(0, confirmed + expected − released − planned)" },
    { step: `Paddy needed (milling yield ${MILLING_YIELD * 100}%, demo value)`, value: t(needPaddy), source: "code: milled ÷ milling yield" },
    { step: `Paddy used per week (over ${H} weeks)`, value: t(weekly), source: "code: paddy needed ÷ 8" },
    { step: "Paddy on hand: silos + contracted not delivered", value: `${t(input.silo_t)} + ${t(input.contracted_not_delivered_t)} = ${t(onHand)}`, source: src.supply },
    { step: "Cover now", value: weekly === 0 ? "no use expected" : `${r1(onHand / weekly)} weeks`, source: "code: on hand ÷ weekly use" },
    {
      step: "Price outlook",
      value: p
        ? `€${p.last_price}/t now, €${p.forecast_end.mean}/t on ${p.forecast_end.date} (${change_pct! >= 0 ? "+" : ""}${r1(change_pct!)}%)`
        : "not available",
      source: p ? `Prophet price forecast, ${priceSource}` : "the price forecaster did not answer",
    },
    {
      step: "The call",
      value:
        call === "NOTHING TO BUY"
          ? "nothing to buy: no paddy use expected"
          : confidence === "low"
            ? `BUY AS USUAL, ${LOW_CONFIDENCE}`
            : confidence === "no price"
              ? "BUY AS USUAL, no price forecast available"
              : `${call}: change ${change_pct! > THRESHOLD_PCT ? "above +2%" : change_pct! < -THRESHOLD_PCT ? "below −2%" : "within ±2%"}`,
      source: p ? `backtest: model error ${p.backtest.mape_prophet_pct ?? "?"}% against ${p.backtest.mape_naive_pct ?? "?"}% for 'price stays the same'` : "rule",
    },
    {
      step: `Suggested from farmers (target ${target} weeks, farmer share ${FARMER_SHARE * 100}%)`,
      value: t(suggested),
      source: "code: farmer share × max(0, target weeks × weekly use − on hand)",
    },
    { step: "Estimated spend", value: spend == null ? "not estimated without a price" : `€${spend.toLocaleString("en-GB")}`, source: "code: suggested × last price" },
  ];
  return {
    variety: input.variety,
    call,
    confidence,
    confidence_note: confidence === "low" ? LOW_CONFIDENCE : confidence === "no price" ? "No price forecast: the usual 12 weeks target is used." : null,
    confirmed_not_shipped_t: r2(input.confirmed_not_shipped_t),
    forecast_t: r2(input.forecast_t),
    finished_released_t: r2(input.finished_released_t),
    finished_planned_t: r2(input.finished_planned_t),
    need_milled_t: r2(needMilled),
    need_paddy_t: r2(needPaddy),
    weekly_use_t: r2(weekly),
    on_hand_t: r2(onHand),
    silo_t: input.silo_t,
    contracted_not_delivered_t: input.contracted_not_delivered_t,
    cover_weeks: weekly === 0 ? null : r1(onHand / weekly),
    target_weeks: target,
    suggested_t: suggested,
    spend_eur: spend,
    price: priceOut,
    steps,
  };
}

export type PaddyPlan = {
  as_of: string;
  horizon_weeks: number;
  demo: boolean;
  rows: PaddyRow[];
  excluded: { item_code: string; variety: string; why: string }[];
  assumptions: string[];
};

/** Every variety from the Mini ERP, the demand forecast, the price forecast and the demo silo data. */
export async function paddyToBuy(
  erp: Erp,
  opts: { start?: string; price?: (variety: string) => Promise<PriceInput | null> } = {},
): Promise<PaddyPlan> {
  const data = loadPaddyData();
  const start = opts.start ?? todayIso();
  const price = opts.price ?? ((v: string) => getPriceForecast(v, H).catch(() => null));
  const products = erp.products();
  const excluded: PaddyPlan["excluded"] = [];
  const tonnes: Record<string, { confirmed: number; forecast: number; released: number; planned: number }> = {};
  for (const p of products) {
    const map = data.products[p.itemCode];
    if (!map) continue;
    if (map.excluded) {
      excluded.push({ item_code: p.itemCode, variety: map.variety, why: map.excluded });
      continue;
    }
    const tt = (tonnes[map.variety] ??= { confirmed: 0, forecast: 0, released: 0, planned: 0 });
    const toT = (units: number) => (units * map.kg_per_unit) / 1000;
    tt.confirmed += toT(committedQty(erp, p.gtin));
    tt.forecast += toT(demandForecast(p.gtin, start, H).reduce((a, f) => a + f.qty, 0));
    tt.released += toT(batches(erp, p.gtin, "released").reduce((a, b) => a + b.qty, 0));
    tt.planned += toT(batches(erp, p.gtin, "planned").reduce((a, b) => a + b.qty, 0));
  }
  const rows = await Promise.all(
    data.varieties.map(async (v) => {
      const tt = tonnes[v.variety] ?? { confirmed: 0, forecast: 0, released: 0, planned: 0 };
      return paddyRow({
        variety: v.variety,
        confirmed_not_shipped_t: tt.confirmed,
        forecast_t: tt.forecast,
        finished_released_t: tt.released,
        finished_planned_t: tt.planned,
        silo_t: v.silo_t,
        contracted_not_delivered_t: v.contracted_not_delivered_t,
        price: await price(v.variety),
      });
    }),
  );
  return {
    as_of: data.as_of,
    horizon_weeks: H,
    demo: data.demo,
    rows,
    excluded,
    assumptions: [
      `Silo and contracted tonnes are demo data (data/world/paddy.json, as of ${data.as_of}).`,
      `Milling yield ${MILLING_YIELD * 100}% is a demo value; farmer share ${FARMER_SHARE * 100}% is to be confirmed.`,
      `Expected orders: ${ESTIMATE_LABEL} Only ARB-1KG, CAR-1KG and RSP-FUNGHI-210 have a history.`,
      "Product to variety and rice kg per unit are demo mappings.",
      "A suggestion only: a person signs every purchase and nothing is bought by the app.",
    ],
  };
}
