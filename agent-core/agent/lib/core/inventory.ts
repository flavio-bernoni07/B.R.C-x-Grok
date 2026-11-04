/**
 * Inventory per product and batch, read from the one Mini ERP (no second ledger):
 *
 *   physical on hand   = released + quality held (what is in the warehouse)
 *   reserved           = confirmed orders not shipped yet (committedQty)
 *   available to promise = released + planned − reserved (held never counts)
 *   dispatched         = quantities on shipments (DESADV); in transit = shipped with no signed DDT yet
 *   planned production = planned batches not finished yet
 */
import type { Erp } from "./erp";
import { allBatches, availableToPromise } from "./stock";

export type InventoryProduct = {
  gtin: string;
  itemCode: string;
  name: string;
  uom: string;
  physical: number;
  released: number;
  held: number;
  reserved: number;
  atp: number;
  dispatched: number;
  inTransit: number;
  planned: number;
  batches: { batch: string; status: string; qty: number; availableFrom: string | null; source: string | null }[];
};

export function inventory(erp: Erp, opts: { byDate?: string | null } = {}): { asOf: string; products: InventoryProduct[] } {
  const shipped: Record<string, { all: number; transit: number }> = {};
  for (const sh of erp.shipments()) {
    const delivered = erp.proofs(sh.orderRef).some((p) => p.ref === sh.ddtRef);
    for (const l of sh.lines) {
      const s = (shipped[l.gtin] ??= { all: 0, transit: 0 });
      s.all += l.qty;
      if (!delivered) s.transit += l.qty;
    }
  }
  const bs = allBatches(erp);
  const products = erp
    .products()
    .map((p) => {
      const a = availableToPromise(erp, p.gtin, opts.byDate ?? null);
      const plannedAll = bs.filter((b) => b.gtin === p.gtin && b.status === "planned").reduce((x, b) => x + b.qty, 0);
      return {
        gtin: p.gtin,
        itemCode: p.itemCode,
        name: p.name,
        uom: p.uom,
        physical: a.released + a.held,
        released: a.released,
        held: a.held,
        reserved: a.committed,
        atp: a.atp,
        dispatched: shipped[p.gtin]?.all ?? 0,
        inTransit: shipped[p.gtin]?.transit ?? 0,
        planned: plannedAll,
        batches: bs
          .filter((b) => b.gtin === p.gtin)
          .map((b) => ({ batch: b.batch, status: b.status, qty: b.qty, availableFrom: b.availableFrom, source: b.sourceDoc })),
      };
    })
    .filter((p) => p.physical + p.planned + p.reserved + p.dispatched > 0);
  return { asOf: new Date().toISOString(), products };
}
