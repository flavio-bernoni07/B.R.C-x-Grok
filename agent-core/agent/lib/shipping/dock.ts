/**
 * The loading dock: which pallet goes on which truck, read by the person with the scanner.
 *
 * Built on the warehouse row (warehouse.ts): the manifests the transport planner approved, the
 * picking list per order, the scans and the loading check. A scan reads the pallet label (pallet id,
 * GTIN, batch, quantity) at the truck the operator stands at; code says which order and truck the
 * pallet belongs to and records the result. Closing a truck loads the verified pallets, and every
 * pallet on the list that was never verified is flagged MISSING_PALLET. Each flag opens an exception
 * case for the warehouse lead, as in the golden run. Nothing here dispatches or invoices.
 */
import type { Erp } from "../core/erp";
import { openExceptionCases } from "./cases";
import {
  all,
  confirmLoading,
  createPickingList,
  exceptions,
  manifestForOrder,
  manifests,
  orderLoad,
  type Pallet,
  pallet as palletById,
  pallets as palletsOf,
  type ScanRow,
  scans as scansOf,
  truck as truckById,
  verifyScans,
} from "./warehouse";

export type DockPallet = Pallet & { lastScan: { result: string; at: string; truck_id: string | null } | null };

export type DockOrder = {
  orderRef: string;
  retailer: string;
  stop: string | null;
  /** Pallets the order needs on this truck (from the manifest load); the picking list once it exists. */
  expected: number;
  pallets: DockPallet[];
  verified: number;
  flagged: { type: string; pallet: string | null; text: string }[];
  /** Every scan that did not pass, open or since resolved: what the scanner caught. */
  caught: { pallet: string | null; result: string; truck: string | null; at: string }[];
  loaded: boolean;
  dispatched: boolean;
};

export type DockTruck = {
  truckId: string;
  plate: string | null;
  manifestId: string;
  status: string;
  shipDate: string | null;
  stops: string[];
  pallets: number;
  capacity: number;
  weightKg: number;
  maxKg: number;
  orders: DockOrder[];
};

export type ScanResult = {
  result: string;
  palletId: string;
  orderRef: string | null;
  retailer: string | null;
  /** The truck the pallet is planned on, and the one it was scanned at. */
  plannedTruck: string | null;
  scannedTruck: string | null;
  text: string;
  caseIds: string[];
};

const RESULT_TEXT: Record<string, string> = {
  OK: "belongs here",
  WRONG_TRUCK: "is on the wrong truck",
  DUPLICATE_SCAN: "was already scanned",
  UNKNOWN_PALLET: "is not on any picking list",
  WRONG_PRODUCT: "carries the wrong product",
  WRONG_BATCH: "carries the wrong batch",
  BAD_QUANTITY: "has the wrong quantity",
  QUALITY_HOLD: "is from a batch on quality hold",
};

function retailerOf(erp: Erp, orderRef: string): string {
  const o = erp.order(orderRef);
  return (o && erp.retailer(o.buyerGln)?.name) || o?.buyerGln || "";
}

function lastScans(erp: Erp, orderRef: string): Map<string, ScanRow> {
  const out = new Map<string, ScanRow>();
  for (const s of scansOf(erp, orderRef)) if (s.pallet_id) out.set(s.pallet_id, s);
  return out;
}

