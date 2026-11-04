/** Employee workspace for one customer-portal dispute case. */
import { getReadyErp } from "@agent/lib/db/app";
import { employeeDisputeWorkspace } from "@agent/lib/dispute/portal";

export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const erp = await getReadyErp();
  try {
    return Response.json(employeeDisputeWorkspace(erp, caseId));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 404 });
  }
}
