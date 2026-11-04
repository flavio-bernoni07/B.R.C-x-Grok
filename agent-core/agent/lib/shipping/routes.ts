/**
 * The logistics agent: which orders share a truck, in which order the truck drives, and what it saves.
 *
 * Today every order gets its own truck (`planTruckLoads`: first truck that fits, one manifest per
 * order). Here code plans the whole dispatch day at once:
 *
 * 1. Orders for the same delivery point become one stop (the same warehouse gets one truck).
 * 2. Every way of grouping the stops into trucks is tried, and for each group the shortest
 *    stop order (exact: Held-Karp over the subsets, then the best partition). That is fine
 *    for a day's stops (up to 12); beyond that the planner refuses rather than guess.
 * 3. A group is allowed only if it fits one truck (33 pallets, 24,000 kg), every retailer
 *    still gets its goods on the ship date (driving to the last stop within the 9-hour daily
 *    limit), and grouping never adds a driver day to the longest trip it replaces.
 * 4. Km, driving time, litres and euros come from the road matrix, the fuel use and the diesel
 *    price in data/world/logistics.json; each figure keeps its source.
 *
 * Grok writes the briefing for the transport planner from the plan (every number in it must be
 * in the plan, or the answer is rejected), and the transport planner approves the plan in the
 * sign-off queue. Only then are trucks booked and manifests written (`applyDispatchPlan`).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Erp } from "../core/erp";
import { unknownNumbers } from "../core/checks";
import { requestSignoff } from "../core/signoff";
import { type Caller, chatJson, hasKey } from "../grok/client";
import { dataPath } from "../paths";
import { manifestForOrder, orderLoad, registerTrucks, run } from "./warehouse";

export type Json = Record<string, unknown>;

type Point = { id: string; name: string; kind: string; lat: number; lon: number; retailer?: string; town?: string; gln?: string };
export type Logistics = {
  built_on: string;
  points: Point[];
  matrix: { order: string[]; km: number[][]; minutes: number[][]; source: string; url: string };
  fleet: { trucks: { truck_id: string; plate: string }[]; pallet_capacity: number; max_payload_kg: number; source: string };
  fuel: { l_per_100km: number; source: string; url: string };
  diesel: { eur_per_l: number; week: string; source: string; url: string };
  co2: { kg_per_l: number; source: string };
  rules: { max_daily_driving_h: number; max_daily_driving_source: string; max_daily_driving_url: string; truck_speed_kmh: number; truck_speed_source: string };
};

export type Stop = {
  point: string;
  retailer: string | null;
  town: string | null;
  lat: number;
  lon: number;
  orders: string[];
  pallets: number;
  weight_kg: number;
  /** Driving minutes from the plant to this stop, along the route. */
  arrive_drive_min: number;
};

export type Route = {
  truck_id: string | null;
  plate: string | null;
  stops: Stop[];
  orders: string[];
  pallets: number;
  weight_kg: number;
  fill_pct: number;
  km: number;
  drive_min: number;
  driver_days: number;
  litres: number;
  fuel_eur: number;
  /** Estimate: litres × the CO2 factor in logistics.json. */
  co2_kg: number;
};

export type Totals = { trucks: number; km: number; drive_min: number; driver_days: number; litres: number; fuel_eur: number; co2_kg: number };

export type DispatchPlan = {
  ship_date: string;
  plant: { id: string; name: string; lat: number; lon: number };
  orders: string[];
  routes: Route[];
  /** Today's way: one truck per order, plant to the retailer and back. */
  baseline: Totals & { trips: { order_ref: string; point: string; km: number }[] };
  plan: Totals;
  saving: Totals & { km_pct: number; fuel_pct: number };
  unplanned: { order_ref: string; reason: string }[];
  /** Orders planned as if ready, though a person has not confirmed them yet (planRoutes `preview`). */
  preview: string[];
  checks: string[];
  sources: { what: string; source: string; url?: string }[];
};

export type Briefing = { summary: string; watch: string[]; by: "grok" | "grok (recorded)" | "code" };

export class RoutePlanError extends Error {}

const MAX_STOPS = 12;