/** Every truck with a manifest, newest first, with its orders, pallets and flags. */
export function dockView(erp: Erp): { trucks: DockTruck[] } {
  const trucks: DockTruck[] = [];
  for (const m of manifests(erp).filter((x) => x.status !== "cancelled").reverse()) {
    const t = truckById(erp, m.truck_id);
    const route = (m as unknown as { route?: { ship_date?: string } }).route;
    const orders: DockOrder[] = m.orders.map((ref) => {
      const ps = palletsOf(erp, ref);
      const last = lastScans(erp, ref);
      const order = erp.order(ref);
      const retailer = order ? erp.retailer(order.buyerGln) : undefined;
      const exc = exceptions(erp, ref).filter((e) => e.status !== "closed" && (!e.truck_id || e.truck_id === m.truck_id || ps.some((p) => p.pallet_id === e.pallet_id)));
      const load = all<{ data: string }>(erp, "SELECT data FROM si_loadings WHERE order_ref = ? AND manifest_id = ?", ref, m.manifest_id);
      const expected = ps.length || (order ? orderLoad(erp, ref).pallets : 0);
      return {
        orderRef: ref,
        retailer: retailer?.name ?? order?.buyerGln ?? ref,
        stop: retailer?.deliveryPoint ?? null,
        expected,
        pallets: ps.map((p) => {
          const s = last.get(p.pallet_id);
          return { ...p, lastScan: s ? { result: s.result, at: s.at, truck_id: (s.data.truck_id as string | null | undefined) ?? null } : null };
        }),
        verified: ps.filter((p) => p.status === "verified" || p.status === "loaded" || p.status === "dispatched").length,
        flagged: exc.map((e) => ({ type: e.type, pallet: e.pallet_id, text: e.explanation })),
        caught: scansOf(erp, ref)
          .filter((x) => x.result !== "OK")
          .map((x) => ({ pallet: x.pallet_id, result: x.result, truck: (x.data.truck_id as string | null | undefined) ?? null, at: x.at })),
        loaded: load.length > 0,
        dispatched: order?.status === "shipped" || order?.status === "invoiced" || ps.some((p) => p.status === "dispatched"),
      };
    });
    trucks.push({
      truckId: m.truck_id,
      plate: t?.plate ?? null,
      manifestId: m.manifest_id,
      status: m.status,
      shipDate: route?.ship_date ?? t?.window?.[0] ?? null,
      stops: m.destinations.filter((d): d is string => !!d),
      pallets: m.pallets,
      capacity: t?.pallet_capacity ?? 33,
      weightKg: m.weight_kg,
      maxKg: t?.max_payload_kg ?? 24000,
      orders,
    });
  }
  return { trucks };
}

/** Print the picking list for every order on a planned truck (batch first in, first out). */
export function pickTruck(erp: Erp, truckId: string): { orders: string[]; pallets: number } {
  const m = manifests(erp).find((x) => x.truck_id === truckId && x.status !== "cancelled" && !x.dispatched);
  if (!m) throw new Error(`${truckId} has no planned manifest`);
  let n = 0;
  for (const ref of m.orders) n += createPickingList(erp, ref).length;
  return { orders: m.orders, pallets: n };
}

/** One scan at a truck: the pallet label is read, code says whose pallet it is and whether it belongs here. */
export function scanPallet(erp: Erp, palletId: string, truckId: string): ScanResult {
  const p = palletById(erp, palletId.trim());
  if (!p) {
    return { result: "UNKNOWN_PALLET", palletId, orderRef: null, retailer: null, plannedTruck: null, scannedTruck: truckId, text: `${palletId} ${RESULT_TEXT.UNKNOWN_PALLET}`, caseIds: [] };
  }
  const planned = p.truck_id ?? manifestForOrder(erp, p.order_ref)?.truck_id ?? null;
  const r = verifyScans(erp, p.order_ref, [{ pallet_id: p.pallet_id, gtin: p.gtin, batch: p.batch, qty: p.qty, truck_id: truckId }], { truckId });
  const result = r.results[0]?.result ?? "OK";
  const caseIds = r.exceptions.length ? openExceptionCases(erp, r.exceptions) : [];
  const retailer = retailerOf(erp, p.order_ref);
  const where = result === "WRONG_TRUCK" && planned ? `: it goes on ${planned}` : "";
  return {
    result,
    palletId: p.pallet_id,
    orderRef: p.order_ref,
    retailer,
    plannedTruck: planned,
    scannedTruck: truckId,
    text: `${p.pallet_id} (${p.order_ref}, ${retailer}) ${RESULT_TEXT[result] ?? result.toLowerCase()}${where}`,
    caseIds,
  };
}

/** Close a truck: load what was verified; anything on the list that was not is flagged missing. */
export function closeTruck(erp: Erp, truckId: string): { loaded: number; missing: { order_ref: string; pallet: string | null; text: string }[]; caseIds: string[] } {
  const m = manifests(erp).find((x) => x.truck_id === truckId && x.status !== "cancelled" && !x.dispatched);
  if (!m) throw new Error(`${truckId} has no manifest to load`);
  let loaded = 0;
  const missing: { order_ref: string; pallet: string | null; text: string }[] = [];
  const caseIds: string[] = [];
  for (const ref of m.orders) {
    if (!palletsOf(erp, ref).length) continue;
    const r = confirmLoading(erp, ref, { truckId });
    loaded += r.pallets.length;
    for (const e of r.exceptions) missing.push({ order_ref: ref, pallet: e.pallet_id, text: e.explanation });
    if (r.exceptions.length) caseIds.push(...openExceptionCases(erp, r.exceptions));
  }
  return { loaded, missing, caseIds };
}
