/** Logistics agent as the Home, Operations and Actions screens read it: one planner (shipping/routes.ts). */
import { describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { DISPATCH_DAY, seedDispatchDay } from "../agent/lib/demo/dispatch";
import { logisticsPlan } from "../agent/lib/logistics/plan";
import { receiveOrder } from "../agent/lib/order/service";
import { decideSignoff } from "../agent/lib/shipping/decide";
import { planRoutes, proposeDispatchPlan } from "../agent/lib/shipping/routes";

delete process.env.XAI_API_KEY;
delete process.env.GROK_API_KEY;

describe("logistics plan (Operations shape)", () => {
  it("shows the same numbers as the route planner, every order once and whole", async () => {
    const erp = freshErp();
    await seedDispatchDay(erp);
    const p = logisticsPlan(erp);
    const r = planRoutes(erp, { shipDate: DISPATCH_DAY });
    expect(p.trucks).toHaveLength(r.plan.trucks);
    expect(p.baseline).toEqual({ trucks: r.baseline.trucks, km: r.baseline.km, litres: r.baseline.litres, eur: r.baseline.fuel_eur, co2_kg: r.baseline.co2_kg });
    expect(p.savings.eur).toBe(r.saving.fuel_eur);
    expect(p.trucks.flatMap((t) => t.orders).sort()).toEqual([...r.orders].sort());
    for (const t of p.trucks) {
      expect(t.pallets).toBeLessThanOrEqual(33);
      expect(t.stops.at(-1)!.name).toContain("Pavia");
      expect(t.stops.reduce((a, s) => a + s.km, 0)).toBeCloseTo(t.km, 0);
    }
    expect(p.assumptions.some((a) => a.startsWith("diesel price"))).toBe(true);
  });

  it("includes an order still awaiting confirmation as a preview, writing nothing", async () => {
    const erp = freshErp();
    await seedDispatchDay(erp);
    const edi = "UNH+1+ORDERS:D:96A:UN'BGM+220+ESS-PRV-002+9'DTM+137:20261105:102'NAD+BY+BUYER001::9'NAD+SU+SUPPLIER001::9'LIN+1++8000000000000:EN'QTY+21:960'PRI+AAA:1.85:CT'UNS+S'UNT+10+1'";
    await receiveOrder(erp, edi, { sourceName: "test" });
    const before = erp.auditLog().length;
    const p = logisticsPlan(erp);
    expect(p.preview).toEqual(["ESS-PRV-002"]);
    const truck = p.trucks.find((t) => t.orders.includes("ESS-PRV-002"))!;
    expect(truck.note).toContain("not confirmed yet");
    expect(erp.auditLog().length).toBe(before);
  });

  it("after the transport planner approves, returns the booked plan with its sign-off", async () => {
    const erp = freshErp();
    await seedDispatchDay(erp);
    const r = await proposeDispatchPlan(erp, { shipDate: DISPATCH_DAY });
    expect(logisticsPlan(erp).signoff).toEqual({ case_id: r.case_id, status: "pending" });
    await decideSignoff(erp, r.case_id, { approve: true, by: "Luca, transport planner", reason: "Slots booked" });
    const booked = logisticsPlan(erp);
    expect(booked.signoff).toEqual({ case_id: r.case_id, status: "approved" });
    expect(booked.savings.eur).toBe(r.plan.saving.fuel_eur);
  });

  it("with no orders there is nothing to plan", () => {
    const empty = logisticsPlan(freshErp());
    expect(empty.trucks).toEqual([]);
    expect(empty.explanation).toContain("nothing to plan");
  });
});
