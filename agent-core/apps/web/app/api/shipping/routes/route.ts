import { getReadyErp } from "@agent/lib/db/app";
import { DISPATCH_DAY } from "@agent/lib/demo/dispatch";
import { dispatchSignoffs, proposeDispatchPlan, readyOrders, RoutePlanError } from "@agent/lib/shipping/routes";

/** The latest dispatch plan for a ship date (waiting, approved or rejected) and the orders still to plan. */
export async function GET(request: Request) {
  const erp = await getReadyErp();
  const shipDate = new URL(request.url).searchParams.get("date") ?? DISPATCH_DAY;
  const cases = dispatchSignoffs(erp).filter((s) => (s.proposal as { ship_date?: string } | null)?.ship_date === shipDate);
  return Response.json({ ship_date: shipDate, ready: readyOrders(erp), plan_case: cases.at(-1) ?? null });
}

/** Ask the logistics agent for a plan: code plans, Grok briefs, the transport planner decides in the sign-off card. */
export async function POST(request: Request) {
  const erp = await getReadyErp();
  const body = (await request.json().catch(() => ({}))) as { ship_date?: string };
  const shipDate = body.ship_date ?? DISPATCH_DAY;
  try {
    const r = await proposeDispatchPlan(erp, { shipDate });
    return Response.json({ ...r, ship_date: shipDate, ready: readyOrders(erp), plan_case: erp.signoff(r.case_id) });
  } catch (err) {
    if (err instanceof RoutePlanError) return Response.json({ error: err.message, ship_date: shipDate, ready: readyOrders(erp) }, { status: 422 });
    throw err;
  }
}
