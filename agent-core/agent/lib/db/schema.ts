/**
 * The Mini ERP schema in Drizzle. Table and column names are identical to the Python
 * original (`core/erp.py`, `shipping/warehouse.py`, `shipping/cases.py`), so one SQLite file
 * reads the same from TypeScript and Python. JSON columns are TEXT holding JSON.
 */
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  gtin: text("gtin").primaryKey(),
  itemCode: text("item_code").notNull().unique(),
  name: text("name").notNull(),
  uom: text("uom").notNull(),
  unitsPerCase: integer("units_per_case").notNull().default(1),
  listPrice: real("list_price"),
  vatRate: real("vat_rate").notNull(),
  unitsPerPallet: integer("units_per_pallet"),
  unitWeightKg: real("unit_weight_kg"),
});

export const retailers = sqliteTable("retailers", {
  gln: text("gln").primaryKey(),
  name: text("name").notNull(),
  vatId: text("vat_id"),
  address: text("address"),
  cap: text("cap"),
  comune: text("comune"),
  provincia: text("provincia"),
  sdiCode: text("sdi_code"),
  deliveryPoint: text("delivery_point"),
});

export const documents = sqliteTable("documents", {
  docId: text("doc_id").primaryKey(),
  kind: text("kind").notNull(),
  ref: text("ref"),
  body: text("body"),
  path: text("path"),
  createdAt: text("created_at").notNull(),
});

export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subjectRef: text("subject_ref"),
  sourceDoc: text("source_doc"),
  detail: text("detail"),
});

export const batches = sqliteTable("batches", {
  batch: text("batch").primaryKey(),
  gtin: text("gtin").notNull(),
  qty: real("qty").notNull(),
  status: text("status").notNull(),
  availableFrom: text("available_from"),
  sourceDoc: text("source_doc"),
});

export const productionEvents = sqliteTable("production_events", {
  eventId: text("event_id").primaryKey(),
  kind: text("kind").notNull(),
  batch: text("batch"),
  gtin: text("gtin"),
  qty: real("qty"),
  at: text("at").notNull(),
  note: text("note"),
});

export const orders = sqliteTable("orders", {
  orderRef: text("order_ref").primaryKey(),
  buyerGln: text("buyer_gln"),
  supplierGln: text("supplier_gln"),
  orderDate: text("order_date"),
  deliveryDate: text("delivery_date"),
  status: text("status").notNull(),
  contractId: text("contract_id"),
  ordrspRef: text("ordrsp_ref"),
  sourceDoc: text("source_doc"),
  notes: text("notes"),
});

export const orderLines = sqliteTable(
  "order_lines",
  {
    orderRef: text("order_ref").notNull(),
    lineNo: integer("line_no").notNull(),
    gtin: text("gtin"),
    qtyOrdered: real("qty_ordered"),
    qtyConfirmed: real("qty_confirmed"),
    unitPrice: real("unit_price"),
  },
  (t) => [primaryKey({ columns: [t.orderRef, t.lineNo] })],
);

export const shipments = sqliteTable("shipments", {
  desadvRef: text("desadv_ref").primaryKey(),
  orderRef: text("order_ref").notNull(),
  shipDate: text("ship_date"),
  ddtRef: text("ddt_ref"),
  sourceDoc: text("source_doc"),
  notes: text("notes"),
});

export const shipmentLines = sqliteTable("shipment_lines", {
  desadvRef: text("desadv_ref").notNull(),
  gtin: text("gtin").notNull(),
  batch: text("batch"),
  qty: real("qty").notNull(),
});

export const invoices = sqliteTable("invoices", {
  invoiceRef: text("invoice_ref").primaryKey(),
  orderRef: text("order_ref").notNull(),
  desadvRef: text("desadv_ref").unique(),
  invoiceDate: text("invoice_date"),
  totalNet: real("total_net"),
  totalVat: real("total_vat"),
  total: real("total"),
  status: text("status").notNull(),
  sourceDoc: text("source_doc"),
  notes: text("notes"),
});

export const invoiceLines = sqliteTable("invoice_lines", {
  invoiceRef: text("invoice_ref").notNull(),
  gtin: text("gtin").notNull(),
  qty: real("qty").notNull(),
  unitPrice: real("unit_price").notNull(),
  vatRate: real("vat_rate").notNull(),
});

export const proofs = sqliteTable("proofs", {
  docId: text("doc_id").primaryKey(),
  orderRef: text("order_ref").notNull(),
  kind: text("kind").notNull(),
  ref: text("ref"),
  summary: text("summary"),
});

export const claims = sqliteTable("claims", {
  claimId: text("claim_id").primaryKey(),
  receivedAt: text("received_at").notNull(),
  orderRef: text("order_ref"),
  invoiceRef: text("invoice_ref"),
  status: text("status").notNull(),
  sourceDoc: text("source_doc"),
  extraction: text("extraction"),
  verdict: text("verdict"),
  outcome: text("outcome"),
});

export const signoffs = sqliteTable("signoffs", {
  caseId: text("case_id").primaryKey(),
  row: text("row").notNull(),
  kind: text("kind").notNull(),
  subjectRef: text("subject_ref"),
  title: text("title"),
  proposal: text("proposal"),
  reasons: text("reasons"),
  status: text("status").notNull(),
  decidedBy: text("decided_by"),
  decisionReason: text("decision_reason"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
});

export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

// Shipping and invoicing (shipping/warehouse.py, shipping/cases.py)
export const siTrucks = sqliteTable("si_trucks", {
  truckId: text("truck_id").primaryKey(),
  data: text("data").notNull(),
});

export const siManifests = sqliteTable("si_manifests", {
  manifestId: text("manifest_id").primaryKey(),
  truckId: text("truck_id").notNull(),
  status: text("status").notNull(),
  data: text("data").notNull(),
});

export const siPallets = sqliteTable("si_pallets", {
  palletId: text("pallet_id").primaryKey(),
  orderRef: text("order_ref").notNull(),
  gtin: text("gtin").notNull(),
  batch: text("batch"),
  qty: real("qty").notNull(),
  status: text("status").notNull(),
  manifestId: text("manifest_id"),
  truckId: text("truck_id"),
});

export const siScans = sqliteTable("si_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  palletId: text("pallet_id"),
  orderRef: text("order_ref"),
  data: text("data").notNull(),
  result: text("result").notNull(),
  at: text("at").notNull(),
});

