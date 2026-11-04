/**
 * Trucks, picking, pallet scans, loading and dispatch (port of shipping/warehouse.py).
 *
 * Rebuilt from Nicola's v0.5.0 write-up in DECISIONS.md, on the shared Mini ERP. Same rules:
 *
 * - planning assigns whole orders to the first truck that fits: available, same destination
 *   (or an explicit compatible route), overlapping delivery window, pallet space, payload
 *   weight. A missing weight or pallet size stops the plan. Planning writes no shipment and
 *   moves no stock.
 * - picking proposes pallets (batch first in, first out) and moves no stock.
 * - every pallet is scanned: wrong product, wrong batch, bad quantity, duplicate, quality hold
 *   or WRONG_TRUCK keeps it off the shipment.
 * - dispatch needs a loading record on the planned truck and manifest; holds are checked
 *   again; only then does stock leave and the DESADV and DDT get written.
 *
 * Every failed check is stored as an exception that `cases.ts` can open as a case.
 *
 * The `si_*` tables are this row's own JSON-ish records: their rows (pallets, manifests,
 * exceptions, trucks) keep the Python snake_case keys, as stored.
 */
import type { Erp, Product, Retailer } from "../core/erp";
import { nowIso } from "../core/erp";
import { batches } from "../core/stock";
import { buildDdt, buildDesadv, type DocBuyer, type DocProduct } from "./documents";
import { pyG, pyRound } from "./format";

export type Json = Record<string, unknown>;

export type Truck = {
  truck_id: string;
  plate?: string;
  destination?: string | null;
  pallet_capacity: number;
  max_payload_kg: number;
  window?: [string, string] | null;
  compatible_routes?: string[];
  available?: boolean;
  [k: string]: unknown;
};

export type Manifest = {
  manifest_id: string;
  truck_id: string;
  status: string;
  orders: string[];
  pallets: number;
  weight_kg: number;
  destinations: (string | null)[];
  physically_loaded: boolean;
  dispatched: boolean;
};

export type Pallet = {
  pallet_id: string;
  order_ref: string;
  gtin: string;
  batch: string | null;
  qty: number;
  status: string;
  manifest_id: string | null;
  truck_id: string | null;
};

export type ShippingException = {
  exception_id: string;
  type: string;
  severity: string;
  order_ref: string | null;
  truck_id: string | null;
  pallet_id: string | null;
  shipment_ref: string | null;
  invoice_ref: string | null;
  explanation: string;
  evidence: Json;
  financial_impact_eur: number | null;
  at: string;
  status?: string;
};

export type OrderLoad = {
  order_ref: string;
  pallets: number;
  weight_kg: number;
  missing_data: string[];
  destination: string | null;
  window: [string, string] | null;
};

// ----- small raw-SQL helpers (Python's erp._one / erp._all) ------------------

