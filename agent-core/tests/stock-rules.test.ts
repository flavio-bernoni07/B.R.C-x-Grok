/**
 * The stock rules of OPS-WORKSPACE-PROMPT.md section 5A, checked against the existing port
 * (core/stock.ts + shipping/warehouse.ts) through the read-only inventory view.
 */
import { describe, expect, it } from "vitest";
import type { Erp } from "../agent/lib/core/erp";
import { inventory } from "../agent/lib/core/inventory";
import { availableToPromise, recordEvent } from "../agent/lib/core/stock";
import { freshErp } from "../agent/lib/core/world";
import { ingestConfirmedOrder } from "../agent/lib/shipping/service";
import * as wh from "../agent/lib/shipping/warehouse";

const CAR = "8000000000001"; // 12,000 released (LOT-C-0417/0418), 4,000 planned

const car = (erp: Erp) => inventory(erp).products.find((p) => p.gtin === CAR)!;

function received(erp: Erp, ref: string, qty: number) {
  erp.saveOrder({
    orderRef: ref,
    buyerGln: "BUYER001",
    supplierGln: "SUPPLIER001",
    orderDate: "20261104",
    lines: [{ lineNo: 1, gtin: CAR, quantity: qty, qtyConfirmed: qty, unitPrice: 2.4 }],
    status: "awaiting_confirmation",
    sourceDoc: erp.addDocument("ORDERS", ref, "demo"),
    notes: {},
  });
}

function approved(erp: Erp, ref: string, qty: number) {
  received(erp, ref, qty);
  const docId = erp.addDocument("ORDRSP", ref, "demo");
  erp.setOrder(ref, { status: "confirmed", ordrspRef: docId });
  ingestConfirmedOrder(erp, { order_number: ref, lines: [{ gtin: CAR, quantity: qty }], ordrsp_ref: docId });
}

describe("stock rules", () => {
  it("receiving an order deducts nothing", () => {
    const erp = freshErp();
    const before = car(erp);
    received(erp, "R-1", 1920);
    const after = car(erp);
    expect(after.physical).toBe(before.physical);
    expect(after.atp).toBe(before.atp);
    expect(after.reserved).toBe(0);
  });

  it("an approved order lowers available to promise, not physical stock", () => {
    const erp = freshErp();
    const before = car(erp);
    approved(erp, "R-2", 1920);
    const after = car(erp);
    expect(after.physical).toBe(before.physical);
    expect(after.reserved).toBe(1920);
    expect(after.atp).toBe(before.atp - 1920);
  });

  it("planning, picking and loading deduct nothing; a verified dispatch lowers physical stock once", () => {
    const erp = freshErp();
    approved(erp, "R-3", 1920);
    const reservedState = car(erp);
    wh.registerTrucks(erp, [{ truck_id: "T1", destination: "CeDi Melzo", pallet_capacity: 33, max_payload_kg: 24000 }]);
    wh.planTruckLoads(erp, ["R-3"]);
    expect(car(erp)).toMatchObject({ physical: reservedState.physical, atp: reservedState.atp });
    const pallets = wh.createPickingList(erp, "R-3");
    expect(car(erp)).toMatchObject({ physical: reservedState.physical, atp: reservedState.atp });
    wh.verifyScans(erp, "R-3", pallets.map((p) => ({ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: "T1" })));
    wh.confirmLoading(erp, "R-3");
    expect(car(erp)).toMatchObject({ physical: reservedState.physical, atp: reservedState.atp, reserved: 1920 });

    expect(wh.authorizeDispatch(erp, "R-3", { shipDate: "2026-11-05" }).dispatched).toBe(true);
    const after = car(erp);
    expect(after.physical).toBe(reservedState.physical - 1920);
    expect(after.reserved).toBe(0); // the reservation is consumed, not deducted twice
    expect(after.atp).toBe(reservedState.atp);
    expect(after.dispatched).toBe(1920);
    expect(after.inTransit).toBe(1920);
  });

  it("cancelling before dispatch releases the reservation", () => {
    const erp = freshErp();
    const before = car(erp);
    approved(erp, "R-4", 960);
    erp.setOrder("R-4", { status: "cancelled" });
    expect(car(erp).atp).toBe(before.atp);
    expect(car(erp).physical).toBe(before.physical);
  });

  it("held stock is physical but never available, and only a release event frees it", () => {
    const erp = freshErp();
    const before = car(erp);
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0417" });
    const held = car(erp);
    expect(held.physical).toBe(before.physical);
    expect(held.held).toBe(6000);
    expect(held.atp).toBe(before.atp - 6000);
    expect(availableToPromise(erp, CAR, "2026-11-04").atp).toBe(6000);
    recordEvent(erp, "hold_released", { batch: "LOT-C-0417" });
    expect(car(erp).atp).toBe(before.atp);
  });

  it("every movement records product, batch, time and source event", () => {
    const erp = freshErp();
    recordEvent(erp, "quality_hold", { batch: "LOT-C-0418", qty: 100 });
    const log = erp.auditLog("LOT-C-0418").at(-1)!;
    expect(log.action).toBe("production.quality_hold");
    expect(log.sourceDoc).toMatch(/^EVT-/);
    expect((log.detail as { gtin: string }).gtin).toBe(CAR);
    expect(log.at).toBeTruthy();
  });
});
