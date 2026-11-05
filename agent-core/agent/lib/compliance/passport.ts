/**
 * Lot compliance passport: EU food-law docs keyed by milled batch (demo fixtures).
 *
 * Reg (EC) 178/2002 Art. 18 — one step back / one step forward.
 * Dir 2011/91/EU — lot mark. Reg 396/2005 — MRLs. Decision 2011/884/EU — China rice GMO papers
 * (import demo only). Italian origin labelling — DM 26 Jul 2017. Plant IFS/BRC are retailer gates,
 * not EU regulations. Rice is not an EUDR commodity.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Erp } from "../core/erp";
import { dataPath } from "../paths";

export type ComplianceDoc = { docId: string; kind: string; href: string; label: string };

export type LotPassport = {
  batch: string;
  gtin: string | null;
  product: string | null;
  lotMark: string;
  variety: string;
  status: "ok" | "gap";
  statusText: string;
  origin: { cultivation: string; processing: string; packing: string; label: string };
  oneStepBack: {
    intakeId: string;
    supplier: string;
    region: string;
    farm: string;
    receivedOn: string;
    tonnes: number;
  };
  oneStepForward: { orderRef: string; retailer: string | null; qty: number; desadv: string | null }[];
  mrl: { status: string; lab: string; reportId: string; testedOn: string; summary: string };
  gmo: { status: string; declarationId: string | null; summary: string };
  plant: { name: string; certs: { id: string; scheme: string; validTo: string; level?: string }[] };
  badges: string[];
  missingDocs: string[];
  documents: ComplianceDoc[];
  batchStatus: string | null;
  sources: string[];
};

type RawOrigin = { cultivation: string; processing: string; packing: string; label: string };
type RawIntake = { id: string; supplier: string; region: string; farm: string; received_on: string; tonnes: number };
type RawMrl = { status: string; lab: string; report_id: string; tested_on: string; summary: string };
type RawGmo = { status: string; declaration_id: string | null; summary: string };
type RawBatch = {
  batch: string;
  gtin: string;
  lot_mark: string;
  variety: string;
  origin: RawOrigin;
  paddy_intake: RawIntake;
  mrl: RawMrl;
  gmo: RawGmo;
  badges: string[];
  required_docs: string[];
  missing_docs: string[];
  hold_on_seed?: boolean;
  hold_note?: string;
};
type RawPlantCert = { id: string; scheme: string; level?: string; valid_to: string; body: string; note: string };
type RawPlant = { plant: string; certs: RawPlantCert[] };

const complianceDir = () => dataPath("world", "compliance");

function readJson<T>(file: string): T | null {
  const path = join(complianceDir(), file);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

let cached: { plant: RawPlant; byBatch: Map<string, RawBatch> } | null = null;

function loadFixtures() {
  if (cached) return cached;
  const plant = readJson<RawPlant>("plant.json");
  const batches = readJson<{ batches: RawBatch[] }>("batches.json");
  if (!plant || !batches) throw new Error("data/world/compliance fixtures missing (plant.json / batches.json)");
  const byBatch = new Map(batches.batches.map((b) => [b.batch, b]));
  cached = { plant, byBatch };
  return cached;
}

/** Normalise LOT-C-0418-HOLD → LOT-C-0418 for passport lookup. */
export function baseBatch(batch: string): string {
  return batch.endsWith("-HOLD") ? batch.slice(0, -5) : batch;
}

export function rawBatches(): RawBatch[] {
  return [...loadFixtures().byBatch.values()];
}

export function plantInfo(): RawPlant {
  return loadFixtures().plant;
}

function docsForBatch(erp: Erp, batch: string): ComplianceDoc[] {
  return erp.documents({ ref: batch }).map((d) => ({
    docId: d.docId,
    kind: d.kind,
    href: `/api/documents/${encodeURIComponent(d.docId)}`,
    label: d.kind,
  }));
}

function customersOf(erp: Erp, batch: string): LotPassport["oneStepForward"] {
  const out: LotPassport["oneStepForward"] = [];
  const want = new Set([batch, `${batch}-HOLD`]);
  for (const o of erp.orders()) {
    for (const sh of erp.shipments(o.orderRef)) {
      let qty = 0;
      for (const line of sh.lines) {
        if (line.batch && want.has(line.batch)) qty += line.qty;
      }
      if (!qty) continue;
      const retailer = erp.retailer(o.buyerGln)?.name ?? null;
      out.push({ orderRef: o.orderRef, retailer, qty, desadv: sh.desadvRef });
    }
  }
  return out;
}

