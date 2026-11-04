/**
 * Dispute document lookup (port of dispute/mini_erp.py).
 *
 * Holds catalog-shaped documents (orders, DESADV, invoices, proofs) from Shipping's
 * `exportForDispute` and/or the fixture `data/disputes/erp/catalog.json`, and resolves them by
 * order_ref or invoice_ref, including loose aliases (spacing, punctuation).
 */
import { readFileSync } from "node:fs";
import { dataPath } from "../paths";

export const defaultCatalogPath = () => dataPath("disputes", "erp", "catalog.json");

/** A catalog line (JSON document: Python key names). */
export type CatalogLine = {
  item_code?: string;
  product?: string;
  quantity?: number;
  unit_price?: number | null;
  uom?: string | null;
  [k: string]: unknown;
};

/** An order, DESADV, invoice or proof from the catalog. */
export type CatalogDoc = {
  doc_id?: string;
  order_ref?: string;
  desadv_ref?: string;
  invoice_ref?: string;
  invoice_date?: string;
  aliases?: string[];
  customer?: string;
  total?: number;
  lines?: CatalogLine[];
  kind?: string;
  ref?: string;
  summary?: string;
  [k: string]: unknown;
};

export type Catalog = {
  orders?: CatalogDoc[];
  desadv?: CatalogDoc[];
  invoices?: CatalogDoc[];
  proofs?: CatalogDoc[];
};

export type LookupMiss = { kind: string; queried: string | null; detail: string };

/** Collapse a document reference for fuzzy equality (case, spaces, punctuation). */
export function normalizeRef(value: string | null | undefined): string {
  if (!value) return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const miss = (kind: string, queried: string | null, detail: string): LookupMiss => ({ kind, queried, detail });

export class MiniErpStore {
  constructor(
    public orders: CatalogDoc[] = [],
    public desadv: CatalogDoc[] = [],
    public invoices: CatalogDoc[] = [],
    public proofs: CatalogDoc[] = [],
    public sourcePath: string | null = null,
  ) {}

  static load(path?: string | null): MiniErpStore {
    const catalogPath = path || defaultCatalogPath();
    const data = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
    return MiniErpStore.fromDict(data, { label: catalogPath });
  }

  /** Build from a catalog-shaped object, e.g. shipping's exportForDispute(). */
  static fromDict(data: Catalog, opts: { label?: string | null } = {}): MiniErpStore {
    return new MiniErpStore(
      [...(data.orders ?? [])],
      [...(data.desadv ?? [])],
      [...(data.invoices ?? [])],
      [...(data.proofs ?? [])],
      opts.label ?? null,
    );
  }

  /** This store's documents first, then the other's (fixtures behind live records). */
  mergedWith(other: MiniErpStore): MiniErpStore {
    return new MiniErpStore(
      [...this.orders, ...other.orders],
      [...this.desadv, ...other.desadv],
      [...this.invoices, ...other.invoices],
      [...this.proofs, ...other.proofs],
      this.sourcePath || other.sourcePath,
    );
  }

  findOrder(orderRef: string | null | undefined): [CatalogDoc | null, LookupMiss | null] {
    if (!orderRef) return [null, miss("order", null, "No order_ref on claim")];
    const hit = this.matchDoc(this.orders, orderRef, "order_ref");
    if (hit) return [hit, null];
    return [null, miss("order", orderRef, "No order matched order_ref or aliases")];
  }

  findInvoice(invoiceRef: string | null | undefined, orderRef: string | null = null): [CatalogDoc | null, LookupMiss | null] {
    if (invoiceRef) {
      const hit = this.matchDoc(this.invoices, invoiceRef, "invoice_ref");
      if (hit) return [hit, null];
      // Remittance stubs often only carry a trailing fragment (e.g. "334").
      const frag = normalizeRef(invoiceRef);
      if (frag) {
        for (const inv of this.invoices) {
          const candidates = [inv.invoice_ref ?? "", ...(inv.aliases ?? [])];
          if (candidates.some((c) => frag && normalizeRef(c).includes(frag))) return [inv, null];
        }
      }
      const m = miss("invoice", invoiceRef, "No invoice matched invoice_ref or aliases");
      if (orderRef) {
        const byOrder = this.findInvoiceForOrder(orderRef);
        if (byOrder) return [byOrder, null];
      }
      return [null, m];
    }
    if (orderRef) {
      const byOrder = this.findInvoiceForOrder(orderRef);
      if (byOrder) return [byOrder, null];
      return [null, miss("invoice", null, `No invoice_ref on claim and no invoice linked to order ${orderRef}`)];
    }
    return [null, miss("invoice", null, "No invoice_ref or order_ref to look up")];
  }

  findInvoiceForOrder(orderRef: string): CatalogDoc | null {
    const [orderDoc] = this.findOrder(orderRef);
    const canonical = orderDoc ? normalizeRef(String(orderDoc.order_ref ?? "")) : normalizeRef(orderRef);
    if (!canonical) return null;
    return this.invoices.find((inv) => normalizeRef(String(inv.order_ref ?? "")) === canonical) ?? null;
  }

  findDesadv(orderRef: string | null | undefined): [CatalogDoc | null, LookupMiss | null] {
    if (!orderRef) return [null, miss("desadv", null, "No order_ref to resolve DESADV")];
    const [order, m] = this.findOrder(orderRef);
    if (m || !order) return [null, miss("desadv", orderRef, "Cannot resolve DESADV without a matched order")];
    const canonical = String(order.order_ref ?? "");
    for (const doc of this.desadv) {
      if (normalizeRef(String(doc.order_ref ?? "")) === normalizeRef(canonical)) return [doc, null];
    }
    return [null, miss("desadv", canonical, "No DESADV linked to order")];
  }

  findProofs(orderRef: string | null | undefined): CatalogDoc[] {
    if (!orderRef) return [];
    const [order, m] = this.findOrder(orderRef);
    // Still try the raw ref when no order matched, in case proofs use the same messy string.
    const target = m || !order ? normalizeRef(orderRef) : normalizeRef(String(order.order_ref ?? ""));
    return this.proofs.filter((p) => normalizeRef(String(p.order_ref ?? "")) === target);
  }

  private matchDoc(docs: CatalogDoc[], query: string, refKey: "order_ref" | "invoice_ref"): CatalogDoc | null {
    const target = normalizeRef(query);
    if (!target) return null;
    for (const doc of docs) {
      const candidates = [String(doc[refKey] ?? ""), ...(doc.aliases ?? []).map(String)];
      for (const candidate of candidates) {
        const norm = normalizeRef(candidate);
        if (!norm) continue;
        if (norm === target || norm.includes(target) || target.includes(norm)) return doc;
      }
    }
    return null;
  }
}
