/**
 * Lot compliance passport: EU food-law docs keyed by milled batch.
 *
 * Explicit fixtures in data/world/compliance/ override the synthesizer. Any other batch in the
 * Mini ERP gets a demo passport from its product (Italian vs import). Only fixture lots with
 * missing_docs stay as gaps (Basmati LOT-B-0901).
 *
 * Reg (EC) 178/2002 Art. 18 — one step back / one step forward.
 * Dir 2011/91/EU — lot mark. Reg 396/2005 — MRLs. Decision 2011/884/EU — import GMO papers demo.
 * Italian origin labelling — DM 26 Jul 2017. Plant IFS/BRC are retailer gates. Rice is not EUDR.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Erp } from "../core/erp";
import { allBatches } from "../core/stock";
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
export type RawBatch = {
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

function lotMarkFrom(batch: string): string {
  const digits = batch.replace(/\D/g, "").slice(-6) || "000000";
  return `L26${digits}`;
}

function varietyFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("carnaroli")) return "Carnaroli";
  if (n.includes("arborio")) return "Arborio";
  if (n.includes("basmati")) return "Basmati";
  if (n.includes("jasmine") || n.includes("thai")) return "Thai Jasmine";
  if (n.includes("venere")) return "Venere";
  if (n.includes("ribe")) return "Ribe";
  if (n.includes("parboil")) return "Parboiled";
  if (n.includes("integrale")) return "Integrale";
  if (n.includes("sushi")) return "Sushi";
  if (n.includes("zafferano") || n.includes("asparagi") || n.includes("funghi") || n.includes("risotto")) return "Arborio";
  if (n.includes("gallette")) return "Ribe";
  if (n.includes("bevanda")) return "Ribe";
  return "Rice";
}

function isImportVariety(variety: string): boolean {
  return /basmati|jasmine|thai/i.test(variety);
}

/** Stable 0..n-1 from a batch id (for demo badges / farm names). */
function hashPick(batch: string, n: number): number {
  let h = 0;
  for (let i = 0; i < batch.length; i++) h = (h * 31 + batch.charCodeAt(i)) >>> 0;
  return h % n;
}

const IT_SUPPLIERS = [
  { supplier: "Cooperativa Agricola Vercelli Nord", region: "Vercelli (Piemonte)", farm: "Cascina Nuova" },
  { supplier: "Consorzio Riso Novarese", region: "Novara (Piemonte)", farm: "Azienda San Matteo" },
  { supplier: "Op. Riso Pavese", region: "Pavia (Lombardia)", farm: "Cascina Rosa" },
  { supplier: "Riso Lomellina Soc. Agr.", region: "Pavia (Lombardia)", farm: "Cascina Belvedere" },
];

/** Build a demo RawBatch for any milled lot that has no explicit fixture. */
export function synthesizeRaw(batch: string, gtin: string, productName: string): RawBatch {
  const variety = varietyFromName(productName);
  const imported = isImportVariety(variety);
  const suffix = batch.replace(/[^A-Za-z0-9]/g, "").slice(-4) || "0000";
  const pick = hashPick(batch, IT_SUPPLIERS.length);
  const it = IT_SUPPLIERS[pick]!;
  const badges: string[] = [];
  if (!imported) {
    badges.push("SRP");
    if (hashPick(batch, 5) === 0) badges.push("Fairtrade");
    if (hashPick(batch, 7) === 1) badges.push("BIO");
  }
  return {
    batch,
    gtin,
    lot_mark: lotMarkFrom(batch),
    variety,
    origin: imported
      ? {
          cultivation: variety.includes("Jasmine") || variety.includes("Thai") ? "Thailand" : "India",
          processing: "Italia",
          packing: "Italia",
          label:
            variety.includes("Jasmine") || variety.includes("Thai")
              ? "Paese di coltivazione: Thailand · Paese di lavorazione: Italia · Paese di confezionamento: Italia"
              : "Paese di coltivazione: India · Paese di lavorazione: Italia · Paese di confezionamento: Italia",
        }
      : {
          cultivation: "Italia",
          processing: "Italia",
          packing: "Italia",
          label: "origine del riso: Italia",
        },
    paddy_intake: imported
      ? {
          id: `IMP-${suffix}`,
          supplier: variety.includes("Jasmine") ? "Demo import desk — Thai jasmine" : "Demo import desk — Punjab basmati",
          region: variety.includes("Jasmine") ? "Central Plain (Thailand)" : "Punjab (India)",
          farm: "Consolidated export lot",
          received_on: "2026-10-12",
          tonnes: 18 + hashPick(batch, 20),
        }
      : {
          id: `PADDY-IT-${suffix}`,
          supplier: it.supplier,
          region: it.region,
          farm: it.farm,
          received_on: "2026-10-20",
          tonnes: 20 + hashPick(batch, 40),
        },
    mrl: {
      status: "pass",
      lab: "Demo lab Pavia",
      report_id: `LAB-MRL-${suffix}`,
      tested_on: "2026-10-21",
      summary: "Residues below Reg (EC) 396/2005 MRLs (demo).",
    },
    gmo: {
      status: "ok",
      declaration_id: `GMO-FREE-${suffix}`,
      summary: imported
        ? "Import lot with GMO-free analytical report on file (demo)."
        : "Italian paddy; GMO-free declaration on file.",
    },
    badges,
    required_docs: ["origin", "mrl", "gmo", "plant"],
    missing_docs: [],
  };
}

