/**
 * Finance & Documents: invoices linked to their order and shipment, and every document the app
 * wrote (read-only view of the Mini ERP).
 */
import type { Erp } from "../core/erp";

export const FINANCE_NOTES = [
  "Not submitted to SdI: there is no submission in this demo.",
  "No invoice PDF renderer: XML and EDI shown.",
  "Retailer receipts (RECADV) and remittances (REMADV): not in the app yet.",
];

export type FinanceInvoice = {
  invoiceRef: string;
  orderRef: string;
  desadvRef: string | null;
  ddtRef: string | null;
  invoiceDate: string | null;
  totalNet: number | null;
  totalVat: number | null;
  total: number | null;
  status: string;
  documents: { docId: string; kind: string }[];
};

export function financeView(erp: Erp) {
  const shipments = erp.shipments();
  const docs = erp.documents();
  const invoices: FinanceInvoice[] = erp.invoices().map((i) => ({
    invoiceRef: i.invoiceRef,
    orderRef: i.orderRef,
    desadvRef: i.desadvRef,
    ddtRef: shipments.find((s) => s.desadvRef === i.desadvRef)?.ddtRef ?? null,
    invoiceDate: i.invoiceDate,
    totalNet: i.totalNet,
    totalVat: i.totalVat,
    total: i.total,
    status: i.status,
    documents: docs.filter((d) => d.ref === i.invoiceRef).map((d) => ({ docId: d.docId, kind: d.kind })),
  }));
  const creditNotes = docs.filter((d) => d.kind === "FatturaPA TD04" || d.kind === "INVOIC 381").map((d) => ({ docId: d.docId, kind: d.kind, ref: d.ref }));
  return {
    invoices,
    creditNotes,
    documents: docs.map((d) => ({ docId: d.docId, kind: d.kind, ref: d.ref, createdAt: d.createdAt, size: d.body?.length ?? 0 })),
    notes: FINANCE_NOTES,
  };
}

export type FinanceView = ReturnType<typeof financeView>;
