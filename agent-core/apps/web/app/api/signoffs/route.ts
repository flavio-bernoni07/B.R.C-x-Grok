import { pending } from "@agent/lib/core/signoff";
import { getReadyErp } from "@agent/lib/db/app";

export async function GET(request: Request) {
  const erp = await getReadyErp();
  const all = new URL(request.url).searchParams.has("all");
  return Response.json(all ? { pending: pending(erp), all: erp.signoffs().reverse() } : { pending: pending(erp) });
}
