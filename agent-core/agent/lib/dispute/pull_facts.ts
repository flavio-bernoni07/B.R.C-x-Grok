/**
 * Pull the facts: resolve the Mini ERP documents for a claim and run three-way matching
 * (port of dispute/pull_facts.py).
 *
 * Three-way matcher: agent/lib/threeway/core.ts (port of the vendored Bhavya-Dhoot/threeway,
 * MIT). Join key is order_ref + item_code; tiny qty/€ diffs are tolerated; one reason per
 * flagged line. DESADV lines are treated as goods received (GRN). No Grok here.
 */
import { readFileSync } from "node:fs";
import { type RawLine, reconcile } from "../threeway/core";
import { type ClaimExtraction, ClaimType, parseExtraction } from "./claim_reader";
import { type CatalogDoc, type LookupMiss, MiniErpStore } from "./mini_erp";

export type ThreeWayLineView = {
  po_number: string;
  item_code: string;
  ordered: number;
  received: number;
  invoiced: number;
  po_price: number;
  invoice_price: number;
  qty_variance: number;
  value_variance: number;
  status: string;
  reason: string;
};

export type ThreeWayView = {
  source: string;
  summary: Record<string, number>;
  warnings: string[];
  lines: ThreeWayLineView[];
};

export const THREEWAY_SOURCE = "vendored Bhavya-Dhoot/threeway (dispute/_threeway_core.py)";

/** Linked documents + three-way result + proof refs + lookup misses (JSON: Python key names). */
export type DisputeFacts = {
  claim: ClaimExtraction & Record<string, unknown>;
  order: CatalogDoc | null;
  desadv: CatalogDoc | null;
  invoice: CatalogDoc | null;
  proofs: CatalogDoc[];
  threeway: ThreeWayView | null;
  misses: LookupMiss[];
  catalog_path: string | null;
};

export const claimFromMapping = (data: Record<string, unknown>): ClaimExtraction => parseExtraction(data);

export function loadClaimJson(path: string): ClaimExtraction {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Claim JSON must be an object: ${path}`);
  return claimFromMapping(payload);
}

function docLinesToRaw(doc: CatalogDoc | null, orderRef: string, includePrice: boolean): RawLine[] {
  if (!doc) return [];
  const rows: RawLine[] = [];
  for (const line of doc.lines ?? []) {
    const item = String(line.item_code ?? "").trim();
    if (!item) continue;
    rows.push({
      poNumber: orderRef,
      itemCode: item,
      quantity: String(line.quantity ?? 0),
      price: includePrice && line.unit_price != null ? String(line.unit_price) : null,
      uom: line.uom ?? null,
    });
  }
  return rows;
}

export function runThreeway(order: CatalogDoc | null, desadv: CatalogDoc | null, invoice: CatalogDoc | null): ThreeWayView | null {
  if (!order) return null;
  const orderRef = String(order.order_ref ?? "");
  const poRows = docLinesToRaw(order, orderRef, true);
  const grnRows = docLinesToRaw(desadv, orderRef, false);
  const invRows = docLinesToRaw(invoice, orderRef, true);
  if (!poRows.length && !grnRows.length && !invRows.length) return null;

  const result = reconcile(poRows, grnRows, invRows);
  const lines: ThreeWayLineView[] = result.lines.map((l) => ({
    po_number: l.poNumber,
    item_code: l.itemCode,
    ordered: Number(l.ordered),
    received: Number(l.received),
    invoiced: Number(l.invoiced),
    po_price: Number(l.poPrice),
    invoice_price: Number(l.invoicePrice),
    qty_variance: Number(l.qtyVariance),
    value_variance: Number(l.valueVariance),
    status: l.status,
    reason: l.reason,
  }));
  const summary: Record<string, number> = {};
  for (const line of lines) summary[line.status] = (summary[line.status] ?? 0) + 1;
  return { source: THREEWAY_SOURCE, summary, warnings: [...result.warnings], lines };
}

/** Look up linked docs for a structured claim and run three-way matching. */
export function pullFacts(
  claim: ClaimExtraction | Record<string, unknown>,
  opts: { store?: MiniErpStore | null; catalogPath?: string | null } = {},
): DisputeFacts {
  const extraction = parseExtraction(claim as Record<string, unknown>);
  const erp = opts.store ?? MiniErpStore.load(opts.catalogPath);
  const misses: LookupMiss[] = [];

  const [order, orderMiss] = erp.findOrder(extraction.order_ref);
  if (orderMiss) misses.push(orderMiss);

  // Prefer the canonical order_ref from the matched order for downstream joins.
  const resolvedOrderRef = order ? String(order.order_ref) : extraction.order_ref;

  const [desadv, desadvMiss] = erp.findDesadv(resolvedOrderRef || extraction.order_ref);
  if (desadvMiss) misses.push(desadvMiss);

  const [invoice, invoiceMiss] = erp.findInvoice(extraction.invoice_ref, resolvedOrderRef || extraction.order_ref);
  if (invoiceMiss) misses.push(invoiceMiss);

  const proofs = erp.findProofs(resolvedOrderRef || extraction.order_ref);
  const threeway = runThreeway(order, desadv, invoice);

  const claimDict: DisputeFacts["claim"] = { ...extraction };
  // Safety net: portal "other" + threeway invoice/PO price gap → pricing for the Playbook.
  if (extraction.claim_type === ClaimType.OTHER && threeway) {
    const priceGap = threeway.lines.some((l) => (l.reason || "").toLowerCase().includes("price differs"));
    if (priceGap) {
      claimDict.claim_type = ClaimType.PRICING;
      const note = (claimDict.raw_notes || "").trim();
      const suffix = "mapped to pricing via threeway price gap";
      claimDict.raw_notes = note ? `${note}; ${suffix}` : suffix;
    }
  }

  return {
    claim: claimDict,
    order,
    desadv,
    invoice,
    proofs,
    threeway,
    misses,
    catalog_path: erp.sourcePath,
  };
}
