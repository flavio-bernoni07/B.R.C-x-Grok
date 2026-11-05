/** Customer dispute chat turn — same handleCustomerMessage workflow as before. */
import { getReadyErp } from "@agent/lib/db/app";
import { DEMO_RETAILER_GLN, handleCustomerMessage, simulatedSession } from "@agent/lib/dispute/portal";
import { cookies } from "next/headers";
import { COOKIE } from "../session/route";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    conversation_id?: string;
    idempotency_key?: string;
  };
  if (!body.message?.trim()) return Response.json({ error: "message is required" }, { status: 400 });

  const erp = await getReadyErp();
  const jar = await cookies();
  const gln = jar.get(COOKIE)?.value || DEMO_RETAILER_GLN;
  let session;
  try {
    session = simulatedSession(erp, gln);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 401 });
  }

  const result = await handleCustomerMessage(erp, session, {
    message: body.message,
    conversationId: body.conversation_id,
    idempotencyKey: body.idempotency_key,
  });
  return Response.json({ ...result, session });
}
