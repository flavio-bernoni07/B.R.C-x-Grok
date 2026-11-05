import { documentFile } from "@agent/lib/core/document-file";
import { getReadyErp } from "@agent/lib/db/app";

/** A Mini ERP document as a file download (?inline=1 shows it in the browser instead). */
export async function GET(request: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const f = documentFile(await getReadyErp(), decodeURIComponent(docId));
  if (!f) return Response.json({ error: `No document ${docId}` }, { status: 404 });
  const inline = new URL(request.url).searchParams.has("inline");
  return new Response(f.body, {
    headers: { "Content-Type": f.contentType, "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.filename}"` },
  });
}
