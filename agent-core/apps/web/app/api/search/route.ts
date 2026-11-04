import { search } from "@agent/lib/core/search";
import { getReadyErp } from "@agent/lib/db/app";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return Response.json({ hits: search(await getReadyErp(), q) });
}
