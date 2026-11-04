/**
 * Parity with forecast_quality/demand.py. The expected numbers were produced by the Python module
 * on the same data/world/order_history.csv (python -c "from forecast_quality import demand; ...").
 */
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { forecast, isoWeek, monday, productionSuggestion, score, stockProjection } from "../agent/lib/forecast/demand";

describe("demand forecast (port of demand.py)", () => {
  it("scores the same as Python and beats same week last year", () => {
    const s = score();
    expect(s.wape_ours).toBeCloseTo(0.11294048507746303, 12);
    expect(s.wape_baseline).toBeCloseTo(0.16468487394957984, 12);
    expect(s.rows).toHaveLength(36);
    expect(s.rows[0]).toEqual({ gtin: "8000000000001", week: "2026-W33", actual: 5133, ours: 4837, same_week_last_year: 4629, promo: false });
    expect(s.rows.at(-1)).toEqual({ gtin: "8000000000049", week: "2026-W44", actual: 4248, ours: 4724, same_week_last_year: 4493, promo: false });
    expect(s.wape_ours).toBeLessThan(s.wape_baseline);
  });

  it("forecasts the same 8 weeks as Python", () => {
    const q = (g: string) => forecast(g, "2026-11-04", 8).map((f) => f.qty);
    expect(q("8000000000001")).toEqual([10003, 10414, 10072, 9779, 10398, 12309, 14039, 14171]);
    expect(q("8000000000000")).toEqual([16071, 16007, 15899, 16199, 17792, 20493, 22629, 22510]);
    expect(q("8000000000049")).toEqual([4877, 4749, 4720, 4753, 4890, 5826, 6361, 6744]);
    expect(forecast("8000000000000", "2026-11-04", 4, new Set(["2026-W46"])).map((f) => f.qty)).toEqual([16071, 19749, 15899, 16199]);
    expect(forecast("8000000000001", "2026-11-04", 1)[0].week).toBe("2026-W45");
  });

  it("projects stock and suggests a batch like Python", () => {
    const rows = stockProjection(freshErp(), "8000000000001", { start: "2026-11-04", weeks: 4 });
    expect(rows.map((r) => [r.week, r.opening, r.production, r.expected_orders, r.closing])).toEqual([
      ["2026-W45", 12000, 0, 10003, 1997],
      ["2026-W46", 1997, 4000, 10414, -4417],
      ["2026-W47", -4417, 0, 10072, -14489],
      ["2026-W48", -14489, 0, 9779, -24268],
    ]);
    expect(rows[1].sources).toEqual(["LOT-C-0419", "demand forecast"]);
    expect(productionSuggestion(rows)).toEqual({ short_from: "2026-W46", make_before: "2026-W46", qty: 24268, covers_weeks: 3, why: "projected stock -4,417 in 2026-W46" });
  });

  it("iso weeks and mondays", () => {
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
    expect(isoWeek("2026-12-28")).toBe("2026-W53");
    expect(monday("2026-11-08")).toBe("2026-11-02");
  });
});
