import { getReadyErp } from "@agent/lib/db/app";
import { proposeWithGrok, viewExceptionCase } from "@agent/lib/shipping/cases";

/** Grok proposes a resolution; code validates it; it never approves (that is the sign-off route). */
export async function POST(_req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const erp = await getReadyErp();
  const c = viewExceptionCase(erp, caseId);
  if (!c) return Response.json({ error: `No exception case ${caseId}` }, { status: 404 });
  if (c.status !== "open" && c.status !== "clarification_requested") {
    return Response.json({ error: `${caseId} is ${c.status}, not open for a new proposal` }, { status: 409 });
  }
  const proposal = await proposeWithGrok(erp, caseId);
  return Response.json({ case: viewExceptionCase(erp, caseId), proposal });
}
