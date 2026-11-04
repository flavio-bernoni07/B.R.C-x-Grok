/**
 * Logistics agent: shared trucks and shorter routes (OPS-WORKSPACE-PROMPT.md section 5B).
 *
 * - Inputs: orders confirmed or ready to ship, their delivery point and date, pallets and weight
 *   from the shipping row's `orderLoad`. Trucks of 33 pallets and 24 t.
 * - Consolidation: per delivery date, first-fit decreasing (pallets, then weight). A truck serves
 *   several delivery points only when every pair is within 40 km and their windows overlap. An
 *   order is never split.
 * - Route: nearest neighbour, then 2-opt, from and back to Pavia. Distance = straight line × 1.3.
 * - Cost: litres = km × 0.30; € = litres × diesel price (geo.json); CO2 = litres × 2.65 kg.
 * - Baseline: one truck per order, each a straight round trip.
 *
 * A plan only: it writes nothing. Real truck assignments go through the shipping row's planner.
 */
import { readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { isoDate } from "../core/stock";
import { dataPath } from "../paths";
import { orderLoad } from "../shipping/warehouse";

export const TRUCK_PALLETS = 33;
export const TRUCK_KG = 24_000;
export const SHARE_KM = 40;
export const ROAD_FACTOR = 1.3;
export const L_PER_KM = 0.3;
export const CO2_PER_L = 2.65;

type Point = { name: string; lat: number; lon: number };
export type Geo = {
  demo: boolean;
  plant: Point;
  delivery_points: Record<string, { town: string; lat: number; lon: number }>;
  diesel: { eur_per_litre: number; as_of: string; source: string; url?: string };
};
export const loadGeo = (): Geo => JSON.parse(readFileSync(dataPath("world", "geo.json"), "utf8")) as Geo;

export type LoadIn = {
  order_ref: string;
  retailer: string | null;
  delivery_point: string;
  date: string;
  window: [string, string] | null;
  pallets: number;
  weight_kg: number;
  demo?: boolean;
};

export type Totals = { trucks: number; km: number; litres: number; eur: number; co2_kg: number };
export type TruckPlan = {
  truck: string;
  date: string;
  orders: string[];
  pallets: number;
  weight_kg: number;
  stops: { name: string; km: number }[];
  km: number;
  litres: number;
  eur: number;
  co2_kg: number;
  note?: string;
};
export type LogisticsPlan = {
  trucks: TruckPlan[];
  baseline: Totals;
  savings: Totals;
  assumptions: string[];
  explanation: string;
  skipped: { order_ref: string; why: string }[];
  demo: boolean;
  scenario: boolean;
};

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Straight-line km (haversine) × 1.3: an estimate of road km. */
export function roadKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR;
}

const overlap = (a: [string, string] | null, b: [string, string] | null) => !a || !b || (a[0] <= b[1] && b[0] <= a[1]);

/** First-fit decreasing on pallets, then weight. Never splits an order. */
export function packTrucks(loads: LoadIn[], near: (a: string, b: string) => boolean): LoadIn[][] {
  const sorted = [...loads].sort((a, b) => b.pallets - a.pallets || b.weight_kg - a.weight_kg || a.order_ref.localeCompare(b.order_ref));
  const bins: LoadIn[][] = [];
  for (const o of sorted) {
    const bin = bins.find(
      (b) =>
        b.reduce((a, x) => a + x.pallets, 0) + o.pallets <= TRUCK_PALLETS &&
        b.reduce((a, x) => a + x.weight_kg, 0) + o.weight_kg <= TRUCK_KG &&
        b.every((x) => near(x.delivery_point, o.delivery_point) && overlap(x.window, o.window)),
    );
    if (bin) bin.push(o);
    else bins.push([o]);
  }
  return bins;
}

const tourKm = (tour: number[], d: (i: number, j: number) => number) => {
  let km = 0;
  for (let i = 0; i < tour.length - 1; i++) km += d(tour[i], tour[i + 1]);
  return km;
};

/** Nearest neighbour from the depot (index 0), back to the depot. */
export function nearestNeighbour(n: number, d: (i: number, j: number) => number): number[] {
  const left = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  const tour = [0];
  while (left.size) {
    const here = tour[tour.length - 1];
    let best = -1;
    for (const j of left) if (best < 0 || d(here, j) < d(here, best)) best = j;
    tour.push(best);
    left.delete(best);
  }
  tour.push(0);
  return tour;
}