export function one<T = Json>(erp: Erp, sql: string, ...params: unknown[]): T | undefined {
  return erp.sqlite.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Json>(erp: Erp, sql: string, ...params: unknown[]): T[] {
  return erp.sqlite.prepare(sql).all(...params) as T[];
}

export function run(erp: Erp, sql: string, ...params: unknown[]) {
  erp.sqlite.prepare(sql).run(...params);
}

function withData<T>(row: Json | undefined): T | undefined {
  if (!row) return undefined;
  const { data, ...rest } = row;
  return { ...rest, ...(JSON.parse(String(data)) as Json) } as T;
}

// ----- Python-shaped views of ERP rows (the documents and Grok read these) ----

export type ProductDict = {
  gtin: string;
  item_code: string;
  name: string;
  uom: string;
  units_per_case: number;
  list_price: number | null;
  vat_rate: number;
  units_per_pallet: number | null;
  unit_weight_kg: number | null;
};

export const productDict = (p: Product): ProductDict => ({
  gtin: p.gtin,
  item_code: p.itemCode,
  name: p.name,
  uom: p.uom,
  units_per_case: p.unitsPerCase,
  list_price: p.listPrice,
  vat_rate: p.vatRate,
  units_per_pallet: p.unitsPerPallet,
  unit_weight_kg: p.unitWeightKg,
});

/** `{gtin: product}` as Python's `_products(erp)`. */
export function productsByGtin(erp: Erp): Record<string, ProductDict & DocProduct> {
  return Object.fromEntries(erp.products().map((p) => [p.gtin, productDict(p)]));
}

export const retailerDict = (r: Retailer | undefined | null): (DocBuyer & { gln: string }) | null =>
  r
    ? {
        gln: r.gln,
        name: r.name,
        vat_id: r.vatId,
        address: r.address,
        cap: r.cap,
        comune: r.comune,
        provincia: r.provincia,
        sdi_code: r.sdiCode,
        delivery_point: r.deliveryPoint,
      }
    : null;

/** The quantity to ship on an order line: confirmed, else ordered. */
export const lineWant = (l: { qtyConfirmed: number | null; qtyOrdered: number | null }) => Number(l.qtyConfirmed !== null ? l.qtyConfirmed : l.qtyOrdered || 0);

/** No-op kept for parity: the si_* tables are in the shared DDL (agent/lib/db/schema.ts). */
export function ensureSchema(_erp: Erp): void {}

// ----- exceptions -------------------------------------------------------------

export function recordException(
  erp: Erp,
  e: {
    type: string;
    severity: string;
    orderRef: string | null;
    explanation: string;
    evidence?: Json | null;
    truckId?: string | null;
    palletId?: string | null;
    shipmentRef?: string | null;
    invoiceRef?: string | null;
    financialImpactEur?: number | null;
  },
): ShippingException {
  const exc: ShippingException = {
    exception_id: erp.nextId("si_exception", "EXC-"),
    type: e.type,
    severity: e.severity,
    order_ref: e.orderRef,
    truck_id: e.truckId ?? null,
    pallet_id: e.palletId ?? null,
    shipment_ref: e.shipmentRef ?? null,
    invoice_ref: e.invoiceRef ?? null,
    explanation: e.explanation,
    evidence: e.evidence ?? {},
    financial_impact_eur: e.financialImpactEur ?? null,
    at: nowIso(),
  };
  run(erp, "INSERT INTO si_exceptions(exception_id, status, data) VALUES(?,?,?)", exc.exception_id, "open", JSON.stringify(exc));
  erp.log("code", `shipping.exception.${e.type}`, e.orderRef, { sourceDoc: exc.exception_id, detail: e.explanation });
  return exc;
}

export function exception(erp: Erp, exceptionId: string): ShippingException | undefined {
  return withData<ShippingException>(one(erp, "SELECT * FROM si_exceptions WHERE exception_id = ?", exceptionId));
}

export function exceptions(erp: Erp, orderRef?: string): ShippingException[] {
  return all(erp, "SELECT * FROM si_exceptions ORDER BY exception_id")
    .map((r) => withData<ShippingException>(r)!)
    .filter((e) => !orderRef || e.order_ref === orderRef);
}

// ----- trucks and planning ------------------------------------------------------

/**
 * Each truck: truck_id, plate, destination, pallet_capacity, max_payload_kg, optional window
 * [from, to] (YYYY-MM-DD), compatible_routes [destinations], available.
 */
export function registerTrucks(erp: Erp, trucksIn: Truck[]): string[] {
  const ids: string[] = [];
  for (const t of trucksIn) {
    const data = { available: true, compatible_routes: [], ...t };
    run(erp, "INSERT OR REPLACE INTO si_trucks(truck_id, data) VALUES(?, ?)", t.truck_id, JSON.stringify(data));
    ids.push(t.truck_id);
    erp.log("code", "shipping.truck_registered", t.truck_id, { detail: data });
  }
  return ids;
}

export function truck(erp: Erp, truckId: string): Truck | undefined {
  const row = one<{ data: string }>(erp, "SELECT * FROM si_trucks WHERE truck_id = ?", truckId);
  return row ? (JSON.parse(row.data) as Truck) : undefined;
}

export function trucks(erp: Erp): Truck[] {
  return all<{ data: string }>(erp, "SELECT data FROM si_trucks ORDER BY truck_id").map((r) => JSON.parse(r.data) as Truck);
}

export function manifests(erp: Erp, status?: string): Manifest[] {
  const rows = status
    ? all(erp, "SELECT * FROM si_manifests WHERE status = ? ORDER BY manifest_id", status)
    : all(erp, "SELECT * FROM si_manifests ORDER BY manifest_id");
  return rows.map((r) => withData<Manifest>(r)!);
}

export function manifestForOrder(erp: Erp, orderRef: string): Manifest | undefined {
  return manifests(erp).find((m) => m.status !== "cancelled" && m.orders.includes(orderRef));
}

/** Pallets and weight of an order, from product data. Missing data stops the plan. */
export function orderLoad(erp: Erp, orderRef: string): OrderLoad {
  const order = erp.order(orderRef)!;
  const retailer = erp.retailer(order.buyerGln);
  let pallets = 0;
  let weight = 0;
  const missing: string[] = [];
  for (const line of order.lines) {
    const product = erp.product({ gtin: line.gtin });
    const q = lineWant(line);
    if (!product?.unitsPerPallet || !product?.unitWeightKg) {
      missing.push(product?.itemCode || line.gtin || "");
      continue;
    }
    pallets += Math.ceil(q / product.unitsPerPallet);
    weight += q * product.unitWeightKg;
  }
  const notes = order.notes ?? {};
  const window = (notes.delivery_window as [string, string] | undefined) ?? null;
  return { order_ref: orderRef, pallets, weight_kg: pyRound(weight, 1), missing_data: missing, destination: retailer?.deliveryPoint ?? null, window };
}

function overlap(a: [string, string] | null | undefined, b: [string, string] | null | undefined): boolean {
  if (!a?.length || !b?.length) return true;
  return a[0] <= b[1] && b[0] <= a[1];
}

function used(erp: Erp, truckId: string): [number, number, (string | null)[]] {
  let pallets = 0;
  let weight = 0;
  const dests: (string | null)[] = [];
  for (const m of manifests(erp)) {
    if (m.truck_id === truckId && (m.status === "planned" || m.status === "loaded")) {
      pallets += m.pallets;
      weight += m.weight_kg;
      dests.push(...m.destinations);
    }
  }
  return [pallets, weight, dests];
}

/** Why this truck cannot take this order, in the planner's order of checks. Empty = fits. */
export function truckFits(erp: Erp, t: Truck, load: OrderLoad): string[] {
  const problems: string[] = [];
  if (!(t.available ?? true)) problems.push("TRUCK_UNAVAILABLE");
  const [usedP, usedW, dests] = used(erp, t.truck_id);
  const routes = new Set<string | null | undefined>([t.destination, ...(t.compatible_routes ?? [])]);
  if (!routes.has(load.destination) || dests.some((d) => !routes.has(d))) problems.push("DESTINATION_MISMATCH");
  if (!overlap(t.window, load.window)) problems.push("DELIVERY_WINDOW");
  if (usedP + load.pallets > t.pallet_capacity) problems.push("TRUCK_CAPACITY_EXCEEDED");
  if (usedW + load.weight_kg > t.max_payload_kg) problems.push("TRUCK_WEIGHT_EXCEEDED");
  return problems;
}

export type PlanResult = { planned: { order_ref: string; truck_id: string; manifest_id: string }[]; exceptions: ShippingException[] };

/** Assign each whole order to the first truck that fits. Writes manifests, never stock. */
export function planTruckLoads(erp: Erp, orderRefs: string[], opts: { onlyTruckId?: string | null } = {}): PlanResult {
  const planned: PlanResult["planned"] = [];
  const failures: ShippingException[] = [];
  for (const ref of orderRefs) {
    const order = erp.order(ref);
    if (!order || order.status !== "ready_to_ship") {
      failures.push(recordException(erp, { type: "ORDER_NOT_READY", severity: "medium", orderRef: ref, explanation: `order ${ref} is not ready to ship` }));
      continue;
    }
    if (manifestForOrder(erp, ref)) continue;
    const load = orderLoad(erp, ref);
    if (load.missing_data.length) {
      failures.push(
        recordException(erp, {
          type: "PLAN_MISSING_PRODUCT_DATA",
          severity: "high",
          orderRef: ref,
          explanation: `no pallet size or unit weight for ${load.missing_data.join(", ")}: the plan stops`,
          evidence: load,
        }),
      );
      continue;
    }
    const candidates = trucks(erp).filter((t) => !opts.onlyTruckId || t.truck_id === opts.onlyTruckId);
    let chosen: Truck | null = null;
    const why: Record<string, string[]> = {};
    for (const t of candidates) {
      const problems = truckFits(erp, t, load);
      if (!problems.length) {
        chosen = t;
        break;
      }
      why[t.truck_id] = problems;
    }
    if (!chosen) {
      const whyKeys = Object.keys(why);
      const first = whyKeys.length ? (why[whyKeys[0]][0] ?? "NO_TRUCK") : "NO_TRUCK";
      failures.push(
        recordException(erp, {
          type: first,
          severity: "high",
          orderRef: ref,
          truckId: whyKeys[0] ?? null,
          explanation: `order ${ref} (${load.pallets} pallets, ${pyG(load.weight_kg)} kg) fits no truck`,
          evidence: { load, trucks: why },
        }),
      );
      continue;
    }
    const manifestId = erp.nextId("si_manifest", "MAN-");
    const data = { orders: [ref], pallets: load.pallets, weight_kg: load.weight_kg, destinations: [load.destination], physically_loaded: false, dispatched: false };
    run(erp, "INSERT INTO si_manifests(manifest_id, truck_id, status, data) VALUES(?,?,?,?)", manifestId, chosen.truck_id, "planned", JSON.stringify(data));
    erp.log("code", "shipping.planned", ref, { sourceDoc: manifestId, detail: { truck: chosen.truck_id, ...load } });
    planned.push({ order_ref: ref, truck_id: chosen.truck_id, manifest_id: manifestId });
  }
  return { planned, exceptions: failures };
}

function setManifest(erp: Erp, manifestId: string, status: string, data: Partial<Manifest> = {}) {
  const current = withData<Manifest>(one(erp, "SELECT * FROM si_manifests WHERE manifest_id = ?", manifestId))!;
  const payload = {
    orders: current.orders,
    pallets: current.pallets,
    weight_kg: current.weight_kg,
    destinations: current.destinations,
    physically_loaded: current.physically_loaded,
    dispatched: current.dispatched,
    ...data,
  };
  run(erp, "UPDATE si_manifests SET status = ?, data = ? WHERE manifest_id = ?", status, JSON.stringify(payload), manifestId);
}

/** Release a plan before loading. After a loading record or dispatch it stays locked. */
export function cancelTruckPlan(erp: Erp, orderRef: string): boolean {
  const m = manifestForOrder(erp, orderRef);
  if (!m) return false;
  if (m.status !== "planned" || loadingFor(erp, orderRef)) {
    throw new Error(`${m.manifest_id} is ${m.status}: a loaded or dispatched plan stays locked`);
  }
  setManifest(erp, m.manifest_id, "cancelled");
  erp.log("code", "shipping.plan_cancelled", orderRef, { sourceDoc: m.manifest_id });
  return true;
}

export function reviseTruckPlan(erp: Erp, orderRef: string, opts: { truckId: string }): PlanResult {
  cancelTruckPlan(erp, orderRef);
  return planTruckLoads(erp, [orderRef], { onlyTruckId: opts.truckId });
}

// ----- picking, scans, loading ----------------------------------------------------

/** Pallets to pick, batch first in first out. Copies the truck from the manifest. No stock moves. */
export function createPickingList(erp: Erp, orderRef: string): Pallet[] {
  const existing = pallets(erp, orderRef);
  if (existing.length) return existing;
  const order = erp.order(orderRef)!;
  const m = manifestForOrder(erp, orderRef);
  let n = 0;
  erp.tx(() => {
    for (const line of order.lines) {
      if (!line.gtin) continue;
      const product = erp.product({ gtin: line.gtin });
      const per = product?.unitsPerPallet || 10 ** 9;
      let want = lineWant(line);
      for (const b of batches(erp, line.gtin, "released")) {
        let free = b.qty - reserved(erp, b.batch);
        while (want > 0 && free > 0) {
          const q = Math.min(per, want, free);
          n += 1;
          run(
            erp,
            "INSERT INTO si_pallets(pallet_id, order_ref, gtin, batch, qty, status, manifest_id, truck_id) VALUES(?,?,?,?,?,?,?,?)",
            `PAL-${orderRef}-${String(n).padStart(2, "0")}`,
            orderRef,
            line.gtin,
            b.batch,
            q,
            "picked",
            m ? m.manifest_id : null,
            m ? m.truck_id : null,
          );
          want -= q;
          free -= q;
        }
      }
    }
  });
  erp.log("code", "shipping.picking_list", orderRef, { detail: { pallets: n } });
  return pallets(erp, orderRef);
}

export function reserved(erp: Erp, batch: string): number {
  const row = one<{ q: number }>(erp, "SELECT COALESCE(SUM(qty), 0) AS q FROM si_pallets WHERE batch = ? AND status IN ('picked','verified','loaded')", batch);
  return row ? Number(row.q) : 0;
}

export function pallets(erp: Erp, orderRef: string): Pallet[] {
  return all<Pallet>(erp, "SELECT * FROM si_pallets WHERE order_ref = ? ORDER BY pallet_id", orderRef);
}

export function pallet(erp: Erp, palletId: string | null | undefined): Pallet | undefined {
  return palletId ? one<Pallet>(erp, "SELECT * FROM si_pallets WHERE pallet_id = ?", palletId) : undefined;
}

export function batchStatus(erp: Erp, batch: string | null): string | null {
  const row = one<{ status: string }>(erp, "SELECT status FROM batches WHERE batch = ?", batch);
  return row ? row.status : null;
}

export type Scan = { pallet_id?: string; gtin?: string; batch?: string | null; qty?: number; truck_id?: string | null; [k: string]: unknown };
export type ScanRow = { id: number; pallet_id: string | null; order_ref: string | null; data: Scan; result: string; at: string };

export function scans(erp: Erp, orderRef: string): ScanRow[] {
  return all<Omit<ScanRow, "data"> & { data: string }>(erp, "SELECT * FROM si_scans WHERE order_ref = ? ORDER BY id", orderRef).map((r) => ({
    ...r,
    data: JSON.parse(r.data) as Scan,
  }));
}

/** Check each simulated scan {pallet_id, gtin, batch, qty, truck_id?} against the picking list. */
export function verifyScans(
  erp: Erp,
  orderRef: string,
  scansIn: Scan[],
  opts: { truckId?: string | null } = {},
): { results: { pallet_id: string | undefined; result: string }[]; exceptions: ShippingException[] } {
  const expected = new Map(pallets(erp, orderRef).map((p) => [p.pallet_id, p]));
  const seen = new Set([...expected.entries()].filter(([, row]) => row.status === "verified").map(([id]) => id));
  const results: { pallet_id: string | undefined; result: string }[] = [];
  const failures: ShippingException[] = [];
  for (const scan of scansIn) {
    const pid = scan.pallet_id;
    const p = pid !== undefined ? expected.get(pid) : undefined;
    const scanTruck = scan.truck_id || opts.truckId || null;
    let code = "OK";
    if (!p) code = "UNKNOWN_PALLET";
    else if (seen.has(pid!)) code = "DUPLICATE_SCAN";
    else if ((scan.gtin ?? null) !== p.gtin) code = "WRONG_PRODUCT";
    else if ((scan.batch ?? null) !== p.batch) code = "WRONG_BATCH";
    else if (Number(scan.qty || 0) !== Number(p.qty)) code = "BAD_QUANTITY";
    else if (batchStatus(erp, p.batch) === "hold") code = "QUALITY_HOLD";
    else if (p.truck_id && scanTruck && scanTruck !== p.truck_id) code = "WRONG_TRUCK";
    run(erp, "INSERT INTO si_scans(pallet_id, order_ref, data, result, at) VALUES(?,?,?,?,?)", pid ?? null, orderRef, JSON.stringify(scan), code, nowIso());
    if (code === "OK") {
      seen.add(pid!);
      run(erp, "UPDATE si_pallets SET status = 'verified' WHERE pallet_id = ?", pid);
    } else {
      if (p && code !== "DUPLICATE_SCAN") run(erp, "UPDATE si_pallets SET status = 'rejected' WHERE pallet_id = ?", pid);
      failures.push(
        recordException(erp, {
          type: code,
          severity: ["QUALITY_HOLD", "WRONG_TRUCK", "WRONG_PRODUCT"].includes(code) ? "high" : "medium",
          orderRef,
          palletId: pid ?? null,
          truckId: scanTruck,
          explanation: `pallet ${pid}: ${code.replace(/_/g, " ").toLowerCase()}`,
          evidence: { scan, expected: p ?? null },
        }),
      );
    }
    results.push({ pallet_id: pid, result: code });
  }
  return { results, exceptions: failures };
}

export type Loading = { loading_id: string; order_ref: string; truck_id: string | null; manifest_id: string | null; pallets: string[]; exceptions: string[]; at: string };

export function loadingFor(erp: Erp, orderRef: string): Loading | undefined {
  const rows = all(erp, "SELECT * FROM si_loadings WHERE order_ref = ? ORDER BY loading_id", orderRef);
  return rows.length ? withData<Loading>(rows[rows.length - 1]) : undefined;
}

/** Load the verified pallets. A pallet on the list that was never verified is MISSING_PALLET. */
export function confirmLoading(
  erp: Erp,
  orderRef: string,
  opts: { truckId?: string | null } = {},
): { loading_id: string; truck_id: string | null; pallets: string[]; exceptions: ShippingException[] } {
  const m = manifestForOrder(erp, orderRef);
  const theTruck = opts.truckId || (m ? m.truck_id : null);
  const loaded: string[] = [];
  const failures: ShippingException[] = [];
  for (const p of pallets(erp, orderRef)) {
    if (p.status === "verified") {
      if (m && theTruck !== m.truck_id) {
        failures.push(
          recordException(erp, {
            type: "WRONG_TRUCK",
            severity: "high",
            orderRef,
            palletId: p.pallet_id,
            truckId: theTruck,
            explanation: `pallet ${p.pallet_id} is planned on ${m.truck_id}, not ${theTruck}`,
          }),
        );
        continue;
      }
      run(erp, "UPDATE si_pallets SET status = 'loaded', truck_id = ? WHERE pallet_id = ?", theTruck, p.pallet_id);
      loaded.push(p.pallet_id);
    } else if (p.status === "picked" || p.status === "rejected") {
      failures.push(
        recordException(erp, {
          type: "MISSING_PALLET",
          severity: "high",
          orderRef,
          palletId: p.pallet_id,
          truckId: theTruck,
          explanation: `pallet ${p.pallet_id} (${pyG(p.qty)} units) is not on the truck`,
          evidence: { pallet: p },
        }),
      );
    }
  }
  const loadingId = erp.nextId("si_loading", "LOAD-");
  run(
    erp,
    "INSERT INTO si_loadings(loading_id, order_ref, truck_id, manifest_id, data) VALUES(?,?,?,?,?)",
    loadingId,
    orderRef,
    theTruck,
    m ? m.manifest_id : null,
    JSON.stringify({ pallets: loaded, exceptions: failures.map((f) => f.exception_id), at: nowIso() }),
  );
  if (m && loaded.length) setManifest(erp, m.manifest_id, "loaded", { physically_loaded: true });
  erp.log("code", "shipping.loaded", orderRef, { sourceDoc: loadingId, detail: { truck: theTruck, pallets: loaded } });
  return { loading_id: loadingId, truck_id: theTruck, pallets: loaded, exceptions: failures };
}

export type DispatchResult = {
  dispatched: boolean;
  desadv_ref?: string;
  ddt_ref?: string;
  truck_id?: string | null;
  manifest_id?: string | null;
  short?: string[];
  exceptions: ShippingException[];
};

/** Write the shipment from the loaded pallets: holds checked again, then stock leaves. */
export function authorizeDispatch(erp: Erp, orderRef: string, opts: { shipDate: string; truckId?: string | null }): DispatchResult {
  const loading = loadingFor(erp, orderRef);
  if (!loading) throw new Error(`order ${orderRef}: no loading record, nothing can be dispatched`);
  const m = manifestForOrder(erp, orderRef);
  const theTruck = opts.truckId || loading.truck_id;
  if (m && (loading.truck_id !== m.truck_id || loading.manifest_id !== m.manifest_id || theTruck !== m.truck_id)) {
    const exc = recordException(erp, {
      type: "WRONG_TRUCK",
      severity: "high",
      orderRef,
      truckId: theTruck,
      explanation: `dispatch on ${theTruck} but the plan is ${m.truck_id} (${m.manifest_id})`,
    });
    return { dispatched: false, exceptions: [exc] };
  }
  const order = erp.order(orderRef)!;
  const products = productsByGtin(erp);
  const lines: { gtin: string; batch: string | null; qty: number; pallet_id: string }[] = [];
  const failures: ShippingException[] = [];
  for (const p of pallets(erp, orderRef)) {
    if (p.status !== "loaded") continue;
    if (batchStatus(erp, p.batch) === "hold") {
      failures.push(
        recordException(erp, {
          type: "QUALITY_HOLD",
          severity: "high",
          orderRef,
          palletId: p.pallet_id,
          explanation: `batch ${p.batch} went on hold before dispatch; the pallet stays off`,
        }),
      );
      run(erp, "UPDATE si_pallets SET status = 'rejected' WHERE pallet_id = ?", p.pallet_id);
      continue;
    }
    run(erp, "UPDATE batches SET qty = qty - ? WHERE batch = ?", p.qty, p.batch);
    run(erp, "UPDATE si_pallets SET status = 'dispatched' WHERE pallet_id = ?", p.pallet_id);
    lines.push({ gtin: p.gtin, batch: p.batch, qty: p.qty, pallet_id: p.pallet_id });
  }
  if (!lines.length) return { dispatched: false, exceptions: failures };

  const shipped: Record<string, number> = {};
  for (const l of lines) shipped[l.gtin] = (shipped[l.gtin] ?? 0) + l.qty;
  const gaps: string[] = [];
  for (const line of order.lines) {
    const want = lineWant(line);
    const got = shipped[line.gtin ?? ""] ?? 0;
    if (got < want) {
      const off = pallets(erp, orderRef)
        .filter((p) => p.gtin === line.gtin && p.status !== "dispatched")
        .map((p) => p.pallet_id);
      const held = batches(erp, line.gtin ?? "", "hold").map((b) => b.batch);
      let why: string;
      if (off.length) why = `pallets ${off.join(", ")} kept off`;
      else if (held.length) why = `quality hold on ${held.join(", ")}`;
      else why = "not enough released stock to pick";
      gaps.push(`${products[line.gtin ?? ""].item_code}: ${pyG(want - got)} of ${pyG(want)} not shipped (${why})`);
    }
  }
  const n = erp.shipments(orderRef).length + 1;
  const desadvRef = `DESADV-${orderRef}-${n}`;
  const ddtRef = `DDT-${orderRef}-${n}`;
  const retailer = retailerDict(erp.retailer(order.buyerGln));
  const desadvDoc = erp.addDocument(
    "DESADV",
    desadvRef,
    buildDesadv({
      desadvRef,
      orderRef,
      shipDate: opts.shipDate,
      buyerGln: order.buyerGln,
      supplierGln: order.supplierGln,
      deliveryPoint: retailer?.delivery_point ?? null,
      lines,
    }),
  );
  erp.addDocument("DDT", ddtRef, buildDdt({ ddtRef, desadvRef, orderRef, shipDate: opts.shipDate, buyer: retailer, lines, products }));
  const note = gaps.length ? gaps.join("; ") : null;
  erp.saveShipment({
    desadvRef,
    orderRef,
    shipDate: opts.shipDate,
    ddtRef,
    lines: lines.map((l) => ({ gtin: l.gtin, batch: l.batch, qty: l.qty })),
    sourceDoc: desadvDoc,
    notes: note,
  });
  const notes: Json = { ...(order.notes ?? {}) };
  notes.truck_id = theTruck;
  notes.manifest_id = m ? m.manifest_id : null;
  if (gaps.length) notes.fulfilment_gap = note;
  erp.setOrder(orderRef, { status: "shipped", notes });
  if (m) setManifest(erp, m.manifest_id, "dispatched", { physically_loaded: true, dispatched: true });
  erp.log("code", "shipping.dispatched", orderRef, {
    sourceDoc: desadvDoc,
    detail: { truck: theTruck, manifest: m ? m.manifest_id : null, short: gaps },
  });
  return { dispatched: true, desadv_ref: desadvRef, ddt_ref: ddtRef, truck_id: theTruck, manifest_id: m ? m.manifest_id : null, short: gaps, exceptions: failures };
}

export function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