export function loadLogistics(path?: string): Logistics {
  return JSON.parse(readFileSync(path ?? dataPath("world", "logistics.json"), "utf8")) as Logistics;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

class Roads {
  private idx: Map<string, number>;
  constructor(private lg: Logistics) {
    this.idx = new Map(lg.matrix.order.map((id, i) => [id, i]));
  }
  has(id: string | null | undefined) {
    return !!id && this.idx.has(id);
  }
  km(a: string, b: string) {
    return this.lg.matrix.km[this.idx.get(a)!][this.idx.get(b)!];
  }
  /** OSRM's car minutes, but never faster than a truck may legally average. */
  min(a: string, b: string) {
    const km = this.km(a, b);
    return Math.max(this.lg.matrix.minutes[this.idx.get(a)!][this.idx.get(b)!], Math.round((km / this.lg.rules.truck_speed_kmh) * 60));
  }
}

type Node = { point: Point; orders: string[]; pallets: number; weight_kg: number };

function fuelFor(lg: Logistics, km: number) {
  const litres = (km * lg.fuel.l_per_100km) / 100;
  return { litres: r1(litres), fuel_eur: r2(litres * lg.diesel.eur_per_l), co2_kg: Math.round(litres * lg.co2.kg_per_l) };
}

function driverDays(lg: Logistics, driveMin: number) {
  return Math.max(1, Math.ceil(driveMin / (lg.rules.max_daily_driving_h * 60)));
}

/** Held-Karp from the plant over every subset of nodes: shortest open path ending at each node. */
function bestRoutes(nodes: Node[], roads: Roads, plant: string) {
  const n = nodes.length;
  const full = 1 << n;
  const dp = Array.from({ length: full }, () => new Float64Array(n).fill(Infinity));
  const parent = Array.from({ length: full }, () => new Int8Array(n).fill(-1));
  for (let j = 0; j < n; j++) dp[1 << j][j] = roads.km(plant, nodes[j].point.id);
  for (let mask = 1; mask < full; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j)) || dp[mask][j] === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const next = mask | (1 << k);
        const cost = dp[mask][j] + roads.km(nodes[j].point.id, nodes[k].point.id);
        if (cost < dp[next][k]) {
          dp[next][k] = cost;
          parent[next][k] = j;
        }
      }
    }
  }
  // For each subset: the closed tour (back to the plant) and its stop order.
  const tours: { km: number; order: number[] }[] = new Array(full);
  for (let mask = 1; mask < full; mask++) {
    let best = Infinity;
    let last = -1;
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const c = dp[mask][j] + roads.km(nodes[j].point.id, plant);
      if (c < best - 1e-9) {
        best = c;
        last = j;
      }
    }
    const order: number[] = [];
    let m = mask;
    let j = last;
    while (j !== -1) {
      order.push(j);
      const p = parent[m][j];
      m &= ~(1 << j);
      j = p;
    }
    tours[mask] = { km: best, order: order.reverse() };
  }
  return tours;
}

function routeFrom(lg: Logistics, roads: Roads, plant: string, nodes: Node[], order: number[]): Route {
  const stops: Stop[] = [];
  let prev = plant;
  let km = 0;
  let min = 0;
  for (const i of order) {
    const nd = nodes[i];
    km += roads.km(prev, nd.point.id);
    min += roads.min(prev, nd.point.id);
    stops.push({
      point: nd.point.id,
      retailer: nd.point.retailer ?? null,
      town: nd.point.town ?? null,
      lat: nd.point.lat,
      lon: nd.point.lon,
      orders: [...nd.orders],
      pallets: nd.pallets,
      weight_kg: nd.weight_kg,
      arrive_drive_min: min,
    });
    prev = nd.point.id;
  }
  km += roads.km(prev, plant);
  min += roads.min(prev, plant);
  const pallets = stops.reduce((a, s) => a + s.pallets, 0);
  const weight = stops.reduce((a, s) => a + s.weight_kg, 0);
  return {
    truck_id: null,
    plate: null,
    stops,
    orders: stops.flatMap((s) => s.orders),
    pallets,
    weight_kg: r1(weight),
    fill_pct: Math.round((pallets / lg.fleet.pallet_capacity) * 100),
    km: r1(km),
    drive_min: min,
    driver_days: driverDays(lg, min),
    ...fuelFor(lg, km),
  };
}

