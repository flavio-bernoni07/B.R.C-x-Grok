/** The order panel's two choices on a stopped truck: fix it now (the truck waits) or let it go and book the loss. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { ALWAYS_PERSON } from "../agent/lib/core/policy";
import { recordEvent } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { openShortShipment } from "../agent/lib/demo/case-study";
import { caughtProblems } from "../agent/lib/order/caught";
import { confirmOrder, receiveOrder } from "../agent/lib/order/service";
import * as cases from "../agent/lib/shipping/cases";
import { chooseResolution } from "../agent/lib/shipping/choose";
import { ingestConfirmedOrder } from "../agent/lib/shipping/service";
import * as wh from "../agent/lib/shipping/warehouse";
import { dataPath } from "../agent/lib/paths";

const REF = "ESS-GOLD-001";

/** The golden order up to the scans: pallet 04 on TRUCK-PV-02, Grok proposes a rescan, the truck waits. */
async function stoppedTruck(): Promise<{ erp: Erp; caseId: string }> {
  const erp = freshErp();
  const r = await receiveOrder(erp, readFileSync(dataPath("world", "golden", `ORDERS_${REF}.edi`), "utf8"), { sourceName: "golden", policy: ALWAYS_PERSON });
  ingestConfirmedOrder(erp, confirmOrder(erp, r.case_id, { by: "Giulia, order desk", reason: "checks out" }));
  recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 1200, note: "lab sample: 9% chalky grains" });
  wh.registerTrucks(erp, [
    { truck_id: "TRUCK-PV-01", plate: "FX482KL", destination: "CeDi Melzo", pallet_capacity: 33, max_payload_kg: 24000, window: ["2026-11-05", "2026-11-06"] },
    { truck_id: "TRUCK-PV-02", plate: "GB117RT", destination: "CeDi Melzo", pallet_capacity: 33, max_payload_kg: 24000, window: ["2026-11-05", "2026-11-06"] },
  ] as Parameters<typeof wh.registerTrucks>[1]);
  wh.planTruckLoads(erp, [REF]);
  const picks = wh.createPickingList(erp, REF);
  const scans = picks.map((p) => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "TRUCK-PV-01" }));
  scans[3] = { ...scans[3], truck_id: "TRUCK-PV-02" };
  const wrong = wh.verifyScans(erp, REF, scans).exceptions.filter((e) => e.type === "WRONG_TRUCK");
  const caseId = cases.openExceptionCases(erp, wrong)[0];
  cases.submitResolutionProposal(erp, caseId, { actions: [{ action: "RESCAN_PALLET" }], rationale: "scan it again on the planned truck" }, { by: "grok (recorded)" });
  return { erp, caseId };
}

describe("choose on the order panel", () => {
  it("shows the stopped truck with Grok's fix first, and the packs on hold", async () => {
    const { erp } = await stoppedTruck();
    openShortShipment(erp, REF);
    const [truck, short] = caughtProblems(erp, REF);
    expect(truck).toMatchObject({ problem: "Pallet 04 on the wrong truck", alert: "TRUCK-PV-01 stopped until you decide", atStake: 2112, grok: "Scan it onto TRUCK-PV-01", done: false });
    expect(truck.options.map((o) => [o.action, o.grok])).toEqual([
      ["RESCAN_PALLET", true],
      ["SHIP_WITHOUT_PALLET", false],
    ]);
    expect(short).toMatchObject({ problem: "1,200 packs on quality hold", atStake: 2640, done: false });
    expect(short.options[0]).toMatchObject({ grok: true });
    erp.close();
  });

  it("fix now: the pallet is scanned onto its truck and the truck is released", async () => {
    const { erp, caseId } = await stoppedTruck();
    const r = await chooseResolution(erp, caseId, { action: "RESCAN_PALLET", by: "Warehouse lead" });
    expect(r).toMatchObject({ resolution: "resolved", truck: "TRUCK-PV-01", truck_released: true, loss_eur: null });
    expect(wh.pallets(erp, REF).every((p) => p.status === "loaded")).toBe(true);
    expect(caughtProblems(erp, REF)[0]).toMatchObject({ done: true, outcome: "Fixed, truck released", options: [] });
    expect(erp.signoffs({ status: "pending" })).toEqual([]);
    erp.close();
  });

  it("let it go: Grok's proposal is turned down, the pallet stays and €2,112 is booked as a loss", async () => {
    const { erp, caseId } = await stoppedTruck();
    const r = await chooseResolution(erp, caseId, { action: "SHIP_WITHOUT_PALLET", by: "Warehouse lead" });
    expect(r).toMatchObject({ truck_released: true, loss_eur: 2112 });
    const ps = wh.pallets(erp, REF);
    expect(ps.filter((p) => p.status === "excluded").map((p) => p.pallet_id)).toEqual(["PAL-ESS-GOLD-001-04"]);
    expect(ps.filter((p) => p.status === "loaded")).toHaveLength(ps.length - 1);
    expect(erp.signoffs().filter((s) => s.subjectRef === caseId).map((s) => s.status)).toEqual(["rejected", "approved"]);
    expect(caughtProblems(erp, REF)[0]).toMatchObject({ done: true, outcome: "Truck left without it, €2,112 loss booked" });
    erp.close();
  });
});
