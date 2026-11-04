/** Purchasing agent, "Paddy to buy": the worked example of OPS-WORKSPACE-PROMPT.md section 5A. */
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { decideSignoff, proposePurchase } from "../agent/lib/purchasing/decide";
import { type PriceInput, paddyRow, paddyToBuy } from "../agent/lib/purchasing/paddy";

const price = (mean: number, beats = true): PriceInput => ({
  variety: "Carnaroli",
  as_of: "2026-11-02",
  last_price: 672,
  forecast_end: { date: "2026-12-28", mean, lower: mean - 40, upper: mean + 40, change_pct: null },
  backtest: { origins: 17, mape_prophet_pct: 4.1, mape_naive_pct: 5.0, prophet_beats_naive: beats },
  sources: [{ name: "EU Agri-food Data Portal" }],
});

// need_milled 70 t -> need_paddy 100 t, weekly use 12.5 t; on hand 60 t; last price €672/t.
const example = (p: PriceInput | null) =>
  paddyRow({ variety: "Carnaroli", confirmed_not_shipped_t: 70, forecast_t: 0, finished_released_t: 0, finished_planned_t: 0, silo_t: 40, contracted_not_delivered_t: 20, price: p });

describe("paddy to buy", () => {
  it("runs the worked example", () => {
    const now = example(price(700)); // +4.2%
    expect(now).toMatchObject({ need_milled_t: 70, need_paddy_t: 100, weekly_use_t: 12.5, on_hand_t: 60, cover_weeks: 4.8 });
    expect(now).toMatchObject({ call: "BUY NOW", target_weeks: 16, suggested_t: 98, spend_eur: 65856 });
    expect(example(price(680))).toMatchObject({ call: "BUY AS USUAL", suggested_t: 63, confidence: "ok" }); // +1.2%
    expect(example(price(650))).toMatchObject({ call: "WAIT", suggested_t: 28 }); // −3.3%
    const low = example(price(700, false));
    expect(low).toMatchObject({ call: "BUY AS USUAL", suggested_t: 63, confidence: "low" });
    expect(low.confidence_note).toContain("does not beat");
    expect(now.steps.length).toBeGreaterThan(8);
    expect(now.steps.every((s) => s.source)).toBe(true);
  });

  it("weekly use of 0 means nothing to buy", () => {
    const r = paddyRow({ variety: "Arborio", confirmed_not_shipped_t: 10, forecast_t: 0, finished_released_t: 30, finished_planned_t: 0, silo_t: 5, contracted_not_delivered_t: 0, price: price(700) });
    expect(r).toMatchObject({ call: "NOTHING TO BUY", suggested_t: 0, spend_eur: 0, cover_weeks: null });
  });

  it("builds every variety from the ERP and excludes Basmati; a proposal only records a decision", async () => {
    const erp = freshErp();
    const plan = await paddyToBuy(erp, { start: "2026-11-04", price: async () => price(700) });
    expect(plan.rows.map((r) => r.variety)).toEqual(["Arborio", "Carnaroli"]);
    expect(plan.excluded.map((e) => e.item_code)).toEqual(["BAS-500G"]);
    expect(plan.demo).toBe(true);
    const car = plan.rows.find((r) => r.variety === "Carnaroli")!;
    expect(car.finished_released_t).toBe(12);
    expect(car.finished_planned_t).toBe(4);
    expect(car.forecast_t).toBe(91.19); // the parity-tested CAR-1KG forecast, 8 weeks

    const first = proposePurchase(erp, plan, "Carnaroli");
    expect(first.created).toBe(true);
    expect(proposePurchase(erp, plan, "Carnaroli")).toMatchObject({ case_id: first.case_id, created: false });
    const so = erp.signoff(first.case_id)!;
    expect(so).toMatchObject({ row: "purchasing", kind: "purchase", status: "pending" });
    const res = await decideSignoff(erp, first.case_id, { approve: true, by: "Sara", reason: "prices rising" });
    expect(res.status).toBe("approved");
    expect(String(res.done)).toContain("Nothing was bought");
    expect(erp.auditLog(so.subjectRef).map((a) => a.action)).toContain("purchasing.approved");
  });
});
