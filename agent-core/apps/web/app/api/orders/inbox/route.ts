import { getReadyErp } from "@agent/lib/db/app";
import { type InboxFilter, ordersInbox } from "@agent/lib/order/inbox";

const FILTERS = new Set<InboxFilter>(["all", "attention", "progress", "completed"]);

/** GET /api/orders/inbox?filter=all|attention|progress|completed&q=: the Orders inbox, attention first. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const f = url.searchParams.get("filter") as InboxFilter | null;
  const filter = f && FILTERS.has(f) ? f : "all";
  const erp = await getReadyErp();
  return Response.json({ rows: ordersInbox(erp, { filter, q: url.searchParams.get("q") ?? "" }) });
}
