/** Fictional Scotti <-> retailer supply contract: list prices + volume discounts (port of order/contract.py). */
import { readFileSync } from "node:fs";
import { dataPath } from "../paths";
import { pyFloat } from "./py";

export const defaultContractPath = () => dataPath("orders", "contract_scotti_esselunga.json");

export const PRICE_EPS = 0.005; // euro tolerance

export type VolumeDiscount = { min_qty: number; unit_price: number };
export type ContractProduct = { gtin: string; name: string; unit_price: number; volume_discounts: VolumeDiscount[] };

export class SupplyContract {
  constructor(
    readonly id: string,
    readonly buyer_gln: string,
    readonly supplier_gln: string,
    readonly buyer_name: string,
    readonly supplier_name: string,
    readonly currency: string,
    readonly products: Record<string, ContractProduct>,
  ) {}

  product(gtin: string): ContractProduct | null {
    return this.products[gtin] ?? null;
  }

  expectedUnitPrice(gtin: string, qty: number): number | null {
    const prod = this.product(gtin);
    if (!prod) return null;
    let price = prod.unit_price;
    for (const disc of [...prod.volume_discounts].sort((a, b) => a.min_qty - b.min_qty)) {
      if (qty >= disc.min_qty) price = disc.unit_price;
    }
    return price;
  }
}

export type PriceCheckLine = {
  gtin: string | null;
  ordered_qty: number | null;
  order_price: number | null;
  expected_price: number | null;
  ok: boolean;
  reason: string;
};

export type PriceCheckDict = { ok: boolean; contract_id: string; lines: PriceCheckLine[] };

export class PriceCheckResult {
  constructor(
    readonly ok: boolean,
    readonly lines: PriceCheckLine[],
    readonly contract_id: string,
  ) {}

  toDict(): PriceCheckDict {
    return { ok: this.ok, contract_id: this.contract_id, lines: this.lines.map((l) => ({ ...l })) };
  }
}

type RawContract = {
  id: string;
  buyer_gln: string;
  supplier_gln: string;
  buyer_name?: string;
  supplier_name?: string;
  currency?: string;
  products?: { gtin: string; name?: string; unit_price: number | string; volume_discounts?: { min_qty: number | string; unit_price: number | string }[] }[];
};

export function loadContract(path?: string | null): SupplyContract {
  const data = JSON.parse(readFileSync(path || defaultContractPath(), "utf8")) as RawContract;
  const products: Record<string, ContractProduct> = {};
  for (const row of data.products ?? []) {
    products[row.gtin] = {
      gtin: row.gtin,
      name: row.name || row.gtin,
      unit_price: Number(row.unit_price),
      volume_discounts: (row.volume_discounts ?? []).map((d) => ({ min_qty: Number(d.min_qty), unit_price: Number(d.unit_price) })),
    };
  }
  return new SupplyContract(
    data.id,
    data.buyer_gln,
    data.supplier_gln,
    data.buyer_name || "",
    data.supplier_name || "",
    data.currency || "EUR",
    products,
  );
}

export type PriceInputLine = { gtin?: string | null; quantity?: number | null; unit_price?: number | null };

/** If a line has no PRI, it is skipped (not a mismatch). */
export function checkPrices(opts: { lines: PriceInputLine[]; contract?: SupplyContract | null }): PriceCheckResult {
  const active = opts.contract ?? loadContract();
  const results: PriceCheckLine[] = [];
  let allOk = true;

  for (const line of opts.lines) {
    const gtin = line.gtin ?? null;
    const qty = line.quantity ?? null;
    const orderPrice = line.unit_price ?? null;

    if (orderPrice == null) {
      results.push({ gtin, ordered_qty: qty, order_price: null, expected_price: null, ok: true, reason: "no_PRI_on_order" });
      continue;
    }
    if (!gtin || qty == null) {
      allOk = false;
      results.push({
        gtin,
        ordered_qty: qty,
        order_price: orderPrice,
        expected_price: null,
        ok: false,
        reason: "missing_gtin_or_qty_for_price_check",
      });
      continue;
    }
    const expected = active.expectedUnitPrice(String(gtin), qty);
    if (expected == null) {
      allOk = false;
      results.push({ gtin, ordered_qty: qty, order_price: orderPrice, expected_price: null, ok: false, reason: "gtin_not_on_contract" });
      continue;
    }
    const match = Math.abs(orderPrice - expected) <= PRICE_EPS;
    if (!match) allOk = false;
    results.push({
      gtin,
      ordered_qty: qty,
      order_price: orderPrice,
      expected_price: expected,
      ok: match,
      reason: match ? "match" : "price_mismatch_vs_contract",
    });
  }
  return new PriceCheckResult(allOk, results, active.id);
}

/** Human will review/send: never auto-sent. */
export function draftPriceMismatchMail(opts: {
  orderNumber: string | null;
  buyerName: string;
  supplierName: string;
  contract: SupplyContract;
  priceCheck: PriceCheckResult;
}): string {
  const { buyerName, supplierName, contract, priceCheck } = opts;
  const num = opts.orderNumber || "(unknown)";
  const linesTxt = priceCheck.lines
    .filter((l) => !l.ok)
    .map(
      (l) =>
        `- GTIN ${l.gtin ?? "None"}: ordered €${pyFloat(l.order_price)}, ` +
        `contract €${pyFloat(l.expected_price)} (qty ${pyFloat(l.ordered_qty)}) — ${l.reason}`,
    )
    .join("\n");
  return (
    `Subject: Price discrepancy on order ${num} — ${contract.id}\n\n` +
    `Dear ${buyerName},\n\n` +
    `We received your ORDERS message for order ${num}. ` +
    `The unit price on the order does not match the supply contract ${contract.id} ` +
    `between ${buyerName} and ${supplierName}.\n\n` +
    `Details:\n${linesTxt}\n\n` +
    `Please confirm the contractual price or send a corrected ORDERS.\n\n` +
    `Kind regards,\n${supplierName}\n` +
    `(Draft — review and send manually)\n`
  );
}
