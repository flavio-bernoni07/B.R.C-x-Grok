/**
 * Seed the customer-portal demo orders into the Mini ERP:
 * - ORD-3001: 1,200 Carnaroli ordered / dispatched / invoiced (no retailer receipt for 1,100)
 * - ORD-3002: same qty, invoice at the wrong unit price (pricing demo)
 */
import type { Erp } from "../core/erp";
import { DEMO_RETAILER_GLN } from "../dispute/portal";

const CARNAROLI_GTIN = "8000000000001";
const UNIT_PRICE = 2.2;
const WRONG_PRICE = 2.5;
const QTY = 1200;
const VAT = 4.0;

function money(qty: number, price: number) {
  const totalNet = Math.round(qty * price * 100) / 100;
  const totalVat = Math.round(totalNet * (VAT / 100) * 100) / 100;
  return { totalNet, totalVat, total: Math.round((totalNet + totalVat) * 100) / 100 };
}

export function seedPortalDemoOrders(erp: Erp): { ord3001: string; ord3002: string } {
  if (!erp.order("ORD-3001")) {
    const orderDoc = erp.addDocument("ORDERS", "ORD-3001", "Demo ORD-3001 — 1200 Carnaroli for portal shortage claim", {
      path: "demo/portal/ORD-3001",
    });
    erp.saveOrder({
      orderRef: "ORD-3001",
      buyerGln: DEMO_RETAILER_GLN,
      supplierGln: "SUPPLIER001",
      orderDate: "2026-11-03",
      deliveryDate: "2026-11-05",
      status: "invoiced",
      contractId: "CTR-SCOTTI-ESS-2026",
      sourceDoc: orderDoc,
      notes: { portal_demo: "shortage" },
      lines: [{ lineNo: 1, gtin: CARNAROLI_GTIN, quantity: QTY, qtyConfirmed: QTY, unitPrice: UNIT_PRICE }],
    });
    erp.setOrder("ORD-3001", { ordrspRef: "ORDRSP-ORD-3001" });
    const desadvDoc = erp.addDocument("DESADV", "DESADV-ORD-3001", "DESADV 1200 packs", { path: "demo/portal/DESADV-ORD-3001" });
    erp.saveShipment({
      desadvRef: "DESADV-ORD-3001",
      orderRef: "ORD-3001",
      shipDate: "2026-11-05",
      ddtRef: "DDT-ORD-3001",
      lines: [{ gtin: CARNAROLI_GTIN, batch: "LOT-PORTAL-01", qty: QTY }],
      sourceDoc: desadvDoc,
      notes: "Portal demo: dispatch matches invoice; no RECADV for claimed short receipt",
    });
    const inv = money(QTY, UNIT_PRICE);
    const invDoc = erp.addDocument("INVOIC", "FT-2026/3001", `Invoice net €${inv.totalNet}`, { path: "demo/portal/FT-3001" });
    erp.saveInvoice({
      invoiceRef: "FT-2026/3001",
      orderRef: "ORD-3001",
      desadvRef: "DESADV-ORD-3001",
      invoiceDate: "2026-11-05",
      lines: [{ gtin: CARNAROLI_GTIN, qty: QTY, unitPrice: UNIT_PRICE, vatRate: VAT }],
      totalNet: inv.totalNet,
      totalVat: inv.totalVat,
      total: inv.total,
      status: "sent",
      sourceDoc: invDoc,
      notes: "Portal demo invoice",
    });
    // DDT proof of dispatch only — not a retailer receipt of 1,100.
    erp.addProof({
      docId: erp.nextId("proof", "PRF-"),
      orderRef: "ORD-3001",
      kind: "ddt",
      ref: "DDT-ORD-3001",
      summary: "DDT signed at gate-out for 1,200 packs (dispatch evidence, not retailer receipt qty)",
    });
    erp.log("code", "demo.portal_order", "ORD-3001", { detail: { qty: QTY, price: UNIT_PRICE } });
  }

  if (!erp.order("ORD-3002")) {
    const orderDoc = erp.addDocument("ORDERS", "ORD-3002", "Demo ORD-3002 — wrong invoice price", {
      path: "demo/portal/ORD-3002",
    });
    erp.saveOrder({
      orderRef: "ORD-3002",
      buyerGln: DEMO_RETAILER_GLN,
      supplierGln: "SUPPLIER001",
      orderDate: "2026-11-03",
      deliveryDate: "2026-11-05",
      status: "invoiced",
      contractId: "CTR-SCOTTI-ESS-2026",
      sourceDoc: orderDoc,
      notes: { portal_demo: "pricing" },
      lines: [{ lineNo: 1, gtin: CARNAROLI_GTIN, quantity: QTY, qtyConfirmed: QTY, unitPrice: UNIT_PRICE }],
    });
    erp.setOrder("ORD-3002", { ordrspRef: "ORDRSP-ORD-3002" });
    const desadvDoc = erp.addDocument("DESADV", "DESADV-ORD-3002", "DESADV 1200 packs", { path: "demo/portal/DESADV-ORD-3002" });
    erp.saveShipment({
      desadvRef: "DESADV-ORD-3002",
      orderRef: "ORD-3002",
      shipDate: "2026-11-05",
      ddtRef: "DDT-ORD-3002",
      lines: [{ gtin: CARNAROLI_GTIN, batch: "LOT-PORTAL-02", qty: QTY }],
      sourceDoc: desadvDoc,
      notes: null,
    });
    const inv = money(QTY, WRONG_PRICE);
    const invDoc = erp.addDocument("INVOIC", "FT-2026/3002", `Invoice at wrong price €${WRONG_PRICE}`, {
      path: "demo/portal/FT-3002",
    });
    erp.saveInvoice({
      invoiceRef: "FT-2026/3002",
      orderRef: "ORD-3002",
      desadvRef: "DESADV-ORD-3002",
      invoiceDate: "2026-11-05",
      lines: [{ gtin: CARNAROLI_GTIN, qty: QTY, unitPrice: WRONG_PRICE, vatRate: VAT }],
      totalNet: inv.totalNet,
      totalVat: inv.totalVat,
      total: inv.total,
      status: "sent",
      sourceDoc: invDoc,
      notes: `Portal pricing demo: ordered @ €${UNIT_PRICE}, invoiced @ €${WRONG_PRICE}`,
    });
    erp.log("code", "demo.portal_order", "ORD-3002", { detail: { qty: QTY, invoice_price: WRONG_PRICE } });
  }

  return { ord3001: "ORD-3001", ord3002: "ORD-3002" };
}
