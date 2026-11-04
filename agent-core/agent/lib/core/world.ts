/** Load the one fake world (products, retailers, starting stock) into a Mini ERP (port of core/world.py). */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../paths";
import { Erp } from "./erp";
import { recordEvent } from "./stock";

type RawProduct = {
  gtin: string;
  item_code: string;
  name: string;
  uom: string;
  units_per_case?: number;
  list_price?: number | null;
  vat_rate: number;
  units_per_pallet?: number | null;
  unit_weight_kg?: number | null;
};
type RawRetailer = Record<string, string | null> & { gln: string; name: string };
type RawEvent = { kind: string; batch: string; gtin?: string; qty?: number; available_from?: string; note?: string };

export const worldDir = () => dataPath("world");

export function loadWorld(erp: Erp, dir = worldDir()): Erp {
  const read = <T>(f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T;
  for (const p of read<{ products: RawProduct[] }>("products.json").products) {
    erp.upsertProduct({
      gtin: p.gtin,
      itemCode: p.item_code,
      name: p.name,
      uom: p.uom,
      unitsPerCase: p.units_per_case ?? 1,
      listPrice: p.list_price ?? null,
      vatRate: p.vat_rate,
      unitsPerPallet: p.units_per_pallet ?? null,
      unitWeightKg: p.unit_weight_kg ?? null,
    });
  }
  for (const r of read<{ retailers: RawRetailer[] }>("retailers.json").retailers) {
    erp.upsertRetailer({
      gln: r.gln,
      name: r.name,
      vatId: r.vat_id,
      address: r.address,
      cap: r.cap,
      comune: r.comune,
      provincia: r.provincia,
      sdiCode: r.sdi_code,
      deliveryPoint: r.delivery_point,
    });
  }
  for (const e of read<{ events: RawEvent[] }>("stock.json").events) {
    recordEvent(erp, e.kind, { batch: e.batch, gtin: e.gtin, qty: e.qty, availableFrom: e.available_from, note: e.note });
  }
  erp.log("code", "world.loaded", null, { detail: { from: dir } });
  return erp;
}

/** A new database with the world loaded. Deletes an existing file at `path`. */
export function freshErp(path = ":memory:", dir = worldDir()): Erp {
  if (path !== ":memory:") for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) unlinkSync(f);
  return loadWorld(new Erp(path), dir);
}
