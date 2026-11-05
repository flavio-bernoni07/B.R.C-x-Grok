/**
 * Logistics agent: shared trucks and shorter routes (OPS-WORKSPACE-PROMPT.md section 5B), in the
 * shape the Home, Operations and Actions screens read.
 *
 * One planner only: this calls `planRoutes` (agent/lib/shipping/routes.ts). Real road km (OSRM on
 * OpenStreetMap), fuel use from ICCT, the MASE diesel price; every grouping and stop order is tried
 * within 33 pallets, 24 t and the 9-hour driving limit, against the planner's way (orders grouped by warehouse, one truck each). Orders a person
 * has not confirmed yet (or confirmed, not yet with Shipping) are included as a preview, so the
 * Ready-to-ship card can show the truck an order would go on.
 *
 * A plan only: it writes nothing. Trucks are booked through `shipping_plan_routes` and the transport
 * planner's sign-off; once that plan is approved, this returns it as booked.
 */
import type { Erp } from "../core/erp";
import { DISPATCH_DAY } from "../demo/dispatch";
import { type Briefing, codeBriefing, type DispatchPlan, dispatchSignoffs, planRoutes, PREVIEW_STATUSES, RoutePlanError } from "../shipping/routes";
import { manifestForOrder } from "../shipping/warehouse";

export type Totals = { trucks: number; km: number; litres: number; eur: number; co2_kg: number };
export type TruckPlan = {
  truck: string;
  date: string;
  orders: string[];
  pallets: number;
  weight_kg: number;
  /** Each stop with the road km from the previous one; the last is the drive back to the plant. */
  stops: { name: string; km: number }[];
  km: number;
  litres: number;
  eur: number;
  co2_kg: number;
  note?: string;
};
export type LogisticsPlan = {
  ship_date: string;
  trucks: TruckPlan[];
  baseline: Totals;
  savings: Totals;
  assumptions: string[];
  explanation: string;
  skipped: { order_ref: string; why: string }[];
  /** Orders planned as if confirmed: a person has not approved them yet. */
  preview: string[];
  /** The transport planner's sign-off for this day, when there is one. */
  signoff: { case_id: string; status: string } | null;
  /** The orders are demo data (data/world); the roads, fuel use and diesel price are real. */
  demo: boolean;
  scenario: boolean;
};

const totals = (t: DispatchPlan["plan"]): Totals => ({ trucks: t.trucks, km: t.km, litres: t.litres, eur: t.fuel_eur, co2_kg: t.co2_kg });

/** The route planner's plan in the Operations shape. */
export function toLogisticsPlan(p: DispatchPlan, opts: { briefing?: Briefing | null; signoff?: { case_id: string; status: string } | null } = {}): LogisticsPlan {
  const trucks: TruckPlan[] = p.routes.map((r) => {
    const back = Math.round((r.km - r.stops.reduce((a, s) => a + s.leg_km, 0)) * 10) / 10;
    const waiting = r.orders.filter((o) => p.preview.includes(o));
    const notes = [
      r.driver_days > 1 ? `${r.driver_days} driver days (${Math.floor(r.drive_min / 60)} h ${String(r.drive_min % 60).padStart(2, "0")} of driving)` : null,
      waiting.length ? `${waiting.join(", ")} not confirmed yet: planned as if approved` : null,
    ].filter(Boolean);
    return {
      truck: r.truck_id ?? "carrier to book",
      date: p.ship_date,
      orders: r.orders,
      pallets: r.pallets,
      weight_kg: r.weight_kg,
      stops: [...r.stops.map((s) => ({ name: s.point, km: s.leg_km })), { name: p.plant.name, km: back }],
      km: r.km,
      litres: r.litres,
      eur: r.fuel_eur,
      co2_kg: r.co2_kg,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  });
  const explanation = !p.routes.length
    ? "There is nothing to plan: no confirmed orders are waiting for a truck."
    : (opts.briefing?.summary ?? codeBriefing(p).summary);
  return {
    ship_date: p.ship_date,
    trucks,
    baseline: totals(p.baseline),
    savings: { trucks: p.saving.trucks, km: p.saving.km, litres: p.saving.litres, eur: p.saving.fuel_eur, co2_kg: p.saving.co2_kg },
    assumptions: [...p.sources.map((s) => `${s.what}: ${s.source}`), ...p.checks.map((c) => `Checked: ${c}`)],
    explanation,
    skipped: p.unplanned.map((u) => ({ order_ref: u.order_ref, why: u.reason })),
    preview: p.preview,
    signoff: opts.signoff ?? null,
    demo: true,
    scenario: false,
  };
}

/**
 * The plan for the orders in the Mini ERP for one ship date (default the demo dispatch day). If the
 * transport planner already approved a plan for that day and nothing new is waiting, that booked plan
 * is returned. `scenario` is accepted for old callers and ignored: the dispatch day is real seeded data.
 */
export function logisticsPlan(erp: Erp, opts: { scenario?: boolean; shipDate?: string } = {}): LogisticsPlan {
  const shipDate = opts.shipDate ?? DISPATCH_DAY;
  const preview = erp
    .orders()
    .filter((o) => PREVIEW_STATUSES.has(o.status ?? "") && !manifestForOrder(erp, o.orderRef))
    .map((o) => o.orderRef);
  const cases = dispatchSignoffs(erp).filter((s) => (s.proposal as { ship_date?: string } | null)?.ship_date === shipDate);
  const last = cases.at(-1);
  let fresh: DispatchPlan;
  try {
    fresh = planRoutes(erp, { shipDate, preview });
  } catch (err) {
    if (!(err instanceof RoutePlanError)) throw err;
    const empty = { trucks: 0, km: 0, litres: 0, eur: 0, co2_kg: 0 };
    return { ship_date: shipDate, trucks: [], baseline: empty, savings: empty, assumptions: [], explanation: err.message, skipped: [], preview: [], signoff: null, demo: true, scenario: false };
  }
  const stored = (last?.proposal ?? {}) as { plan?: DispatchPlan; briefing?: Briefing };
  if (last?.status === "approved" && stored.plan && !fresh.routes.length) {
    return toLogisticsPlan({ ...stored.plan, preview: stored.plan.preview ?? [] }, { briefing: stored.briefing, signoff: { case_id: last.caseId, status: last.status } });
  }
  const pendingSame = last?.status === "pending" ? last : undefined;
  return toLogisticsPlan(fresh, {
    briefing: pendingSame && !fresh.preview.length ? stored.briefing : null,
    signoff: pendingSame ? { case_id: pendingSame.caseId, status: pendingSame.status } : null,
  });
}