export function passport(erp: Erp, batchId: string): LotPassport | null {
  const { plant, byBatch } = loadFixtures();
  const key = baseBatch(batchId);
  const raw = byBatch.get(key);
  if (!raw) return null;
  const missing = raw.missing_docs ?? [];
  const status: "ok" | "gap" = missing.length || raw.gmo.status === "gap" ? "gap" : "ok";
  const batchRow = erp.sqlite.prepare("SELECT batch, gtin, qty, status FROM batches WHERE batch = ? OR batch = ?").get(key, `${key}-HOLD`) as
    | { batch: string; gtin: string; qty: number; status: string }
    | undefined;
  const product = erp.product({ gtin: raw.gtin })?.name ?? null;
  return {
    batch: key,
    gtin: raw.gtin,
    product,
    lotMark: raw.lot_mark,
    variety: raw.variety,
    status,
    statusText: status === "ok" ? "Docs on file" : `Missing: ${missing.join(", ") || "GMO papers"}`,
    origin: raw.origin,
    oneStepBack: {
      intakeId: raw.paddy_intake.id,
      supplier: raw.paddy_intake.supplier,
      region: raw.paddy_intake.region,
      farm: raw.paddy_intake.farm,
      receivedOn: raw.paddy_intake.received_on,
      tonnes: raw.paddy_intake.tonnes,
    },
    oneStepForward: customersOf(erp, key),
    mrl: {
      status: raw.mrl.status,
      lab: raw.mrl.lab,
      reportId: raw.mrl.report_id,
      testedOn: raw.mrl.tested_on,
      summary: raw.mrl.summary,
    },
    gmo: {
      status: raw.gmo.status,
      declarationId: raw.gmo.declaration_id,
      summary: raw.gmo.summary,
    },
    plant: {
      name: plant.plant,
      certs: plant.certs.map((c) => ({ id: c.id, scheme: c.scheme, validTo: c.valid_to, level: c.level })),
    },
    badges: raw.badges ?? [],
    missingDocs: missing,
    documents: docsForBatch(erp, key),
    batchStatus: batchRow?.status ?? null,
    sources: [
      "data/world/compliance/batches.json",
      "data/world/compliance/plant.json",
      "Reg (EC) 178/2002 Art. 18",
      "Reg (EC) 396/2005",
      "Dir 2011/91/EU",
      "DM 26 Jul 2017 (IT origin labelling)",
    ],
  };
}

export function passportsForOrder(erp: Erp, orderRef: string): LotPassport[] {
  const ids = new Set<string>();
  for (const sh of erp.shipments(orderRef)) {
    for (const line of sh.lines) if (line.batch) ids.add(baseBatch(line.batch));
  }
  // Also surface inventory batches for the order's products when nothing shipped yet.
  const order = erp.order(orderRef);
  if (order && !ids.size) {
    for (const line of order.lines) {
      if (!line.gtin) continue;
      for (const b of erp.sqlite.prepare("SELECT batch FROM batches WHERE gtin = ?").all(line.gtin) as { batch: string }[]) {
        if (loadFixtures().byBatch.has(baseBatch(b.batch))) ids.add(baseBatch(b.batch));
      }
    }
  }
  return [...ids].map((id) => passport(erp, id)).filter((p): p is LotPassport => !!p);
}

export type OrderCompliance = {
  orderRef: string;
  status: "ok" | "gap" | "none";
  statusText: string;
  passports: LotPassport[];
};

export function orderCompliance(erp: Erp, orderRef: string): OrderCompliance {
  const passports = passportsForOrder(erp, orderRef);
  if (!passports.length) return { orderRef, status: "none", statusText: "No lot passport for this order yet", passports: [] };
  const gap = passports.some((p) => p.status === "gap");
  return {
    orderRef,
    status: gap ? "gap" : "ok",
    statusText: gap ? "At least one lot has a compliance gap" : `${passports.length} lot${passports.length === 1 ? "" : "s"} with docs on file`,
    passports,
  };
}
