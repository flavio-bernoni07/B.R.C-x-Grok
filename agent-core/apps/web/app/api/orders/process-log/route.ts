/**
 * GET /api/orders/process-log: the Order process trail for the Grok side panel
 * (parse fixes, qty gates, price mismatches, confirms). Newest first.
 */
import { getReadyErp } from "@agent/lib/db/app";

const ORDER_ACTIONS = new Set([
  "orders.received",
  "order.parse_fix",
  "order.qty_short",
  "order.qty_split",
  "order.qty_parked",
  "order.qty_pending",
  "order.price_pending",
  "order.price_mismatch",
  "order.checks_passed",
  "order.ordrsp_sent",
]);

function lineFor(action: string, actor: string, detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  switch (action) {
    case "orders.received":
      return "ORDERS received; code starts parse → stock → price.";
    case "order.parse_fix": {
      const changes = Array.isArray(d) ? d : (d.changes as unknown[] | undefined);
      if (Array.isArray(changes) && changes.length) {
        const bits = changes
          .map((c) => {
            const x = c as { segment?: string; before?: string; after?: string };
            return `${x.segment ?? "?"}: ${x.before ?? "?"} → ${x.after ?? "?"}`;
          })
          .join("; ");
        return `Grok corrected the EDI (${bits}); the parser reads it again.`;
      }
      return "Grok proposed an EDI fix; the parser reads it again.";
    }
    case "order.qty_short":
      return d.action === "await_operator" || (d as { action?: string }).action === "await_operator"
        ? "Stock short versus available-to-promise. Waiting in Sign-off for split or mail (then Pending)."
        : `Stock short: ${(d as { action?: string }).action ?? "change"} noted by ${actor}.`;
    case "order.qty_split":
      return "Operator chose split: available qty re-enters the stock check toward ORDRSP.";
    case "order.qty_parked":
    case "order.qty_pending":
      return "Operator chose mail: order is Pending. No ORDRSP while blocked; the feed continues.";
    case "order.price_pending":
      return "Price mail sent; order is Pending until a new ORDERS.";
    case "order.price_mismatch":
      return "Price does not match the contract. Draft mail ready; waiting in Sign-off (then Pending).";
    case "order.checks_passed":
      return "Parse, stock and price passed. Waiting for the person to confirm before ORDRSP.";
    case "order.ordrsp_sent":
      return "Person confirmed. ORDRSP written and handed to Shipping.";
    default:
      return `${action} (${actor})`;
  }
}

export async function GET(req: Request) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 40) || 40, 100);
  const erp = await getReadyErp();
  const entries = erp
    .auditLog()
    .filter((a) => ORDER_ACTIONS.has(a.action) || (a.action.startsWith("order.") && (a.actor === "grok" || a.actor === "code" || a.actor === "person" || a.actor.startsWith("person:"))))
    .slice()
    .reverse()
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      at: a.at,
      actor: a.actor,
      action: a.action,
      subjectRef: a.subjectRef,
      sourceDoc: a.sourceDoc,
      text: lineFor(a.action, a.actor, a.detail),
    }));
  return Response.json({ entries });
}
