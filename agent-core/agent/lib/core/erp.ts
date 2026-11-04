/**
 * Mini ERP: one SQLite database shared by the Order, Shipping and Dispute rows (port of
 * core/erp.py). Every record keeps the document it came from (`sourceDoc`), and every action
 * is written to `audit` with who did it: code, grok, retailer or person:<name>.
 *
 * Quantities are in the product's own unit (EA packs, CTN cartons); money is REAL euros.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as s from "../db/schema";

export type Product = typeof s.products.$inferSelect;
export type Retailer = typeof s.retailers.$inferSelect;
export type DocumentRow = typeof s.documents.$inferSelect;
export type Batch = typeof s.batches.$inferSelect;
export type OrderLine = typeof s.orderLines.$inferSelect;
export type ShipmentLine = typeof s.shipmentLines.$inferSelect;
export type InvoiceLine = typeof s.invoiceLines.$inferSelect;
export type Proof = typeof s.proofs.$inferSelect;

export type Json = Record<string, unknown>;
export type AuditEntry = Omit<typeof s.audit.$inferSelect, "detail"> & { detail: unknown };
export type Order = Omit<typeof s.orders.$inferSelect, "notes"> & { notes: Json | null; lines: OrderLine[] };
export type Shipment = typeof s.shipments.$inferSelect & { lines: ShipmentLine[] };
export type Invoice = typeof s.invoices.$inferSelect & { lines: InvoiceLine[] };
export type Claim = Omit<typeof s.claims.$inferSelect, "extraction" | "verdict" | "outcome"> & {
  extraction: Json | null;
  verdict: Json | null;
  outcome: Json | null;
};
export type Signoff = Omit<typeof s.signoffs.$inferSelect, "proposal" | "reasons"> & {
  proposal: Json | null;
  reasons: string[] | null;
};

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

export const dumps = (value: unknown): string | null => (value == null ? null : JSON.stringify(value));
export function loads<T = unknown>(value: string | null | undefined): T | null {
  return value == null ? null : (JSON.parse(value) as T);
}

const ACTORS = new Set(["code", "grok", "person", "retailer"]);

export class Erp {
  readonly sqlite: Database.Database;
  readonly db: BetterSQLite3Database<typeof s>;

  constructor(readonly path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.exec(s.DDL);
    this.db = drizzle(this.sqlite, { schema: s });
  }

  close() {
    this.sqlite.close();
  }

  /** Run several writes atomically. */
  tx<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  nextId(name: string, prefix: string, width = 5): string {
    const cur = this.db.select().from(s.counters).where(eq(s.counters.name, name)).get();
    const value = (cur?.value ?? 0) + 1;
    this.db
      .insert(s.counters)
      .values({ name, value })
      .onConflictDoUpdate({ target: s.counters.name, set: { value } })
      .run();
    return `${prefix}${String(value).padStart(width, "0")}`;
  }

  log(actor: string, action: string, subjectRef: string | null = null, opts: { sourceDoc?: string | null; detail?: unknown } = {}) {
    if (!ACTORS.has(actor) && !actor.startsWith("person:")) throw new Error(`unknown actor ${actor}`);
    this.db
      .insert(s.audit)
      .values({ at: nowIso(), actor, action, subjectRef, sourceDoc: opts.sourceDoc ?? null, detail: dumps(opts.detail) })
      .run();
  }

  auditLog(subjectRef?: string | null): AuditEntry[] {
    const q = this.db.select().from(s.audit);
    const rows = (subjectRef ? q.where(eq(s.audit.subjectRef, subjectRef)) : q).orderBy(asc(s.audit.id)).all();
    return rows.map((r) => ({ ...r, detail: loads(r.detail) }));
  }

  // ----- documents -----------------------------------------------------------
  addDocument(kind: string, ref: string | null, body: string | null, opts: { path?: string | null } = {}): string {
    const docId = this.nextId("doc", "DOC-");
    this.db.insert(s.documents).values({ docId, kind, ref, body, path: opts.path ?? null, createdAt: nowIso() }).run();
    return docId;
  }

  document(docId: string): DocumentRow | undefined {
    return this.db.select().from(s.documents).where(eq(s.documents.docId, docId)).get();
  }

  documents(filter: { ref?: string; kind?: string } = {}): DocumentRow[] {
    const conds: SQL[] = [];
    if (filter.ref) conds.push(eq(s.documents.ref, filter.ref));
    if (filter.kind) conds.push(eq(s.documents.kind, filter.kind));
    return this.db.select().from(s.documents).where(and(...conds)).orderBy(asc(s.documents.docId)).all();
  }

  // ----- master data ---------------------------------------------------------
  upsertProduct(p: Partial<Product> & Pick<Product, "gtin" | "itemCode" | "name" | "uom" | "vatRate">) {
    const row = {
      gtin: p.gtin,
      itemCode: p.itemCode,
      name: p.name,
      uom: p.uom,
      unitsPerCase: p.unitsPerCase ?? 1,
      listPrice: p.listPrice ?? null,
      vatRate: Number(p.vatRate),
      unitsPerPallet: p.unitsPerPallet ?? null,
      unitWeightKg: p.unitWeightKg ?? null,
    };
    this.db.insert(s.products).values(row).onConflictDoUpdate({ target: s.products.gtin, set: row }).run();
  }

  product(by: { gtin?: string | null; itemCode?: string | null }): Product | undefined {
    if (by.gtin) return this.db.select().from(s.products).where(eq(s.products.gtin, by.gtin)).get();
    if (by.itemCode) return this.db.select().from(s.products).where(eq(s.products.itemCode, by.itemCode)).get();
    return undefined;
  }

  products(): Product[] {
    return this.db.select().from(s.products).orderBy(asc(s.products.itemCode)).all();
  }

  upsertRetailer(r: Partial<Retailer> & Pick<Retailer, "gln" | "name">) {
    const row = {
      gln: r.gln,
      name: r.name,
      vatId: r.vatId ?? null,
      address: r.address ?? null,
      cap: r.cap ?? null,
      comune: r.comune ?? null,
      provincia: r.provincia ?? null,
      sdiCode: r.sdiCode ?? null,
      deliveryPoint: r.deliveryPoint ?? null,
    };
    this.db.insert(s.retailers).values(row).onConflictDoUpdate({ target: s.retailers.gln, set: row }).run();
  }

  retailer(gln: string | null | undefined): Retailer | undefined {
    if (!gln) return undefined;
    return this.db.select().from(s.retailers).where(eq(s.retailers.gln, gln)).get();
  }

  retailers(): Retailer[] {
    return this.db.select().from(s.retailers).orderBy(asc(s.retailers.name)).all();
  }

  // ----- orders --------------------------------------------------------------
  saveOrder(o: {
    orderRef: string;
    buyerGln: string | null;
    supplierGln: string | null;
    orderDate: string | null;
    lines: { lineNo?: number; gtin?: string | null; quantity?: number | null; qtyConfirmed?: number | null; unitPrice?: number | null }[];
    status: string;
    sourceDoc: string | null;
    contractId?: string | null;
    deliveryDate?: string | null;
    notes?: unknown;
  }) {
    this.tx(() => {
      this.db.delete(s.orderLines).where(eq(s.orderLines.orderRef, o.orderRef)).run();
      const row = {
        orderRef: o.orderRef,
        buyerGln: o.buyerGln,
        supplierGln: o.supplierGln,
        orderDate: o.orderDate,
        deliveryDate: o.deliveryDate ?? null,
        status: o.status,
        contractId: o.contractId ?? null,
        ordrspRef: null,
        sourceDoc: o.sourceDoc,
        notes: dumps(o.notes),
      };
      this.db.insert(s.orders).values(row).onConflictDoUpdate({ target: s.orders.orderRef, set: row }).run();
      o.lines.forEach((line, i) => {
        this.db
          .insert(s.orderLines)
          .values({
            orderRef: o.orderRef,
            lineNo: line.lineNo ?? i + 1,
            gtin: line.gtin ?? null,
            qtyOrdered: line.quantity ?? null,
            qtyConfirmed: line.qtyConfirmed ?? null,
            unitPrice: line.unitPrice ?? null,
          })
          .run();
      });
    });
  }

  order(orderRef: string): Order | undefined {
    const row = this.db.select().from(s.orders).where(eq(s.orders.orderRef, orderRef)).get();
    if (!row) return undefined;
    const lines = this.db
      .select()
      .from(s.orderLines)
      .where(eq(s.orderLines.orderRef, orderRef))
      .orderBy(asc(s.orderLines.lineNo))
      .all();
    return { ...row, notes: loads<Json>(row.notes), lines };
  }

  orders(status?: string): Order[] {
    const q = this.db.select({ ref: s.orders.orderRef }).from(s.orders);
    const refs = (status ? q.where(eq(s.orders.status, status)) : q).orderBy(asc(s.orders.orderRef)).all();
    return refs.map((r) => this.order(r.ref)!);
  }

  setOrder(orderRef: string, fields: Partial<Omit<Order, "orderRef" | "lines">>) {
    if (!Object.keys(fields).length) return;
    const { notes, ...rest } = fields;
    const set: Record<string, unknown> = { ...rest };
    if ("notes" in fields) set.notes = dumps(notes);
    this.db.update(s.orders).set(set).where(eq(s.orders.orderRef, orderRef)).run();
  }

  confirmLine(orderRef: string, lineNo: number, qtyConfirmed: number) {
    this.db
      .update(s.orderLines)
      .set({ qtyConfirmed })
      .where(and(eq(s.orderLines.orderRef, orderRef), eq(s.orderLines.lineNo, lineNo)))
      .run();
  }

  // ----- shipments and invoices ---------------------------------------------
  saveShipment(sh: {
    desadvRef: string;
    orderRef: string;
    shipDate: string;
    ddtRef: string;
    lines: { gtin: string; batch?: string | null; qty: number }[];
    sourceDoc: string | null;
    notes: string | null;
  }) {
    this.tx(() => {
      const { lines, ...head } = sh;
      this.db.insert(s.shipments).values(head).run();
      for (const l of lines) {
        this.db.insert(s.shipmentLines).values({ desadvRef: sh.desadvRef, gtin: l.gtin, batch: l.batch ?? null, qty: l.qty }).run();
      }
    });
  }

  private shipmentLinesOf(desadvRef: string) {
    return this.db.select().from(s.shipmentLines).where(eq(s.shipmentLines.desadvRef, desadvRef)).all();
  }

  shipments(orderRef?: string): Shipment[] {
    const q = this.db.select().from(s.shipments);
    const rows = (orderRef ? q.where(eq(s.shipments.orderRef, orderRef)) : q).orderBy(asc(s.shipments.desadvRef)).all();
    return rows.map((r) => ({ ...r, lines: this.shipmentLinesOf(r.desadvRef) }));
  }

  shipment(desadvRef: string): Shipment | undefined {
    const row = this.db.select().from(s.shipments).where(eq(s.shipments.desadvRef, desadvRef)).get();
    return row ? { ...row, lines: this.shipmentLinesOf(desadvRef) } : undefined;
  }

  saveInvoice(inv: {
    invoiceRef: string;
    orderRef: string;
    desadvRef: string;
    invoiceDate: string;
    lines: { gtin: string; qty: number; unitPrice: number; vatRate: number }[];
    totalNet: number;
    totalVat: number;
    total: number;
    status: string;
    sourceDoc: string | null;
    notes?: string | null;
  }) {
    this.tx(() => {
      const { lines, ...head } = inv;
      this.db.insert(s.invoices).values({ ...head, notes: head.notes ?? null }).run();
      for (const l of lines) this.db.insert(s.invoiceLines).values({ invoiceRef: inv.invoiceRef, ...l }).run();
    });
  }

  invoices(orderRef?: string): Invoice[] {
    const q = this.db.select().from(s.invoices);
    const rows = (orderRef ? q.where(eq(s.invoices.orderRef, orderRef)) : q).orderBy(asc(s.invoices.invoiceRef)).all();
    return rows.map((r) => ({
      ...r,
      lines: this.db.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceRef, r.invoiceRef)).all(),
    }));
  }

  invoice(invoiceRef: string): Invoice | undefined {
    return this.invoices().find((i) => i.invoiceRef === invoiceRef);
  }

  setInvoiceStatus(invoiceRef: string, status: string) {
    this.db.update(s.invoices).set({ status }).where(eq(s.invoices.invoiceRef, invoiceRef)).run();
  }

  addProof(p: Proof) {
    this.db.insert(s.proofs).values(p).onConflictDoUpdate({ target: s.proofs.docId, set: p }).run();
  }

  proofs(orderRef: string): Proof[] {
    return this.db.select().from(s.proofs).where(eq(s.proofs.orderRef, orderRef)).orderBy(asc(s.proofs.docId)).all();
  }

  // ----- claims --------------------------------------------------------------
  saveClaim(c: { claimId: string; sourceDoc: string; status: string }) {
    this.db.insert(s.claims).values({ ...c, receivedAt: nowIso() }).run();
  }

  setClaim(claimId: string, fields: Partial<Omit<Claim, "claimId">>) {
    const set: Record<string, unknown> = { ...fields };
    for (const k of ["extraction", "verdict", "outcome"] as const) if (k in fields) set[k] = dumps(fields[k]);
    this.db.update(s.claims).set(set).where(eq(s.claims.claimId, claimId)).run();
  }

  claim(claimId: string): Claim | undefined {
    const r = this.db.select().from(s.claims).where(eq(s.claims.claimId, claimId)).get();
    if (!r) return undefined;
    return { ...r, extraction: loads<Json>(r.extraction), verdict: loads<Json>(r.verdict), outcome: loads<Json>(r.outcome) };
  }

  claims(): Claim[] {
    return this.db
      .select({ id: s.claims.claimId })
      .from(s.claims)
      .orderBy(asc(s.claims.claimId))
      .all()
      .map((r) => this.claim(r.id)!);
  }

  // ----- sign-off queue (see core/signoff.ts) ---------------------------------
  insertSignoff(row: { caseId: string; row: string; kind: string; subjectRef?: string | null; title?: string | null; proposal?: unknown; reasons?: string[]; status: string }) {
    this.db
      .insert(s.signoffs)
      .values({
        caseId: row.caseId,
        row: row.row,
        kind: row.kind,
        subjectRef: row.subjectRef ?? null,
        title: row.title ?? null,
        proposal: dumps(row.proposal),
        reasons: dumps(row.reasons),
        status: row.status,
        createdAt: nowIso(),
      })
      .run();
  }

  updateSignoff(caseId: string, fields: Partial<Omit<Signoff, "caseId">>) {
    const set: Record<string, unknown> = { ...fields };
    for (const k of ["proposal", "reasons"] as const) if (k in fields) set[k] = dumps(fields[k]);
    this.db.update(s.signoffs).set(set).where(eq(s.signoffs.caseId, caseId)).run();
  }

  signoff(caseId: string): Signoff | undefined {
    const r = this.db.select().from(s.signoffs).where(eq(s.signoffs.caseId, caseId)).get();
    if (!r) return undefined;
    return { ...r, proposal: loads<Json>(r.proposal), reasons: loads<string[]>(r.reasons) };
  }

  signoffs(filter: { status?: string; row?: string } = {}): Signoff[] {
    const conds: SQL[] = [];
    if (filter.status) conds.push(eq(s.signoffs.status, filter.status));
    if (filter.row) conds.push(eq(s.signoffs.row, filter.row));
    return this.db
      .select({ id: s.signoffs.caseId })
      .from(s.signoffs)
      .where(and(...conds))
      .orderBy(asc(s.signoffs.caseId))
      .all()
      .map((r) => this.signoff(r.id)!);
  }
}
