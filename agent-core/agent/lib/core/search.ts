/** Sidebar search: orders, retailers, invoices, claims and trucks, matched on their ids and names. */
import type { Erp } from "./erp";

export type SearchHit = { label: string; sub: string; href: string };

export function search(erp: Erp, q: string, limit = 8): SearchHit[] {
  const term = q.trim().toLowerCase();
  if (term.length < 2) return [];
  const has = (...xs: (string | null | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(term));
  const hits: SearchHit[] = [];
  const retailerName = new Map(erp.retailers().map((r) => [r.gln, r.name]));
  const orderHref = (ref: string) => `/orders?ref=${encodeURIComponent(ref)}`;

  for (const o of erp.orders()) {
    const name = o.buyerGln ? retailerName.get(o.buyerGln) : undefined;
    if (has(o.orderRef, name)) hits.push({ label: o.orderRef, sub: `Order${name ? ` · ${name}` : ""} · ${o.status.replace(/_/g, " ")}`, href: orderHref(o.orderRef) });
  }
  for (const r of erp.retailers()) if (has(r.name, r.gln)) hits.push({ label: r.name, sub: "Retailer", href: `/orders?retailer=${encodeURIComponent(r.gln)}` });
  for (const i of erp.invoices()) if (has(i.invoiceRef)) hits.push({ label: i.invoiceRef, sub: `Invoice · order ${i.orderRef}`, href: orderHref(i.orderRef) });
  const pendingBySubject = new Map(erp.signoffs().map((s) => [s.subjectRef, s.caseId]));
  for (const c of erp.claims()) {
    if (!has(c.claimId, c.orderRef, c.invoiceRef)) continue;
    const so = pendingBySubject.get(c.claimId);
    const href = so ? `/actions?case=${encodeURIComponent(so)}` : c.orderRef ? orderHref(c.orderRef) : "/actions";
    hits.push({ label: c.claimId, sub: `Claim${c.orderRef ? ` · order ${c.orderRef}` : ""} · ${c.status.replace(/_/g, " ")}`, href });
  }
  try {
    for (const t of erp.sqlite.prepare("select truck_id, data from si_trucks").all() as { truck_id: string; data: string }[]) {
      const d = JSON.parse(t.data) as { plate?: string; destination?: string };
      if (has(t.truck_id, d.plate)) hits.push({ label: t.truck_id, sub: `Truck${d.plate ? ` · ${d.plate}` : ""}${d.destination ? ` · ${d.destination}` : ""}`, href: "/operations?tab=warehouse" });
    }
  } catch {
    /* no shipping tables yet */
  }
  return hits.slice(0, limit);
}
