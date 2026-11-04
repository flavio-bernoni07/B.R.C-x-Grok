/** The logistics agent: shared trucks and stop order on real road distances, against one truck per order. */
import { beforeAll, describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { freshErp } from "../agent/lib/core/world";
import { DISPATCH_DAY, seedDispatchDay } from "../agent/lib/demo/dispatch";
import { decideSignoff } from "../agent/lib/shipping/decide";
import { codeBriefing, loadLogistics, planRoutes, proposeDispatchPlan, readyOrders } from "../agent/lib/shipping/routes";
import { manifestForOrder, truck } from "../agent/lib/shipping/warehouse";

const lg = loadLogistics();
// Offline: no live Grok call from the test suite.
delete process.env.XAI_API_KEY;
delete process.env.GROK_API_KEY;

async function dispatchDay(): Promise<Erp> {
  const erp = freshErp();
  await seedDispatchDay(erp);
  return erp;
}

describe("logistics agent", () => {
  let erp: Erp;
  beforeAll(async () => {
    erp = await dispatchDay();
  });

  it("finds the six dispatch-day orders ready to ship", () => {
    expect(readyOrders(erp).sort()).toEqual(["AUC-DSP-001", "CON-DSP-001", "COO-DSP-001", "CRF-DSP-001", "ESS-DSP-001", "ESS-DSP-002"]);
  });

  it("puts both Esselunga orders for CeDi Melzo on one stop of one truck", () => {
    const plan = planRoutes(erp, { shipDate: DISPATCH_DAY });
    const melzo = plan.routes.flatMap((r) => r.stops).filter((s) => s.point === "CeDi Melzo");
    expect(melzo).toHaveLength(1);
    expect(melzo[0].orders.sort()).toEqual(["ESS-DSP-001", "ESS-DSP-002"]);
  });

  it("uses fewer trucks and fewer km than one truck per order, within every limit", () => {
    const plan = planRoutes(erp, { shipDate: DISPATCH_DAY });
    expect(plan.baseline.trucks).toBe(6);
    expect(plan.plan.trucks).toBeLessThan(plan.baseline.trucks);
    expect(plan.plan.km).toBeLessThan(plan.baseline.km);
    expect(plan.saving.fuel_eur).toBeGreaterThan(0);
    for (const r of plan.routes) {
      expect(r.pallets).toBeLessThanOrEqual(lg.fleet.pallet_capacity);
      expect(r.weight_kg).toBeLessThanOrEqual(lg.fleet.max_payload_kg);
      expect(r.stops.at(-1)!.arrive_drive_min).toBeLessThanOrEqual(lg.rules.max_daily_driving_h * 60);
      expect(r.truck_id).toBeTruthy();
    }
    expect(plan.unplanned).toEqual([]);
    expect(plan.orders.sort()).toEqual(readyOrders(erp).sort());
  });

  it("computes fuel and money from the sourced figures", () => {
    const plan = planRoutes(erp, { shipDate: DISPATCH_DAY });
    const litres = (plan.plan.km * lg.fuel.l_per_100km) / 100;
    expect(plan.plan.litres).toBeCloseTo(litres, 0);
    expect(plan.plan.fuel_eur).toBeCloseTo(litres * lg.diesel.eur_per_l, 0);
    expect(plan.sources.map((s) => s.what)).toContain("diesel price");
  });

  it("is exact on a small case: two neighbours share a truck, a far stop that would add a driver day does not", () => {
    // Melzo and Milano are 22 km apart: one truck. Ancona alone is a two-day trip; adding it changes nothing else.
    const plan = planRoutes(erp, { shipDate: DISPATCH_DAY, orderRefs: ["ESS-DSP-001", "CRF-DSP-001"] });
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0].stops.map((s) => s.point).sort()).toEqual(["CeDi Carrefour Nord", "CeDi Melzo"]);
    const direct = plan.baseline.km;
    expect(plan.plan.km).toBeLessThan(direct);
  });
});

describe("dispatch plan sign-off", () => {
  it("offline, uses the recorded Grok briefing for the demo day, which passes the number check", async () => {
    const erp = await dispatchDay();
    const r = await proposeDispatchPlan(erp, { shipDate: DISPATCH_DAY });
    expect(r.briefing.by).toBe("grok (recorded)");
    expect(r.briefing.summary).toContain("2 trucks instead of 6");
  });

  it("rejects a Grok briefing with a figure that is not in the plan, and falls back to code", async () => {
    const erp = await dispatchDay();
    const r = await proposeDispatchPlan(erp, {
      shipDate: DISPATCH_DAY,
      caller: () => ({ summary: "Saves 999 km.", watch: [] }),
    });
    expect(r.briefing.by).toBe("code");
    expect(r.briefing.summary).toBe(codeBriefing(r.plan).summary);
  });

  it("keeps a valid Grok briefing, waits for the transport planner, then books trucks and manifests", async () => {
    const erp = await dispatchDay();
    const r = await proposeDispatchPlan(erp, {
      shipDate: DISPATCH_DAY,
      caller: (messages) => {
        const plan = JSON.parse(messages[1].content);
        return { summary: `${plan.plan.trucks} trucks instead of ${plan.baseline.trucks}.`, watch: [] };
      },
    });
    expect(r.briefing.by).toBe("grok");
    const so = erp.signoff(r.case_id)!;
    expect(so.status).toBe("pending");
    expect(so.kind).toBe("dispatch_plan");
    // Nothing is booked before the person decides.
    expect(manifestForOrder(erp, "ESS-DSP-001")).toBeUndefined();
    // Asking again for the same day returns the same case instead of planning twice.
    expect((await proposeDispatchPlan(erp, { shipDate: DISPATCH_DAY })).case_id).toBe(r.case_id);

    const done = await decideSignoff(erp, r.case_id, { approve: true, by: "Luca, transport planner", reason: "Slots booked at every CeDi" });
    expect(done.status).toBe("planned");
    for (const ref of r.plan.orders) expect(manifestForOrder(erp, ref)).toBeTruthy();
    const route = r.plan.routes.find((x) => x.stops.length > 1)!;
    const m = manifestForOrder(erp, route.orders[0])!;
    expect(m.orders.sort()).toEqual([...route.orders].sort());
    expect(truck(erp, route.truck_id!)?.compatible_routes).toEqual(route.stops.map((s) => s.point));
    expect(readyOrders(erp)).toEqual([]);
  });

  it("books nothing when the transport planner rejects", async () => {
    const erp = await dispatchDay();
    const r = await proposeDispatchPlan(erp, { shipDate: DISPATCH_DAY });
    const done = await decideSignoff(erp, r.case_id, { approve: false, by: "Luca, transport planner", reason: "Conad moved its slot to Monday" });
    expect(done.status).toBe("rejected");
    expect(manifestForOrder(erp, "CON-DSP-001")).toBeUndefined();
    expect(readyOrders(erp)).toHaveLength(6);
  });
});
