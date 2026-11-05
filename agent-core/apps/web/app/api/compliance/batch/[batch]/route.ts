import { passport } from "@agent/lib/compliance/passport";
import { getReadyErp } from "@agent/lib/db/app";

/** Lot compliance passport for one milled batch. */
export async function GET(_request: Request, { params }: { params: Promise<{ batch: string }> }) {
  const { batch } = await params;
  const p = passport(await getReadyErp(), decodeURIComponent(batch));
  if (!p) return Response.json({ error: `No compliance passport for ${batch}` }, { status: 404 });
  return Response.json({ passport: p });
}
