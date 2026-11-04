import { getReadyErp } from "@agent/lib/db/app";
import { financeView } from "@agent/lib/finance/documents";

/** Invoices with their order and shipment, and the documents list. `?doc=DOC-00005` returns one document's text. */
export async function GET(request: Request) {
  const erp = await getReadyErp();
  const doc = new URL(request.url).searchParams.get("doc");
  if (doc) {
    const d = erp.document(doc);
    if (!d) return Response.json({ error: `There is no document ${doc}.` }, { status: 404 });
    return Response.json({ docId: d.docId, kind: d.kind, ref: d.ref, createdAt: d.createdAt, body: d.body ?? "" });
  }
  return Response.json(financeView(erp));
}