export const siLoadings = sqliteTable("si_loadings", {
  loadingId: text("loading_id").primaryKey(),
  orderRef: text("order_ref").notNull(),
  truckId: text("truck_id"),
  manifestId: text("manifest_id"),
  data: text("data").notNull(),
});

export const siExceptions = sqliteTable("si_exceptions", {
  exceptionId: text("exception_id").primaryKey(),
  status: text("status").notNull(),
  data: text("data").notNull(),
});

export const siExceptionCases = sqliteTable("si_exception_cases", {
  caseId: text("case_id").primaryKey(),
  data: text("data").notNull(),
});

export const siProposals = sqliteTable("si_proposals", {
  proposalId: text("proposal_id").primaryKey(),
  caseId: text("case_id").notNull(),
  data: text("data").notNull(),
});

/**
 * DDL used to create the tables (same statements as the Python modules, so a file
 * created by either side is compatible). Kept next to the Drizzle definitions above.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS products (gtin TEXT PRIMARY KEY, item_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  uom TEXT NOT NULL, units_per_case INTEGER NOT NULL DEFAULT 1, list_price REAL, vat_rate REAL NOT NULL,
  units_per_pallet INTEGER, unit_weight_kg REAL);
CREATE TABLE IF NOT EXISTS retailers (gln TEXT PRIMARY KEY, name TEXT NOT NULL, vat_id TEXT, address TEXT, cap TEXT,
  comune TEXT, provincia TEXT, sdi_code TEXT, delivery_point TEXT);
CREATE TABLE IF NOT EXISTS documents (doc_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT, body TEXT, path TEXT,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, subject_ref TEXT, source_doc TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS batches (batch TEXT PRIMARY KEY, gtin TEXT NOT NULL, qty REAL NOT NULL, status TEXT NOT NULL,
  available_from TEXT, source_doc TEXT);
CREATE TABLE IF NOT EXISTS production_events (event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, batch TEXT, gtin TEXT,
  qty REAL, at TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS orders (order_ref TEXT PRIMARY KEY, buyer_gln TEXT, supplier_gln TEXT, order_date TEXT,
  delivery_date TEXT, status TEXT NOT NULL, contract_id TEXT, ordrsp_ref TEXT, source_doc TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS order_lines (order_ref TEXT NOT NULL, line_no INTEGER NOT NULL, gtin TEXT, qty_ordered REAL,
  qty_confirmed REAL, unit_price REAL, PRIMARY KEY (order_ref, line_no));
CREATE TABLE IF NOT EXISTS shipments (desadv_ref TEXT PRIMARY KEY, order_ref TEXT NOT NULL, ship_date TEXT, ddt_ref TEXT,
  source_doc TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS shipment_lines (desadv_ref TEXT NOT NULL, gtin TEXT NOT NULL, batch TEXT, qty REAL NOT NULL);
CREATE TABLE IF NOT EXISTS invoices (invoice_ref TEXT PRIMARY KEY, order_ref TEXT NOT NULL, desadv_ref TEXT UNIQUE,
  invoice_date TEXT, total_net REAL, total_vat REAL, total REAL, status TEXT NOT NULL, source_doc TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS invoice_lines (invoice_ref TEXT NOT NULL, gtin TEXT NOT NULL, qty REAL NOT NULL,
  unit_price REAL NOT NULL, vat_rate REAL NOT NULL);
CREATE TABLE IF NOT EXISTS proofs (doc_id TEXT PRIMARY KEY, order_ref TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT,
  summary TEXT);
CREATE TABLE IF NOT EXISTS claims (claim_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, order_ref TEXT, invoice_ref TEXT,
  status TEXT NOT NULL, source_doc TEXT, extraction TEXT, verdict TEXT, outcome TEXT);
CREATE TABLE IF NOT EXISTS signoffs (case_id TEXT PRIMARY KEY, row TEXT NOT NULL, kind TEXT NOT NULL, subject_ref TEXT,
  title TEXT, proposal TEXT, reasons TEXT, status TEXT NOT NULL, decided_by TEXT, decision_reason TEXT,
  created_at TEXT NOT NULL, decided_at TEXT);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS si_trucks (truck_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_manifests (manifest_id TEXT PRIMARY KEY, truck_id TEXT NOT NULL, status TEXT NOT NULL,
  data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_pallets (pallet_id TEXT PRIMARY KEY, order_ref TEXT NOT NULL, gtin TEXT NOT NULL,
  batch TEXT, qty REAL NOT NULL, status TEXT NOT NULL, manifest_id TEXT, truck_id TEXT);
CREATE TABLE IF NOT EXISTS si_scans (id INTEGER PRIMARY KEY AUTOINCREMENT, pallet_id TEXT, order_ref TEXT,
  data TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_loadings (loading_id TEXT PRIMARY KEY, order_ref TEXT NOT NULL, truck_id TEXT,
  manifest_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_exceptions (exception_id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_exception_cases (case_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS si_proposals (proposal_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, data TEXT NOT NULL);
`;
