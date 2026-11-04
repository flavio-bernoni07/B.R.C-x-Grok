/** Logistics agent: shared trucks and shorter routes (OPS-WORKSPACE-PROMPT.md section 5B). */
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import {
  type LoadIn,
  loadGeo,
  logisticsPlan,
  nearestNeighbour,
  packTrucks,
  planFromLoads,
  roadKm,
  SCENARIO_ORDERS,
  twoOpt,
} from "../agent/lib/logistics/plan";

const load = (ref: string, pallets: number, kg: number, point = "CeDi Melzo", date = "2026-11-06"): LoadIn => ({
  order_ref: ref,
  retailer: null,
  delivery_point: point,
  date,
  window: null,
  pallets,
  weight_kg: kg,
});

describe("logistics plan", () => {
  it("packs first-fit decreasing on pallets, never splitting an order", () => {
    const loads = [load("A", 10, 1000), load("B", 20, 1000), load("C", 15, 1000), load("D", 13, 1000), load("E", 40, 1000)];
    const bins = packTrucks(loads, () => true);
    expect(bins.map((b) => b.map((o) => o.order_ref))).toEqual([["E"], ["B", "D"], ["C", "A"]]);
    expect(bins.flat().map((o) => o.order_ref).sort()).toEqual(["A", "B", "C", "D", "E"]);
    // weight also bounds a truck
    expect(packTrucks([load("H1", 5, 20000), load("H2", 5, 10000)], () => true)).toHaveLength(2);
    // far apart points never share
    expect(packTrucks([load("X", 5, 100), load("Y", 5, 100, "CeDi Ancona")], () => false)).toHaveLength(2);
  });

  it("2-opt is never longer than nearest neighbour", () => {
    const pts = Array.from({ length: 9 }, (_, i) => ({ lat: 45 + Math.sin(i * 7.3) * 0.8, lon: 9 + Math.cos(i * 3.1) * 1.2 }));
    const d = (i: number, j: number) => roadKm(pts[i], pts[j]);
    const len = (t: number[]) => t.slice(1).reduce((a, x, i) => a + d(t[i], x), 0);
    const nn = nearestNeighbour(pts.length, d);
    const best = twoOpt(nn, d);
    expect(best[0]).toBe(0);
    expect(best.at(-1)).toBe(0);
    expect(new Set(best).size).toBe(pts.length);
    expect(len(best)).toBeLessThanOrEqual(len(nn) + 1e-9);
  });

  it("the demo scenario shares trucks for nearby points and saves km, never negative", () => {
    const plan = planFromLoads(SCENARIO_ORDERS, loadGeo(), { scenario: true });
    expect(plan.demo).toBe(true);
    const all = plan.trucks.flatMap((t) => t.orders);
    expect(all.sort()).toEqual(SCENARIO_ORDERS.map((o) => o.order_ref).sort()); // each order once, whole
    expect(plan.trucks.every((t) => t.pallets <= 33 && t.weight_kg <= 24000)).toBe(true);
    expect(plan.trucks.length).toBeLessThan(SCENARIO_ORDERS.length);
    expect(plan.trucks.some((t) => t.orders.includes("DEMO-COOP-01") && t.orders.includes("DEMO-CON-01"))).toBe(false);
    for (const k of ["trucks", "km", "litres", "eur", "co2_kg"] as const) expect(plan.savings[k]).toBeGreaterThanOrEqual(0);
    expect(plan.savings.km).toBeGreaterThan(0);
    const t = plan.trucks[0];
    expect(t.litres).toBeCloseTo(t.km * 0.3, 0);
    expect(t.co2_kg).toBeCloseTo(t.litres * 2.65, 0);
    expect(t.stops.at(-1)!.name).toContain("Pavia");
  });

  it("with one order or none there is nothing to consolidate", () => {
    const one = planFromLoads([load("ONLY", 5, 4800)], loadGeo());
    expect(one.trucks).toHaveLength(1);
    expect(one.savings).toMatchObject({ trucks: 0, km: 0 });
    expect(one.explanation).toContain("nothing to consolidate");
    const empty = logisticsPlan(freshErp());
    expect(empty.trucks).toEqual([]);
    expect(empty.explanation).toContain("nothing to plan");
  });
});
