/**
 * The general state of the back office, read from the Mini ERP. The Overview's widgets and the
 * agent's `overview_snapshot`, `stock_status` and `audit_trail` tools all call these.
 */
import { buildDigest, type Digest } from "./digest";
import type { AuditEntry, Erp, Signoff } from "./erp";
import { allBatches, availableToPromise, type Atp, productionEvents } from "./stock";

export type OverviewSnapshot = {
  asOf: string;
  counts: {
    orders: number;
    ordersByStatus: Record<string, number>;
    shipments: number;
    invoicesSent: number;
    invoicesHeld: number;
    invoicedNet: number;
    claims: number;
    claimsByStatus: Record<string, number>;
    creditNotes: number;
    signoffsWaiting: number;
    signoffsDecided: number;
    auditEvents: number;
  };
  waiting: Pick<Signoff, "caseId" | "row" | "kind" | "subjectRef" | "title" | "reasons" | "createdAt">[];
  recent: AuditEntry[];
  stockAlerts: { gtin: string; name: string; held: number; atp: number }[];
  digest: Digest;
};

export function overviewSnapshot(erp: Erp, opts: { recent?: number } = {}): OverviewSnapshot {
  const orders = erp.orders();
  const invoices = erp.invoices();
  const claims = erp.claims();
  const signoffs = erp.signoffs();
  const audit = erp.auditLog();
  const tally = <T>(xs: T[], key: (x: T) => string) =>
    xs.reduce<Record<string, number>>((a, x) => ((a[key(x)] = (a[key(x)] ?? 0) + 1), a), {});
  const sent = invoices.filter((i) => i.status === "sent");
  const stock = stockStatus(erp);
  return {
    asOf: new Date().toISOString(),
    counts: {
      orders: orders.length,
      ordersByStatus: tally(orders, (o) => o.status),
      shipments: erp.shipments().length,
      invoicesSent: sent.length,
      invoicesHeld: invoices.length - sent.length,
      invoicedNet: sent.reduce((a, i) => a + (i.totalNet ?? 0), 0),
      claims: claims.length,
      claimsByStatus: tally(claims, (c) => c.status),
      creditNotes: erp.documents({ kind: "FatturaPA TD04" }).length,
      signoffsWaiting: signoffs.filter((s) => s.status === "pending").length,
      signoffsDecided: signoffs.filter((s) => s.status !== "pending").length,
      auditEvents: audit.length,
    },
    waiting: signoffs
      .filter((s) => s.status === "pending")
      .map(({ caseId, row, kind, subjectRef, title, reasons, createdAt }) => ({ caseId, row, kind, subjectRef, title, reasons, createdAt })),
    recent: audit.slice(-(opts.recent ?? 12)).reverse(),
    stockAlerts: stock.products.filter((p) => p.held > 0).map((p) => ({ gtin: p.gtin, name: p.name, held: p.held, atp: p.atp })),
    digest: buildDigest(erp, "Weekly digest"),
  };
}

export type StockStatus = {
  products: (Atp & { name: string; itemCode: string; uom: string })[];
  batches: ReturnType<typeof allBatches>;
  events: ReturnType<typeof productionEvents>;
};

/** Available to promise per product, every batch with its status, and the production events behind them. */
export function stockStatus(erp: Erp, opts: { byDate?: string | null; gtin?: string } = {}): StockStatus {
  const products = erp
    .products()
    .filter((p) => !opts.gtin || p.gtin === opts.gtin)
    .map((p) => ({ ...availableToPromise(erp, p.gtin, opts.byDate), name: p.name, itemCode: p.itemCode, uom: p.uom }))
    .filter((p) => p.released + p.planned + p.held + p.committed > 0 || opts.gtin);
  const batches = allBatches(erp).filter((b) => !opts.gtin || b.gtin === opts.gtin);
  const events = productionEvents(erp).filter((e) => !opts.gtin || e.gtin === opts.gtin);
  return { products, batches, events };
}

/** Every action on one reference (order, invoice, claim, batch...), oldest first. */
export function auditTrail(erp: Erp, ref?: string | null, limit = 60): AuditEntry[] {
  const rows = erp.auditLog(ref ?? undefined);
  return ref ? rows : rows.slice(-limit);
}