function totals(routes: { km: number; drive_min: number; driver_days: number }[], lg: Logistics): Totals {
  const km = routes.reduce((a, r) => a + r.km, 0);
  return {
    trucks: routes.length,
    km: r1(km),
    drive_min: routes.reduce((a, r) => a + r.drive_min, 0),
    driver_days: routes.reduce((a, r) => a + r.driver_days, 0),
    ...fuelFor(lg, km),
  };
}

/** Orders Shipping holds that are ready to ship and not on a manifest yet. */
export function readyOrders(erp: Erp): string[] {
  return erp
    .orders()
    .filter((o) => o.status === "ready_to_ship" && !manifestForOrder(erp, o.orderRef))
    .map((o) => o.orderRef);
}

/** Clean orders a person has not confirmed yet, or confirmed but not yet handed to Shipping. */
export const PREVIEW_STATUSES = new Set(["awaiting_confirmation", "confirmed"]);

/**
 * Plan one dispatch day. Pure: reads the Mini ERP and the logistics file, writes nothing.
 *
 * `preview`: orders that are not ready to ship yet (still awaiting confirmation, or confirmed and
 * not yet with Shipping) are planned as if they were, so a sign-off card can show "if you approve,
 * this order goes on this truck". They are listed in `plan.preview`; any other status stays unplanned.
 */