/** 2-opt on a closed tour with fixed depot ends; only ever accepts a shorter tour. */
export function twoOpt(tour: number[], d: (i: number, j: number) => number): number[] {
  let best = [...tour];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        if (tourKm(cand, d) < tourKm(best, d) - 1e-9) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** Orders that could ship, with their load. Orders without coordinates or load data are skipped, with why. */
export function ordersToPlan(erp: Erp, geo: Geo): { loads: LoadIn[]; skipped: { order_ref: string; why: string }[] } {
  const loads: LoadIn[] = [];
  const skipped: { order_ref: string; why: string }[] = [];
  for (const o of erp.orders()) {
    if (!["confirmed", "ready_to_ship"].includes(o.status)) continue;
    const load = orderLoad(erp, o.orderRef);
    const retailer = erp.retailer(o.buyerGln);
    if (load.missing_data.length) {
      skipped.push({ order_ref: o.orderRef, why: `missing pallet or weight data for ${load.missing_data.join(", ")}` });
      continue;
    }
    if (!load.destination || !geo.delivery_points[load.destination]) {
      skipped.push({ order_ref: o.orderRef, why: `no coordinates for delivery point ${load.destination ?? "unknown"}` });
      continue;
    }
    const date = isoDate(o.deliveryDate) ?? load.window?.[0] ?? "no date";
    loads.push({ order_ref: o.orderRef, retailer: retailer?.name ?? null, delivery_point: load.destination, date, window: load.window, pallets: load.pallets, weight_kg: load.weight_kg });
  }
  return { loads, skipped };
}

/** Demo orders for the consolidation scenario. Never written to the database. */
export const SCENARIO_ORDERS: LoadIn[] = [
  { order_ref: "DEMO-CAR-01", retailer: "Carrefour Italia", delivery_point: "CeDi Carrefour Nord", date: "2026-11-06", window: null, pallets: 10, weight_kg: 9600, demo: true },
  { order_ref: "DEMO-AUC-01", retailer: "Auchan", delivery_point: "CeDi Auchan", date: "2026-11-06", window: null, pallets: 8, weight_kg: 7680, demo: true },
  { order_ref: "DEMO-ESS-01", retailer: "Esselunga", delivery_point: "CeDi Melzo", date: "2026-11-06", window: null, pallets: 12, weight_kg: 5800, demo: true },
  { order_ref: "DEMO-COOP-01", retailer: "Coop Italia", delivery_point: "CeDi Coop Nord", date: "2026-11-06", window: null, pallets: 14, weight_kg: 13440, demo: true },
  { order_ref: "DEMO-CON-01", retailer: "Conad Ancona", delivery_point: "CeDi Ancona", date: "2026-11-06", window: null, pallets: 6, weight_kg: 5760, demo: true },
  { order_ref: "DEMO-ESS-02", retailer: "Esselunga", delivery_point: "CeDi Melzo", date: "2026-11-09", window: null, pallets: 5, weight_kg: 4800, demo: true },
];

/** The plan from given loads (pure; the unit test uses it). */
export function planFromLoads(loads: LoadIn[], geo: Geo, opts: { scenario?: boolean; skipped?: { order_ref: string; why: string }[] } = {}): LogisticsPlan {
  const pt = (name: string) => geo.delivery_points[name];
  const near = (a: string, b: string) => a === b || roadKm(pt(a), pt(b)) <= SHARE_KM;
  const price = geo.diesel.eur_per_litre;
  const cost = (km: number) => {
    const litres = km * L_PER_KM;
    return { km: r1(km), litres: r1(litres), eur: r2(litres * price), co2_kg: r1(litres * CO2_PER_L) };
  };

  const byDate = new Map<string, LoadIn[]>();
  for (const l of loads) byDate.set(l.date, [...(byDate.get(l.date) ?? []), l]);
  const trucks: TruckPlan[] = [];
  for (const date of [...byDate.keys()].sort()) {
    for (const bin of packTrucks(byDate.get(date)!, near)) {
      const names = [...new Set(bin.map((o) => o.delivery_point))];
      const points = [geo.plant, ...names.map((n) => pt(n))];
      const d = (i: number, j: number) => roadKm(points[i], points[j]);
      const tour = twoOpt(nearestNeighbour(points.length, d), d);
      const stops = tour.slice(1).map((idx, i) => ({
        name: idx === 0 ? `${geo.plant.name} (back)` : `${names[idx - 1]}, ${pt(names[idx - 1]).town}`,
        km: r1(d(tour[i], idx)),
      }));
      const pallets = bin.reduce((a, o) => a + o.pallets, 0);
      const weight = bin.reduce((a, o) => a + o.weight_kg, 0);
      const over = pallets > TRUCK_PALLETS || weight > TRUCK_KG;
      trucks.push({
        truck: `Truck ${String(trucks.length + 1).padStart(2, "0")}`,
        date,
        orders: bin.map((o) => o.order_ref),
        pallets,
        weight_kg: r1(weight),
        stops,
        ...cost(tourKm(tour, d)),
        ...(over ? { note: "This order is larger than one truck. Splitting it needs a person's approval, so it is left whole here." } : {}),
      });
    }
  }
  const baseKm = loads.reduce((a, o) => a + 2 * roadKm(geo.plant, pt(o.delivery_point)), 0);
  const base = { trucks: loads.length, ...cost(baseKm) };
  const planKm = trucks.reduce((a, t) => a + t.km, 0);
  const plan = { trucks: trucks.length, ...cost(planKm) };
  // Truck km are rounded per truck; compute savings from the same rounded figures shown.
  const savings: Totals = {
    trucks: base.trucks - plan.trucks,
    km: r1(base.km - plan.km),
    litres: r1(base.litres - plan.litres),
    eur: r2(base.eur - plan.eur),
    co2_kg: r1(base.co2_kg - plan.co2_kg),
  };
  const shared = trucks.filter((t) => t.orders.length > 1);
  const explanation =
    loads.length === 0
      ? "There are no confirmed orders waiting to ship, so there is nothing to plan. Turn on the demo scenario to see how shared trucks would work."
      : shared.length === 0
        ? `There ${loads.length === 1 ? "is one order" : `are ${loads.length} orders`} to ship and no two can share a truck (different dates, far apart or too full), so there is nothing to consolidate. Each goes on its own truck, as in the baseline.`
        : `${shared.length} truck${shared.length > 1 ? "s" : ""} ${shared.length > 1 ? "carry" : "carries"} orders for nearby delivery points on the same day, so ${loads.length} orders need ${trucks.length} trucks instead of ${loads.length}. That saves about ${savings.km.toLocaleString("en-GB")} km, ${savings.litres.toLocaleString("en-GB")} litres of diesel, €${savings.eur.toLocaleString("en-GB")} and ${savings.co2_kg.toLocaleString("en-GB")} kg of CO2 (estimates).`;
  return {
    trucks,
    baseline: base,
    savings,
    assumptions: [
      `Trucks of ${TRUCK_PALLETS} pallets and ${TRUCK_KG / 1000} t. Orders are never split.`,
      `Delivery points share a truck only within ${SHARE_KM} km of each other, on the same delivery date, with overlapping windows.`,
      `Distances are an estimate: straight line × ${ROAD_FACTOR}, from demo coordinates (data/world/geo.json).`,
      `Fuel ${L_PER_KM * 100} L per 100 km (demo value); CO2 ${CO2_PER_L} kg per litre of diesel.`,
      `Diesel €${price}/L as of ${geo.diesel.as_of}: ${geo.diesel.source}`,
      "Baseline: one truck per order, a straight round trip from Pavia.",
      "A plan only: nothing is booked or dispatched from here.",
    ],
    explanation,
    skipped: opts.skipped ?? [],
    demo: geo.demo || !!opts.scenario,
    scenario: !!opts.scenario,
  };
}

/** The plan for the orders in the Mini ERP; with `scenario`, a few marked demo orders are added (not saved). */
export function logisticsPlan(erp: Erp, opts: { scenario?: boolean } = {}): LogisticsPlan {
  const geo = loadGeo();
  const { loads, skipped } = ordersToPlan(erp, geo);
  return planFromLoads(opts.scenario ? [...loads, ...SCENARIO_ORDERS] : loads, geo, { scenario: opts.scenario, skipped });
}
