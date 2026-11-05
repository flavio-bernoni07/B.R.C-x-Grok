import { contract, contractDoc } from "@agent/lib/core/contracts";

/** One contract: the summary and the stored document; ?download=1 returns the contract file. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = contractDoc(decodeURIComponent(id));
  if (!doc) return Response.json({ error: `No contract ${id}` }, { status: 404 });
  if (new URL(request.url).searchParams.has("download")) {
    return new Response(`${JSON.stringify(doc, null, 2)}\n`, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${doc.id}.json"` },
    });
  }
  return Response.json({ contract: contract(doc.id), document: doc });
}
