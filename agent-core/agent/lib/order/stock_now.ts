/**
 * Stock checked again now, not only when the order arrived: other orders may have reserved it
 * since. The Ready-to-ship panel shows these beside the checks stored in the case, so a person
 * never approves an ORDRSP that promises stock that is no longer there.
 */
import type { Erp } from "../core/erp";
import { availableToPromise, RESERVED_ORDER_STATUSES } from "../core/stock";

export type StockNowCheck = { label: string; ok: boolean; detail: string; source: string };

export function stockNow(erp: Erp, orderRef: string): StockNowCheck[] {
  const o = erp.order(orderRef);
  if (!o) return [];
  // This order's own reservation is already inside available-to-promise. Add it back so the
  // check asks whether the rest of the stock still covers it.
  const counted = RESERVED_ORDER_STATUSES.includes(o.status);
  return o.lines
    .filter((l): l is typeof l & { gtin: string } => !!l.gtin)
    .map((l) => {
      const a = availableToPromise(erp, l.gtin);
      const want = l.qtyConfirmed ?? l.qtyOrdered ?? 0;
      // availableToPromise floors at zero, which would hide a shortfall once other orders
      // have already reserved the batch. Count this order back, then compare to what is left.
      const own = counted ? want : 0;
      const free = a.released + a.planned - a.committed + own;
      return {
        label: `Stock right now, ${erp.product({ gtin: l.gtin })?.name ?? l.gtin}`,
        ok: free >= want,
        detail: `${want.toLocaleString("en-GB")} needed, ${free.toLocaleString("en-GB")} free to promise now`,
        source: `released ${a.released} + planned ${a.planned} − reserved ${a.committed}${own ? ` (this order's ${want} included)` : ""}; ${a.held} on hold never counts`,
      };
    });
}
