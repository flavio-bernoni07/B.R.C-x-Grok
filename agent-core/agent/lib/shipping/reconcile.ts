/**
 * Reconciliation that names every cause, where threeway names one (port of shipping/reconcile.py).
 *
 * threeway (the track baseline) joins on order number + item code exactly and gives one reason
 * per line. Reading its code we found three blind spots:
 *
 * 1. a short delivery that was invoiced correctly comes out as "matched";
 * 2. a price error behind a quantity problem is never named;
 * 3. a typo in an order number turns into two false exceptions.
 *
 * This module keeps threeway's join, then:
 * - reads references and item codes without punctuation, and links a reference that is one
 *   character away from exactly one order (and shares its items);
 * - converts cartons and units with the product's case size;
 * - compares the order, the despatch advice and the invoice separately, and lists every cause
 *   on a line, each with its euro amount.
 *
 * `reconcileDocuments()` is pure (no database); `bench/score.ts` scores it against threeway.
 * Inputs and outputs are JSON documents, so they keep the Python key names (snake_case).
 */
import { pyFixed, pyG, pyRound } from "./format";

export const BILLING_CAUSES = new Set(["overbilled", "underbilled", "price_difference", "orphan_invoice", "uom_unknown"]);
export const FULFILMENT_CAUSES = new Set(["short_delivery", "over_delivery", "not_shipped", "orphan_receipt"]);
export const PRICE_EPS = 0.005;

/** A document line: order_ref, item_code, quantity, and unit_price / uom when known. */
export type DocLine = {
  order_ref: string;
  item_code: string;
  quantity?: number | null;
  unit_price?: number | null;
  uom?: string | null;
  [k: string]: unknown;
};

/** Product master data as in data/world/products.json. */
export type ProductInfo = {
  item_code: string;
  gtin?: string | null;
  uom?: string | null;
  units_per_case?: number | null;
  [k: string]: unknown;
};

export type Cause = { code: string; qty: number; eur: number; text: string };

export type LineResult = {
  order_ref: string;
  item_code: string;
  ordered: number;
  received: number;
  invoiced: number;
  po_price: number | null;
  invoice_price: number | null;
  /** matched | fulfilment_gap | exception */
  status: string;
  causes: Cause[];
};

export type ReportDict = { status: string; causes: string[]; notes: string[]; lines: LineResult[] };

export class Report {
  constructor(
    readonly lines: LineResult[],
    readonly notes: string[],
  ) {}

  get status(): string {
    const statuses = new Set(this.lines.map((l) => l.status));
    if (statuses.has("exception")) return "exception";
    if (statuses.has("fulfilment_gap")) return "fulfilment_gap";
    return "matched";
  }

  get causes(): Set<string> {
    return new Set(this.lines.flatMap((l) => l.causes.map((c) => c.code)));
  }

  toDict(): ReportDict {
    return {
      status: this.status,
      causes: [...this.causes].sort(),
      notes: [...this.notes],
      lines: this.lines.map((l) => ({ ...l, causes: l.causes.map((c) => ({ ...c })) })),
    };
  }
}

export function norm(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[prev.length - 1];
}

function productIndex(products: ProductInfo[] | null | undefined): Map<string, ProductInfo> {
  const index = new Map<string, ProductInfo>();
  for (const product of products ?? []) {
    for (const key of [product.item_code, product.gtin]) {
      if (key) index.set(norm(key), product);
    }
  }
  return index;
}

/** Convert a line to the product's own unit. Returns [qty, price, ok]. */
function toBase(qty: number, price: number | null | undefined, uom: string | null | undefined, product: ProductInfo | undefined): [number, number | null, boolean] {
  const p = price ?? null;
  if (!uom || !product || norm(uom) === norm(product.uom)) return [qty, p, true];
  const perCase = Number(product.units_per_case || 1);
  const base = norm(product.uom);
  const unit = norm(uom);
  if (base === "CTN" && ["EA", "PCE", "PZ", "NR"].includes(unit) && perCase > 1) {
    return [qty / perCase, p !== null ? p * perCase : null, true];
  }
  if (["EA", "PCE"].includes(base) && unit === "CTN" && perCase > 1) {
    return [qty * perCase, p !== null ? p / perCase : null, true];
  }
  return [qty, p, false];
}