export function planRoutes(
  erp: Erp,
  opts: { shipDate: string; orderRefs?: string[]; preview?: string[]; logistics?: Logistics },
): DispatchPlan {
  const lg = opts.logistics ?? loadLogistics();
  const roads = new Roads(lg);
  const plantPoint = lg.points.find((p) => p.kind === "plant");
  if (!plantPoint) throw new RoutePlanError("logistics.json has no plant");
  const plant = plantPoint.id;
  const previewAsked = new Set(opts.preview ?? []);
  const refs = [...new Set([...(opts.orderRefs ?? readyOrders(erp)), ...previewAsked])];
  const unplanned: DispatchPlan["unplanned"] = [];
  const preview: string[] = [];
  const byPoint = new Map<string, Node[]>();

  for (const ref of refs) {
    const order = erp.order(ref);
    if (!order) {
      unplanned.push({ order_ref: ref, reason: "no such order" });
      continue;
    }
    const previewing = previewAsked.has(ref) && PREVIEW_STATUSES.has(order.status ?? "");
    if (order.status !== "ready_to_ship" && !previewing) {
      unplanned.push({ order_ref: ref, reason: `not ready to ship (${String(order.status ?? "no status").replace(/_/g, " ")})` });
      continue;
    }
    if (previewing) preview.push(ref);
    if (manifestForOrder(erp, ref)) {
      unplanned.push({ order_ref: ref, reason: "already on a truck" });
      continue;
    }
    const load = orderLoad(erp, ref);
    if (load.missing_data.length) {
      unplanned.push({ order_ref: ref, reason: `no pallet size or unit weight for ${load.missing_data.join(", ")}` });
      continue;
    }
    if (!roads.has(load.destination)) {
      unplanned.push({ order_ref: ref, reason: `no road distance for delivery point ${load.destination ?? "(none)"}` });
      continue;
    }
    if (load.pallets > lg.fleet.pallet_capacity || load.weight_kg > lg.fleet.max_payload_kg) {
      unplanned.push({ order_ref: ref, reason: `${load.pallets} pallets, ${load.weight_kg} kg: bigger than one truck, split the order first` });
      continue;
    }
    const point = lg.points.find((p) => p.id === load.destination)!;
    // Same delivery point: add to an open stop if the truck still has room, else start another one.
    const stops = byPoint.get(point.id) ?? [];
    const room = stops.find((s) => s.pallets + load.pallets <= lg.fleet.pallet_capacity && s.weight_kg + load.weight_kg <= lg.fleet.max_payload_kg);
    if (room) {
      room.orders.push(ref);
      room.pallets += load.pallets;
      room.weight_kg += load.weight_kg;
    } else {
      stops.push({ point, orders: [ref], pallets: load.pallets, weight_kg: load.weight_kg });
    }
    byPoint.set(point.id, stops);
  }

  const nodes = [...byPoint.values()].flat();
  if (nodes.length > MAX_STOPS) throw new RoutePlanError(`${nodes.length} stops: the exact planner takes up to ${MAX_STOPS}; split the day`);
  const planned = nodes.flatMap((n) => n.orders);

  const sources: DispatchPlan["sources"] = [
    { what: "road km and minutes", source: lg.matrix.source, url: lg.matrix.url },
    { what: "fuel use", source: `${lg.fuel.l_per_100km} l/100 km, ${lg.fuel.source}`, url: lg.fuel.url },
    { what: "diesel price", source: `€${lg.diesel.eur_per_l} per litre, week of ${lg.diesel.week}, ${lg.diesel.source}`, url: lg.diesel.url },
    { what: "CO2 (estimate)", source: `${lg.co2.kg_per_l} kg per litre, ${lg.co2.source}` },
    { what: "driving limit", source: lg.rules.max_daily_driving_source, url: lg.rules.max_daily_driving_url },
    { what: "truck speed", source: lg.rules.truck_speed_source },
    { what: "truck size", source: `${lg.fleet.pallet_capacity} pallets, ${lg.fleet.max_payload_kg} kg: ${lg.fleet.source}` },
    { what: "pallets and weight per order", source: "Mini ERP order lines × data/world/products.json (units per pallet, unit weight)" },
  ];
  const checks = [
    `each truck carries at most ${lg.fleet.pallet_capacity} pallets and ${lg.fleet.max_payload_kg} kg`,
    `every retailer is reached on the ship date: driving to the last stop stays within ${lg.rules.max_daily_driving_h} h`,
    "sharing a truck never adds a driver day to the longest trip it replaces",
    `drive times are never faster than ${lg.rules.truck_speed_kmh} km/h, the truck limit`,
  ];

  // Baseline: one truck per order, the way planTruckLoads books them today.
  const trips = planned.map((ref) => {
    const point = orderLoad(erp, ref).destination!;
    const km = roads.km(plant, point) + roads.km(point, plant);
    const min = roads.min(plant, point) + roads.min(point, plant);
    return { order_ref: ref, point, km: r1(km), drive_min: min, driver_days: driverDays(lg, min) };
  });
  const baseline = { ...totals(trips, lg), trips: trips.map(({ order_ref, point, km }) => ({ order_ref, point, km })) };

  let routes: Route[] = [];
  if (nodes.length) {
    const n = nodes.length;
    const tours = bestRoutes(nodes, roads, plant);
    const soloDays = nodes.map((_, i) => routeFrom(lg, roads, plant, nodes, [i]).driver_days);
    const feasible = new Map<number, Route>();
    for (let mask = 1; mask < 1 << n; mask++) {
      const members = nodes.map((_, i) => i).filter((i) => mask & (1 << i));
      const pallets = members.reduce((a, i) => a + nodes[i].pallets, 0);
      const weight = members.reduce((a, i) => a + nodes[i].weight_kg, 0);
      if (pallets > lg.fleet.pallet_capacity || weight > lg.fleet.max_payload_kg) continue;
      const route = routeFrom(lg, roads, plant, nodes, tours[mask].order);
      const lastArrive = route.stops[route.stops.length - 1].arrive_drive_min;
      if (lastArrive > lg.rules.max_daily_driving_h * 60) continue;
      if (route.driver_days > Math.max(...members.map((i) => soloDays[i]))) continue;
      feasible.set(mask, route);
    }
    // Best partition: least km, then fewest trucks.
    const full = (1 << n) - 1;
    const best: { km: number; trucks: number; pick: number }[] = new Array(full + 1);
    best[0] = { km: 0, trucks: 0, pick: 0 };
    for (let mask = 1; mask <= full; mask++) {
      const low = mask & -mask;
      let choice = { km: Infinity, trucks: Infinity, pick: 0 };
      for (let sub = mask; sub; sub = (sub - 1) & mask) {
        if (!(sub & low)) continue;
        const r = feasible.get(sub);
        const rest = best[mask ^ sub];
        if (!r || !rest || rest.km === Infinity) continue;
        const km = r.km + rest.km;
        const trucks = 1 + rest.trucks;
        if (km < choice.km - 1e-9 || (Math.abs(km - choice.km) < 1e-9 && trucks < choice.trucks)) choice = { km, trucks, pick: sub };
      }
      best[mask] = choice;
    }
    for (let mask = full; mask; mask ^= best[mask].pick) {
      if (!best[mask].pick) throw new RoutePlanError("no feasible plan for these stops");
      routes.push(feasible.get(best[mask].pick)!);
    }
    // Longest trips first get the first trucks of the fleet; any route beyond the fleet needs a carrier.
    routes = routes.sort((a, b) => b.km - a.km);
    routes.forEach((r, i) => {
      const t = lg.fleet.trucks[i];
      r.truck_id = t?.truck_id ?? null;
      r.plate = t?.plate ?? null;
    });
    if (routes.some((r) => !r.truck_id)) checks.push(`more routes than the ${lg.fleet.trucks.length} trucks in the fleet: book a carrier for the rest`);
  }

  const plan = totals(routes, lg);
  const saving = {
    trucks: baseline.trucks - plan.trucks,
    km: r1(baseline.km - plan.km),
    drive_min: baseline.drive_min - plan.drive_min,
    driver_days: baseline.driver_days - plan.driver_days,
    litres: r1(baseline.litres - plan.litres),
    fuel_eur: r2(baseline.fuel_eur - plan.fuel_eur),
    co2_kg: baseline.co2_kg - plan.co2_kg,
    km_pct: baseline.km ? Math.round(((baseline.km - plan.km) / baseline.km) * 100) : 0,
    fuel_pct: baseline.fuel_eur ? Math.round(((baseline.fuel_eur - plan.fuel_eur) / baseline.fuel_eur) * 100) : 0,
  };
  return {
    ship_date: opts.shipDate,
    plant: { id: plant, name: plantPoint.name, lat: plantPoint.lat, lon: plantPoint.lon },
    orders: planned,
    routes,
    baseline,
    plan,
    saving,
    unplanned,
    preview,
    checks,
    sources,
  };
}

