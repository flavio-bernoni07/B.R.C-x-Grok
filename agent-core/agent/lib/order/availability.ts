/**
 * Availability hook (port of order/availability.py). The stub reads
 * `data/orders/availability_stub.json`; `ErpAvailabilityProvider` reads available-to-promise
 * from the shared Mini ERP. Same interface, so the checks do not change.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Erp } from "../core/erp";
import { availableToPromise } from "../core/stock";
import { dataPath } from "../paths";
import { pyG } from "./py";

export const defaultStubPath = () => dataPath("orders", "availability_stub.json");

export type AvailabilityQuery = {
  gtin: string;
  buyer_gln: string | null;
  supplier_gln: string | null;
  requested_date: string | null; // YYYYMMDD
};

export type AvailabilityResult = { gtin: string; available_qty: number; source: string; found: boolean };

export interface AvailabilityProvider {
  getAvailability(query: AvailabilityQuery): AvailabilityResult;
}

type StubRow = { gtin?: string; buyer_gln?: string; available_qty?: number; source?: string };

/** Reads `data/orders/availability_stub.json`. */
export class StubAvailabilityProvider implements AvailabilityProvider {
  readonly path: string;
  private readonly rows: StubRow[];

  constructor(path?: string | null) {
    this.path = path || defaultStubPath();
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as { rows?: StubRow[] };
    this.rows = [...(raw.rows ?? [])];
  }

  getAvailability(query: AvailabilityQuery): AvailabilityResult {
    for (const row of this.rows) {
      if (row.gtin !== query.gtin) continue;
      const buyer = row.buyer_gln;
      if (buyer && query.buyer_gln && buyer !== query.buyer_gln) continue;
      return { gtin: query.gtin, available_qty: Number(row.available_qty || 0), source: String(row.source || basename(this.path)), found: true };
    }
    return { gtin: query.gtin, available_qty: 0, source: "stub_miss", found: false };
  }
}

export function getAvailability(query: AvailabilityQuery, provider?: AvailabilityProvider | null): AvailabilityResult {
  return (provider ?? new StubAvailabilityProvider()).getAvailability(query);
}

/**
 * Reads available-to-promise from the shared Mini ERP (core/stock.ts).
 *
 * available = released stock + planned batches ready by the requested date
 *           - confirmed orders not shipped yet. Held batches never count.
 */
export class ErpAvailabilityProvider implements AvailabilityProvider {
  constructor(readonly erp: Erp) {}

  getAvailability(query: AvailabilityQuery): AvailabilityResult {
    if (!this.erp.product({ gtin: query.gtin })) {
      return { gtin: query.gtin, available_qty: 0, source: "erp_unknown_gtin", found: false };
    }
    const atp = availableToPromise(this.erp, query.gtin, query.requested_date);
    return {
      gtin: query.gtin,
      available_qty: atp.atp,
      source: `erp_atp(released ${pyG(atp.released)} + planned ${pyG(atp.planned)} - committed ${pyG(atp.committed)})`,
      found: true,
    };
  }
}
