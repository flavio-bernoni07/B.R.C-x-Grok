import { getReadyErp } from "@agent/lib/db/app";

/** A person asks for clarification on a case: logged in the audit trail only; the case stays pending. */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const body = (await request.json().catch(() => ({}))) as { by?: string; reason?: string };
  const by = body.by?.trim();
  const reason = body.reason?.trim();
  if (!by || !reason) return Response.json({ error: "Say who asks and write one line on what is unclear." }, { status: 400 });
  const erp = await getReadyErp();
  const c = erp.signoff(caseId);
  if (!c) return Response.json({ error: `No sign-off case ${caseId}` }, { status: 404 });
  if (c.status !== "pending") return Response.json({ error: `${caseId} is already decided.` }, { status: 409 });
  erp.log(`person:${by}`, "signoff.clarification_requested", c.subjectRef, { sourceDoc: caseId, detail: { reason } });
  return Response.json({ case: c, audit: erp.auditLog(c.subjectRef) });
}
