/**
 * A Mini ERP document as a file to download: its stored body, a file name that says what it is,
 * and a content type by kind (XML for FatturaPA, plain text for EDI messages, JSON for JSON bodies).
 */
import type { Erp } from "./erp";

export type DocumentFile = { docId: string; kind: string; ref: string | null; filename: string; contentType: string; body: string };

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function documentFile(erp: Erp, docId: string): DocumentFile | null {
  const d = erp.document(docId);
  if (!d) return null;
  const body = d.body ?? "";
  const kind = d.kind;
  const trimmed = body.trimStart();
  const isXml = /fattura|xml/i.test(kind) || trimmed.startsWith("<?xml") || trimmed.startsWith("<");
  const isJson = !isXml && (trimmed.startsWith("{") || trimmed.startsWith("["));
  const ext = isXml ? "xml" : isJson ? "json" : /email|mail|txt/i.test(kind) ? "txt" : "edi";
  const contentType = isXml ? "application/xml" : isJson ? "application/json" : "text/plain";
  const filename = [d.docId, slug(kind), d.ref ? slug(d.ref) : null].filter(Boolean).join("_") + `.${ext}`;
  return { docId: d.docId, kind, ref: d.ref ?? null, filename, contentType: `${contentType}; charset=utf-8`, body };
}

/** Every document tied to an order: the ORDERS and ORDRSP, shipping documents, invoices, proofs, claims. */
export function orderDocuments(erp: Erp, orderRef: string, extraRefs: string[] = []): { docId: string; kind: string; ref: string | null; filename: string; href: string }[] {
  const seen = new Map<string, { docId: string; kind: string; ref: string | null; filename: string; href: string }>();
  const order = erp.order(orderRef);
  const ids = new Set<string>([order?.sourceDoc, order?.ordrspRef].filter((x): x is string => !!x));
  for (const ref of [orderRef, ...extraRefs]) for (const d of erp.documents({ ref })) ids.add(d.docId);
  for (const a of erp.auditLog(orderRef)) if (a.sourceDoc && /^DOC-|^POD-/.test(a.sourceDoc)) ids.add(a.sourceDoc);
  for (const id of ids) {
    const f = documentFile(erp, id);
    if (f) seen.set(id, { docId: f.docId, kind: f.kind, ref: f.ref, filename: f.filename, href: `/api/documents/${encodeURIComponent(f.docId)}` });
  }
  return [...seen.values()].sort((a, b) => a.docId.localeCompare(b.docId));
}
