import { getReadyErp } from "@agent/lib/db/app";

export async function GET(_req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const erp = await getReadyErp();
  const c = erp.signoff(caseId);
  if (!c) return Response.json({ error: `No sign-off case ${caseId}` }, { status: 404 });
  return Response.json({ case: c, audit: erp.auditLog(c.subjectRef) });
}