function resolveRaw(erp: Erp, key: string): RawBatch | null {
  const { byBatch } = loadFixtures();
  const fixed = byBatch.get(key);
  if (fixed) return fixed;
  const row = erp.sqlite.prepare("SELECT batch, gtin FROM batches WHERE batch = ? OR batch = ?").get(key, `${key}-HOLD`) as
    | { batch: string; gtin: string }
    | undefined;
  if (!row?.gtin) return null;
  const product = erp.product({ gtin: row.gtin });
  if (!product) return null;
  return synthesizeRaw(key, row.gtin, product.name);
}

function toPassport(erp: Erp, raw: RawBatch): LotPassport {
  const { plant } = loadFixtures();
  const key = raw.batch;
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
    statusText:
      status === "ok"
        ? "All required documents are on file"
        : `Missing ${missing.join(", ") || "required papers"} — lot cannot ship until a person confirms`,
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
      "data/world/compliance/",
      "Reg (EC) 178/2002 Art. 18",
      "Reg (EC) 396/2005",
      "Dir 2011/91/EU",
      "DM 26 Jul 2017 (IT origin labelling)",
    ],
  };
}

/** Passport for one milled batch: fixture if present, else synthesized from the product. */
export function passport(erp: Erp, batchId: string): LotPassport | null {
  const key = baseBatch(batchId);
  const raw = resolveRaw(erp, key);
  if (!raw) return null;
  return toPassport(erp, raw);
}

/** Spec used by the seeder to write source documents for every batch in the ERP. */
export function rawForSeed(erp: Erp, batchId: string): RawBatch | null {
  return resolveRaw(erp, baseBatch(batchId));
}

export function allPassportBatches(erp: Erp): string[] {
  const ids = new Set<string>();
  for (const b of allBatches(erp)) ids.add(baseBatch(b.batch));
  for (const b of rawBatches()) ids.add(b.batch);
  return [...ids].sort();
}

export function passportsForOrder(erp: Erp, orderRef: string): LotPassport[] {
  const ids = new Set<string>();
  for (const sh of erp.shipments(orderRef)) {
    for (const line of sh.lines) if (line.batch) ids.add(baseBatch(line.batch));
  }
  const order = erp.order(orderRef);
  if (order && !ids.size) {
    for (const line of order.lines) {
      if (!line.gtin) continue;
      for (const b of erp.sqlite.prepare("SELECT batch FROM batches WHERE gtin = ?").all(line.gtin) as { batch: string }[]) {
        ids.add(baseBatch(b.batch));
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
  if (!passports.length) return { orderRef, status: "none", statusText: "No lot on this order yet", passports: [] };
  const gap = passports.some((p) => p.status === "gap");
  return {
    orderRef,
    status: gap ? "gap" : "ok",
    statusText: gap
      ? "At least one lot needs compliance papers"
      : `${passports.length} lot${passports.length === 1 ? "" : "s"} with documents on file`,
    passports,
  };
}
