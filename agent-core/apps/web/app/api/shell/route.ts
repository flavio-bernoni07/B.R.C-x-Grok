import { pending } from "@agent/lib/core/signoff";
import type { Erp } from "@agent/lib/core/erp";
import { getReadyErp } from "@agent/lib/db/app";

/** Retailers with the most orders first (the banner shows Esselunga on top). */
function retailersByOrders(erp: Erp) {
  const count: Record<string, number> = {};
  for (const o of erp.orders()) if (o.buyerGln) count[o.buyerGln] = (count[o.buyerGln] ?? 0) + 1;
  return erp
    .retailers()
    .map((r) => ({ gln: r.gln, name: r.name, orders: count[r.gln] ?? 0 }))
    .sort((a, b) => b.orders - a.orders || (a.name === "Esselunga" ? -1 : b.name === "Esselunga" ? 1 : a.name.localeCompare(b.name)));
}

export async function GET() {
  const erp = await getReadyErp();
  return Response.json({ pending: pending(erp).length, retailers: retailersByOrders(erp) });
}
