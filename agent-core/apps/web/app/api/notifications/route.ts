/** Persistent internal notifications (dashboard only — no email/SMS claimed). */
import { getReadyErp } from "@agent/lib/db/app";

export async function GET(request: Request) {
  const unread = new URL(request.url).searchParams.get("unread") === "1";
  const erp = await getReadyErp();
  return Response.json({ notifications: erp.notifications({ unreadOnly: unread }) });
}
