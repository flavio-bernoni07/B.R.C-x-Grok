/**
 * Annual supply contracts, one per retailer (demo data, data/world/contracts/*.json, written by
 * scripts/build-demo-world.ts). Each runs a year, is billed monthly and paid at 60 days
 * (D.Lgs. 198/2021), and carries the retailer's price list with volume tiers.
 *
 * The order row checks ORDERS prices against the retailer's contract (`supplyContractFor`); a
 * buyer with no contract file falls back to the default contract (data/orders/, Esselunga's), the
 * one the Python row reads. Read-only: nothing here writes a record.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadContract, type SupplyContract } from "../order/contract";
import { dataPath } from "../paths";
import { todayIso } from "./stock";

export type ContractPriceLine = {
  gtin: string;
  item_code: string;
  name: string;
  unit_price: number;
  volume_discounts: { min_qty: number; unit_price: number }[];
  annual_volume_units: number;
};

/** The contract file as stored (a JSON document: Python-style key names). */
export type SupplyContractDoc = {
  id: string;
  retailer: { gln: string; name: string };
  buyer_gln: string;
  buyer_name: string;
  supplier_gln: string;
  supplier_name: string;
  currency: string;
  start: string;
  end: string;
  billing: "monthly";
  payment_terms_days: number;
  payment_terms_source: string;
  annual_volume_units: number;
  products: ContractPriceLine[];
  notes: string[];
};

export type ContractSummary = {
  id: string;
  retailer: string;
  gln: string;
  start: string;
  end: string;
  billing: "monthly";
  paymentTermsDays: number;
  products: number;
  annualVolumeUnits: number;
  annualValueEur: number;
  status: "active" | "expired";
  href: string /* /api/contracts/<id>?download=1 */;
};

export const contractsDir = () => dataPath("world", "contracts");

function contractFiles(): { path: string; doc: SupplyContractDoc }[] {
  const dir = contractsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ path: join(dir, f), doc: JSON.parse(readFileSync(join(dir, f), "utf8")) as SupplyContractDoc }));
}

/** Every contract as stored. */
export function contractDocs(): SupplyContractDoc[] {
  return contractFiles().map((f) => f.doc);
}

/** One contract as stored, or null. */
export function contractDoc(id: string): SupplyContractDoc | null {
  return contractDocs().find((c) => c.id === id) ?? null;
}

/** The file a contract is stored in (the source to cite), or null. */
export function contractPath(id: string): string | null {
  return contractFiles().find((f) => f.doc.id === id)?.path ?? null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function summarize(c: SupplyContractDoc, today = todayIso()): ContractSummary {
  return {
    id: c.id,
    retailer: c.retailer.name,
    gln: c.retailer.gln,
    start: c.start,
    end: c.end,
    billing: c.billing,
    paymentTermsDays: c.payment_terms_days,
    products: c.products.length,
    annualVolumeUnits: c.annual_volume_units,
    // The committed volume of each product at its base price (before volume tiers): an upper bound.
    annualValueEur: round2(c.products.reduce((a, p) => a + p.annual_volume_units * p.unit_price, 0)),
    status: today >= c.start && today <= c.end ? "active" : "expired",
    href: `/api/contracts/${encodeURIComponent(c.id)}?download=1`,
  };
}

/** Every retailer's contract, summarized. */
export function contracts(): ContractSummary[] {
  return contractDocs().map((c) => summarize(c));
}

/** One contract, summarized, or null. */
export function contract(id: string): ContractSummary | null {
  const c = contractDoc(id);
  return c ? summarize(c) : null;
}

/** The retailer's contract in force (else its latest), or null when it has none. */
export function contractFor(gln: string | null | undefined): ContractSummary | null {
  if (!gln) return null;
  const mine = contractDocs()
    .filter((c) => c.retailer.gln === gln)
    .map((c) => summarize(c));
  return mine.find((c) => c.status === "active") ?? mine.sort((a, b) => b.end.localeCompare(a.end))[0] ?? null;
}

/**
 * The contract the order row checks prices against: the buyer's annual contract, or the default
 * contract (data/orders/contract_scotti_esselunga.json) when the buyer has none.
 */
export function supplyContractFor(gln: string | null | undefined): SupplyContract {
  const c = contractFor(gln);
  const path = c ? contractPath(c.id) : null;
  return path ? loadContract(path) : loadContract();
}
