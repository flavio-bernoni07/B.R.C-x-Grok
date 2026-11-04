/**
 * Stock checked again now, not only when the order arrived: other orders may have reserved it
 * since. The Ready-to-ship panel shows these beside the checks stored in the case, so a person
 * never approves an ORDRSP that promises stock that is no longer there.
 */
import type { Erp } from "../core/erp";
import { availableToPromise, OPEN_ORDER_STATUSES } from "../core/stock";

export type StockNowCheck = { label: string; ok: boolean; detail: string; source: string };

export function stockNow(erp: Erp, orderRef: string): StockNowCheck[] {
  const o = erp.order(orderRef);
  if (!o) return [];
  // An order already confirmed counts in `committed`; one waiting for approval does not yet.
  const counted = OPEN_ORDER_STATUSES.includes(o.status);
  return o.lines
    .filter((l): l is typeof l & { gtin: string } => !!l.gtin)
    .map((l) => {
      const a = availableToPromise(erp, l.gtin);
      const want = l.qtyConfirmed ?? l.qtyOrdered ?? 0;
      const free = counted ? a.atp + want : a.atp;
      return {
        label: `Stock right now, ${erp.product({ gtin: l.gtin })?.name ?? l.gtin}`,
        ok: free >= want,
        detail: `${want.toLocaleString("en-GB")} needed, ${free.toLocaleString("en-GB")} free to promise now`,
        source: `released ${a.released} + planned ${a.planned} − reserved ${a.committed}${counted ? ` (this order's ${want} included)` : ""}; ${a.held} on hold never counts`,
      };
    });
}