type Bucket = {
  order_ref: string;
  item_code: string;
  ordered: number;
  received: number;
  invoiced: number;
  po_value: number;
  inv_value: number;
  in_po: boolean;
  uom_ok: boolean;
};

/**
 * Delivery tolerance follows the contract (§7: ±2% or 2 units, whichever is greater).
 * An invoice must match what was received exactly: there is no billing tolerance.
 */
export function reconcileDocuments(
  poLines: DocLine[],
  receivedLines: DocLine[],
  invoiceLines: DocLine[],
  opts: { products?: ProductInfo[] | null; deliveryTolerancePct?: number; deliveryToleranceUnits?: number } = {},
): Report {
  const deliveryTolerancePct = opts.deliveryTolerancePct ?? 2.0;
  const deliveryToleranceUnits = opts.deliveryToleranceUnits ?? 2.0;
  const index = productIndex(opts.products);
  const notes: string[] = [];
  const poRefs = new Map<string, string>();
  for (const l of poLines) poRefs.set(norm(l.order_ref), l.order_ref);
  const poItems = new Map<string, Set<string>>();

  const itemKey = (line: DocLine): [string, ProductInfo | undefined] => {
    const product = index.get(norm(line.item_code));
    return [product ? norm(product.item_code) : norm(line.item_code), product];
  };

  for (const line of poLines) {
    const ref = norm(line.order_ref);
    if (!poItems.has(ref)) poItems.set(ref, new Set());
    poItems.get(ref)!.add(itemKey(line)[0]);
  }

  const resolveRef = (raw: string, item: string): string => {
    const key = norm(raw);
    if (poRefs.has(key)) return key;
    const near = [...poRefs.keys()].filter((ref) => editDistance(key, ref) <= 1 && (poItems.get(ref) ?? new Set()).has(item));
    if (near.length === 1) {
      notes.push(`Reference ${raw} read as ${poRefs.get(near[0])} (one character apart, same item).`);
      return near[0];
    }
    if (near.length > 1) notes.push(`Reference ${raw} is one character from several orders; left unmatched for a person.`);
    return key;
  };

  const agg = new Map<string, { ref: string; item: string; b: Bucket }>();
  const bucket = (ref: string, item: string, displayRef: string, displayItem: string): Bucket => {
    const k = JSON.stringify([ref, item]);
    let entry = agg.get(k);
    if (!entry) {
      entry = {
        ref,
        item,
        b: { order_ref: displayRef, item_code: displayItem, ordered: 0, received: 0, invoiced: 0, po_value: 0, inv_value: 0, in_po: false, uom_ok: true },
      };
      agg.set(k, entry);
    }
    return entry.b;
  };

  for (const line of poLines) {
    const [item, product] = itemKey(line);
    const [q, price, ok] = toBase(Number(line.quantity || 0), line.unit_price, line.uom, product);
    const b = bucket(norm(line.order_ref), item, line.order_ref, product ? product.item_code : line.item_code);
    b.ordered += q;
    b.po_value += q * Number(price || 0);
    b.in_po = true;
    b.uom_ok = b.uom_ok && ok;
  }
  for (const [kind, lines] of [
    ["received", receivedLines],
    ["invoiced", invoiceLines],
  ] as const) {
    for (const line of lines) {
      const [item, product] = itemKey(line);
      const ref = resolveRef(line.order_ref, item);
      const [q, price, ok] = toBase(Number(line.quantity || 0), line.unit_price, line.uom, product);
      const b = bucket(ref, item, poRefs.get(ref) ?? line.order_ref, product ? product.item_code : line.item_code);
      b[kind] += q;
      if (kind === "invoiced") b.inv_value += q * Number(price || 0);
      b.uom_ok = b.uom_ok && ok;
    }
  }

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...agg.values()].sort((x, y) => cmp(x.ref, y.ref) || cmp(x.item, y.item));

  const results: LineResult[] = [];
  for (const { b } of sorted) {
    const { ordered, received, invoiced } = b;
    const poPrice = ordered ? b.po_value / ordered : null;
    const invPrice = invoiced ? b.inv_value / invoiced : null;
    const causes: Cause[] = [];
    if (!b.uom_ok) causes.push({ code: "uom_unknown", qty: 0, eur: 0, text: "units differ and the product has no case size to convert" });
    if (!b.in_po) {
      if (invoiced) {
        causes.push({ code: "orphan_invoice", qty: invoiced, eur: pyRound(b.inv_value, 2), text: `invoiced ${pyG(invoiced)} with no matching order line` });
      } else if (received) {
        causes.push({ code: "orphan_receipt", qty: received, eur: 0, text: `received ${pyG(received)} with no matching order line` });
      }
    } else {
      const tol = Math.max(deliveryToleranceUnits, (ordered * deliveryTolerancePct) / 100);
      const price = poPrice || 0;
      if (received === 0 && invoiced === 0) {
        causes.push({ code: "not_shipped", qty: ordered, eur: pyRound(ordered * price, 2), text: "nothing shipped or invoiced yet" });
      }
      if (invoiced > received) {
        const q = invoiced - received;
        causes.push({ code: "overbilled", qty: q, eur: pyRound(q * (invPrice || price), 2), text: `invoiced ${pyG(invoiced)} but only ${pyG(received)} were delivered` });
      } else if (invoiced < received && invoiced > 0) {
        const q = received - invoiced;
        causes.push({ code: "underbilled", qty: q, eur: pyRound(q * price, 2), text: `delivered ${pyG(received)} but invoiced ${pyG(invoiced)}` });
      }
      if (received > 0 && received < ordered - tol) {
        const q = ordered - received;
        causes.push({ code: "short_delivery", qty: q, eur: pyRound(q * price, 2), text: `delivered ${pyG(received)} of ${pyG(ordered)} ordered` });
      } else if (received > ordered + tol) {
        const q = received - ordered;
        causes.push({ code: "over_delivery", qty: q, eur: pyRound(q * price, 2), text: `delivered ${pyG(received)} against ${pyG(ordered)} ordered` });
      }
      if (poPrice !== null && invPrice !== null && Math.abs(invPrice - poPrice) > PRICE_EPS) {
        causes.push({
          code: "price_difference",
          qty: invoiced,
          eur: pyRound((invPrice - poPrice) * invoiced, 2),
          text: `invoice price €${pyFixed(invPrice, 2)} against order price €${pyFixed(poPrice, 2)}`,
        });
      }
    }
    const codes = new Set(causes.map((c) => c.code));
    let status: string;
    if (!codes.size) status = "matched";
    else if ([...codes].every((c) => c === "short_delivery")) status = "fulfilment_gap";
    else status = "exception";
    results.push({
      order_ref: b.order_ref,
      item_code: b.item_code,
      ordered,
      received,
      invoiced,
      po_price: poPrice !== null ? pyRound(poPrice, 4) : null,
      invoice_price: invPrice !== null ? pyRound(invPrice, 4) : null,
      status,
      causes,
    });
  }
  return new Report(results, notes);
}

/** Plain explanation written by code; Grok may rephrase it, never change a figure. */
export function explain(report: Report): string {
  if (report.status === "matched") return "Order, despatch advice and invoice agree on every line.";
  const parts: string[] = [];
  for (const line of report.lines) {
    for (const cause of line.causes) parts.push(`${line.order_ref} ${line.item_code}: ${cause.text} (€${pyFixed(cause.eur, 2)})`);
  }
  return parts.join("; ") + (parts.length ? "." : "");
}
