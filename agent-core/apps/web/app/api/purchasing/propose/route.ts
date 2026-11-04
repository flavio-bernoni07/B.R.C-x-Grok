/** Opens a `purchase` sign-off case for one variety. A person approves it in Actions; nothing is bought. */
import { getReadyErp } from "@agent/lib/db/app";
import { proposePurchase } from "@agent/lib/purchasing/decide";
import { paddyToBuy } from "@agent/lib/purchasing/paddy";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { variety?: string };
  if (!body.variety) return Response.json({ error: "Say which variety to propose." }, { status: 400 });
  const erp = await getReadyErp();
  try {
    const res = proposePurchase(erp, await paddyToBuy(erp), body.variety);
    return Response.json({ case_id: res.case_id, created: res.created, case: erp.signoff(res.case_id) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