const hhmm = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;

/** What code alone says about a plan (used when Grok is not available or its answer is rejected). */
export function codeBriefing(p: DispatchPlan): Briefing {
  const shared = p.routes.filter((r) => r.stops.length > 1 || r.orders.length > 1);
  const summary =
    `${p.orders.length} orders ship on ${p.ship_date} on ${p.plan.trucks} trucks instead of ${p.baseline.trucks}: ` +
    `${p.plan.km} km instead of ${p.baseline.km} (${p.saving.km_pct}% less), ${p.plan.litres} l of diesel instead of ${p.baseline.litres}, ` +
    `€${p.plan.fuel_eur} instead of €${p.baseline.fuel_eur}.` +
    (shared.length ? ` ${shared.map((r) => `${r.truck_id ?? "a carrier"} drives ${r.stops.map((s) => s.point).join(", ")}`).join("; ")}.` : "");
  const watch = [
    ...p.routes.filter((r) => r.driver_days > 1).map((r) => `${r.truck_id ?? "a carrier"} needs ${r.driver_days} driver days (${hhmm(r.drive_min)} of driving)`),
    ...p.unplanned.map((u) => `${u.order_ref} is not planned: ${u.reason}`),
  ];
  return { summary, watch, by: "code" };
}

/**
 * The plan as text, plus the usual ways of writing each of its figures (two decimals for euros,
 * rounded km, hours for minutes), so "€1,161.50" or "11.4 hours" pass but an invented figure does not.
 */
