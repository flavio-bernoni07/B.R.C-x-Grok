/** Employee Actions → Disputes inbox (customer-portal cases). */
import { getReadyErp } from "@agent/lib/db/app";
import { listEmployeePortalDisputes } from "@agent/lib/dispute/portal";

export async function GET() {
  const erp = await getReadyErp();
  const rows = listEmployeePortalDisputes(erp);
  const notifications = erp.notifications({ unreadOnly: true }).filter((n) => n.kind === "customer_dispute");
  return Response.json({
    disputes: rows,
    pending: rows.filter((r) => r.signoff_status === "pending").length,
    notifications,
  });
}
