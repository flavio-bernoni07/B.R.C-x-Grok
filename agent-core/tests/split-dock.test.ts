/** A split delivery planned with the rest of the day, and the loading dock that checks every pallet scan. */
import { beforeAll, describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { availableToPromise } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { DISPATCH_DAY, seedDispatchDay } from "../agent/lib/demo/dispatch";
import { runGolden } from "../agent/lib/demo/golden";
import { SPLIT_ORDER } from "../agent/lib/demo/split";
import { ordersInbox } from "../agent/lib/order/inbox";
import { orderWorkspace } from "../agent/lib/order/workspace";
import { closeTruck, dockView, pickTruck, scanPallet } from "../agent/lib/shipping/dock";
import { decideSignoff } from "../agent/lib/shipping/decide";
import { proposeDispatchPlan } from "../agent/lib/shipping/routes";

// Offline: no live Grok call from the test suite.
delete process.env.XAI_API_KEY;
delete process.env.GROK_API_KEY;

describe("split delivery", () => {
  let erp: Erp;
  // The whole demo seed: the golden order uses the Carnaroli on hand, so the split order finds too little.
  beforeAll(async () => {
    process.env.BRC_PLAYBOOK = "/tmp/brc-split-playbook-test.md";
    erp = freshErp();
    await runGolden(erp);
  });

  it("Grok splits the order: what is free ships now, the rest from the next batch", () => {
    const ws = orderWorkspace(erp, SPLIT_ORDER)!;
    expect(ws.split).toMatchObject({ now: 3000, later: 4000, laterDate: "2026-11-09", by: "grok" });
    expect(ws.split!.message).toContain("3000");
    expect(ws.summary.confirmed).toBe(3000);
    expect(ws.owner).toMatchObject({ kind: "agent", name: "Logistics agent" });
  });

  it("shows the split and who has the order in the inbox", () => {
    const row = ordersInbox(erp).find((r) => r.orderRef === SPLIT_ORDER)!;
    expect(row.split?.later).toBe(4000);
    expect(row.owner.name).toBe("Logistics agent");
    expect(row.value).toBe(7200);
  });

  it("leaves the Arborio free for the ambiguous-order scenario (ESS-AMB-001)", () => {
    expect(availableToPromise(erp, "8000000000000").atp).toBeGreaterThanOrEqual(6000);
  });

  it("rides with Carrefour's other order: same warehouse, one stop", async () => {
    const r = await proposeDispatchPlan(erp, { shipDate: DISPATCH_DAY });
    expect(r.briefing.by).toBe("grok (recorded)");
    expect(r.plan.plan.trucks).toBe(3);
    expect(r.plan.baseline.trucks).toBe(5);
    const stop = r.plan.routes.flatMap((x) => x.stops).find((s) => s.point === "CeDi Carrefour Nord")!;
    expect([...stop.orders].sort()).toEqual(["CRF-DSP-001", SPLIT_ORDER]);
  });
});

describe("loading dock", () => {
  it("says whose pallet it is, flags a wrong truck, and flags what is missing when the truck closes", async () => {
    const erp = freshErp();
    await seedDispatchDay(erp);
    const r = await proposeDispatchPlan(erp, { shipDate: DISPATCH_DAY });
    expect(dockView(erp).trucks).toEqual([]);
    await decideSignoff(erp, r.case_id, { approve: true, by: "Luca, transport planner", reason: "Slots booked at every CeDi" });

    const melzo = r.plan.routes.find((x) => x.stops.some((s) => s.point === "CeDi Melzo"))!;
    const other = r.plan.routes.find((x) => x !== melzo)!;
    expect(pickTruck(erp, melzo.truck_id!).pallets).toBe(melzo.pallets);
    const pallets = dockView(erp).trucks.find((t) => t.truckId === melzo.truck_id)!.orders.flatMap((o) => o.pallets);
    expect(pallets).toHaveLength(melzo.pallets);

    expect(scanPallet(erp, pallets[0].pallet_id, melzo.truck_id!).result).toBe("OK");
    const wrong = scanPallet(erp, pallets[1].pallet_id, other.truck_id!);
    expect(wrong.result).toBe("WRONG_TRUCK");
    expect(wrong.plannedTruck).toBe(melzo.truck_id);
    expect(wrong.caseIds).toHaveLength(1);
    expect(scanPallet(erp, "PAL-NOT-ON-ANY-LIST", melzo.truck_id!).result).toBe("UNKNOWN_PALLET");
    for (const p of pallets.slice(2, -1)) expect(scanPallet(erp, p.pallet_id, melzo.truck_id!).result).toBe("OK");

    const closed = closeTruck(erp, melzo.truck_id!);
    expect(closed.loaded).toBe(pallets.length - 2);
    expect(closed.missing.map((m) => m.pallet).sort()).toEqual([pallets[1].pallet_id, pallets.at(-1)!.pallet_id].sort());
    expect(closed.caseIds).toHaveLength(2);
    const order = dockView(erp).trucks.find((t) => t.truckId === melzo.truck_id)!.orders.find((o) => o.pallets.some((p) => p.pallet_id === pallets[1].pallet_id))!;
    expect(order.caught.map((c) => c.result)).toContain("WRONG_TRUCK");
  });
});