export function planFigures(p: DispatchPlan): string {
  const extra: string[] = [];
  const walk = (v: unknown, key = "") => {
    if (typeof v === "number") {
      extra.push(v.toFixed(2), v.toFixed(1), String(Math.round(v)));
      if (key.endsWith("_min")) extra.push((v / 60).toFixed(1), String(Math.floor(v / 60)), String(v % 60), String(Math.round(v / 60)));
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(p);
  return `${JSON.stringify(p)} ${extra.join(" ")}`;
}

/** Grok writes the planner's briefing; code rejects any figure that is not in the plan. */
export async function briefWithGrok(p: DispatchPlan, opts: { caller?: Caller | null; recorded?: boolean } = {}): Promise<Briefing> {
  const caller = opts.caller ?? null;
  if (caller === null && !hasKey()) return codeBriefing(p);
  const facts = JSON.stringify(p);
  const messages = [
    {
      role: "system" as const,
      content:
        "You are the logistics agent of the Riso Scotti back office. Code has already planned the trucks; you brief the " +
        "transport planner who approves the plan. Say in two or three sentences what the plan does and what it saves " +
        "against one truck per order, then list what the planner should watch (long trips, driver days, unplanned " +
        "orders). Use only numbers that appear in the plan. Return JSON: {\"summary\": string, \"watch\": [string]}.",
    },
    { role: "user" as const, content: facts },
  ];
  const validate = (payload: Json): string[] => {
    const problems: string[] = [];
    if (typeof payload.summary !== "string" || !payload.summary.trim()) problems.push("summary must be a non-empty string");
    if (!Array.isArray(payload.watch)) problems.push("watch must be a list of strings");
    const text = [payload.summary, ...((payload.watch as unknown[]) ?? [])].join(" ");
    const unknown = unknownNumbers(String(text), planFigures(p));
    if (unknown.size) problems.push(`these figures are not in the plan: ${[...unknown].join(", ")}`);
    return problems;
  };
  try {
    const payload = await chatJson(messages, { task: "shipping.dispatch_briefing", validate, caller });
    return { summary: String(payload.summary), watch: (payload.watch as unknown[]).map(String), by: opts.recorded ? "grok (recorded)" : "grok" };
  } catch {
    return codeBriefing(p);
  }
}

/** The recorded briefing for a demo ship date (data/world/dispatch/grok_recorded.json), if there is one. */
export function recordedCaller(shipDate: string): Caller | null {
  const path = dataPath("world", "dispatch", "grok_recorded.json");
  if (!existsSync(path)) return null;
  const answer = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[shipDate];
  return answer && typeof answer === "object" ? () => JSON.parse(JSON.stringify(answer)) : null;
}

export function dispatchSignoffs(erp: Erp, status?: string) {
  return erp.signoffs({ row: "shipping", status }).filter((s) => s.kind === "dispatch_plan");
}

/**
 * Plan the day, have Grok brief it and ask the transport planner. Returns the pending case if one
 * is already waiting for the same ship date (planning twice would book trucks twice).
 */
export async function proposeDispatchPlan(
  erp: Erp,
  opts: { shipDate: string; orderRefs?: string[]; caller?: Caller | null; recorded?: boolean; logistics?: Logistics },
): Promise<{ case_id: string; plan: DispatchPlan; briefing: Briefing; reused: boolean }> {
  const waiting = dispatchSignoffs(erp, "pending").find((s) => (s.proposal as Json | null)?.ship_date === opts.shipDate);
  if (waiting) {
    const pr = waiting.proposal as { plan: DispatchPlan; briefing: Briefing };
    return { case_id: waiting.caseId, plan: pr.plan, briefing: pr.briefing, reused: true };
  }
  const plan = planRoutes(erp, { shipDate: opts.shipDate, orderRefs: opts.orderRefs, logistics: opts.logistics });
  if (!plan.routes.length) throw new RoutePlanError(plan.unplanned.length ? `nothing to plan: ${plan.unplanned.map((u) => `${u.order_ref} ${u.reason}`).join("; ")}` : "no orders are ready to ship");
  // Live Grok with a key; without one, the recorded answer for a demo day; otherwise code alone.
  let caller = opts.caller;
  let recorded = opts.recorded ?? false;
  if (caller === undefined && !hasKey()) {
    caller = recordedCaller(opts.shipDate);
    recorded = caller !== null;
  }
  const briefing = await briefWithGrok(plan, { caller, recorded });
  erp.log(briefing.by === "code" ? "code" : "grok", "shipping.dispatch_planned", `DISPATCH-${opts.shipDate}`, {
    detail: { trucks: plan.plan.trucks, baseline_trucks: plan.baseline.trucks, km: plan.plan.km, baseline_km: plan.baseline.km, fuel_eur: plan.plan.fuel_eur, baseline_fuel_eur: plan.baseline.fuel_eur },
  });
  const reasons = ["Shipping rule: the transport planner approves every dispatch plan before trucks are booked"];
  if (plan.unplanned.length) reasons.push(`${plan.unplanned.length} order(s) could not be planned`);
  if (plan.routes.some((r) => !r.truck_id)) reasons.push("more routes than trucks in the fleet");
  const caseId = requestSignoff(erp, {
    row: "shipping",
    kind: "dispatch_plan",
    subjectRef: `DISPATCH-${opts.shipDate}`,
    title: `Dispatch ${opts.shipDate}: ${plan.plan.trucks} trucks instead of ${plan.baseline.trucks}, ${plan.saving.km} km less`,
    proposal: { ship_date: opts.shipDate, plan, briefing, role: "transport_planner" },
    reasons,
  });
  return { case_id: caseId, plan, briefing, reused: false };
}

/** After the transport planner approves: book the trucks and write one manifest per route. */
export function applyDispatchPlan(erp: Erp, caseId: string, by: string): { manifests: { manifest_id: string; truck_id: string; orders: string[] }[]; skipped: { order_ref: string; reason: string }[] } {
  const so = erp.signoff(caseId);
  if (!so || so.kind !== "dispatch_plan") throw new RoutePlanError(`${caseId} is not a dispatch plan`);
  if (so.status !== "approved") throw new RoutePlanError(`${caseId} is ${so.status}, not approved`);
  const plan = (so.proposal as { plan: DispatchPlan }).plan;
  const lg = loadLogistics();
  const out: { manifest_id: string; truck_id: string; orders: string[] }[] = [];
  const skipped: { order_ref: string; reason: string }[] = [];
  for (const r of plan.routes) {
    if (!r.truck_id) {
      skipped.push(...r.orders.map((o) => ({ order_ref: o, reason: "no truck in the fleet: book a carrier" })));
      continue;
    }
    // Orders that changed since the plan (shipped, cancelled, planned elsewhere) stay off the truck.
    const still = r.orders.filter((o) => erp.order(o)?.status === "ready_to_ship" && !manifestForOrder(erp, o));
    for (const o of r.orders.filter((x) => !still.includes(x))) skipped.push({ order_ref: o, reason: "changed since the plan" });
    if (!still.length) continue;
    const stops = r.stops.filter((s) => s.orders.some((o) => still.includes(o))).map((s) => s.point);
    registerTrucks(erp, [
      {
        truck_id: r.truck_id,
        plate: r.plate ?? undefined,
        destination: stops[0],
        compatible_routes: stops,
        pallet_capacity: lg.fleet.pallet_capacity,
        max_payload_kg: lg.fleet.max_payload_kg,
        window: [plan.ship_date, plan.ship_date],
      },
    ]);
    const manifestId = erp.nextId("si_manifest", "MAN-");
    const loads = still.map((o) => orderLoad(erp, o));
    const data = {
      orders: still,
      pallets: loads.reduce((a, l) => a + l.pallets, 0),
      weight_kg: r1(loads.reduce((a, l) => a + l.weight_kg, 0)),
      destinations: stops,
      physically_loaded: false,
      dispatched: false,
      route: { ship_date: plan.ship_date, km: r.km, drive_min: r.drive_min, litres: r.litres, fuel_eur: r.fuel_eur, plan_case: caseId },
    };
    run(erp, "INSERT INTO si_manifests(manifest_id, truck_id, status, data) VALUES(?,?,?,?)", manifestId, r.truck_id, "planned", JSON.stringify(data));
    for (const o of still) {
      erp.log(`person:${by}`, "shipping.planned", o, { sourceDoc: manifestId, detail: { truck: r.truck_id, stops, plan_case: caseId } });
    }
    out.push({ manifest_id: manifestId, truck_id: r.truck_id, orders: still });
  }
  return { manifests: out, skipped };
}
