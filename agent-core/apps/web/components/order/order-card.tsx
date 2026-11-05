"use client";

import type { OrderAvailability, OrderDetail, OrderSummary } from "@agent/lib/order/views";
import type { ReceiveResult } from "@agent/lib/order/service";
import { day, Facts, Panel, qty, SourceTag } from "@/components/kit";
import { OrderDetailBody, OrderPill, OrdersTable } from "./order-parts";

const STEP: Record<ReceiveResult["step"], string> = {
  confirm: "Checks passed. A person confirms before the ORDRSP goes out.",
  auto_confirmed: "A clean order: every check passed, so Grok confirmed it and the ORDRSP went out.",
  price_fix: "The price does not match the contract. A person sends the mail, then types a manual EDI or leaves the order Pending.",
  manual_edi: "The EDI cannot be read safely. A person types a manual EDI or leaves the order Pending.",
  qty_choice: "Stock short. Choose split (ORDRSP for available qty) or mail (Pending, no ORDRSP) in Sign-off.",
  stock_short: "Not enough stock and no split is possible. A person decides.",
};

const Problem = ({ text }: { readonly text: string }) => (
  <Panel>
    <p className="text-[13px] text-ink-78">{text}</p>
  </Panel>
);

/** One order, compact: for order_get and order_receive. */
export function OrderCard({ output }: { readonly output: unknown }) {
  const o = (output ?? {}) as { order?: OrderDetail | null; result?: ReceiveResult; error?: string };
  if (o.error) return <Problem text={o.error} />;
  if (!o.order) return <Problem text={o.result ? `Waiting for a person: case ${o.result.case_id}. ${STEP[o.result.step]}` : "No order."} />;
  return (
    <Panel title={`Order ${o.order.orderRef}`} aside={<OrderPill order={o.order} />}>
      {o.result ? <p className="mb-3 text-[13px] text-ink-78">{STEP[o.result.step]}</p> : null}
      <OrderDetailBody order={o.order} compact />
    </Panel>
  );
}

/** The orders table: for order_list. */
export function OrdersTableCard({ output }: { readonly output: unknown }) {
  const orders = ((output ?? {}) as { orders?: OrderSummary[] }).orders ?? [];
  return (
    <Panel title="Orders" aside={`${orders.length} orders`}>
      <OrdersTable orders={orders} compact />
    </Panel>
  );
}

/** Available to promise for one product: for order_availability. */
export function AvailabilityCard({ output }: { readonly output: unknown }) {
  const o = (output ?? {}) as { availability?: OrderAvailability; error?: string };
  if (!o.availability) return <Problem text={o.error ?? "No availability."} />;
  const a = o.availability;
  return (
    <Panel title={a.product ?? a.gtin} aside={a.byDate ? `by ${day(a.byDate)}` : "all planned batches"}>
      <div className="font-bold text-[24px] tabular-nums tracking-[-0.03em]">{qty(a.atp)}</div>
      <p className="mb-3 text-[12px] text-ink-68">can be promised</p>
      <Facts
        items={[
          ["Released", qty(a.released)],
          ["Planned by the date", qty(a.planned)],
          ["Confirmed, not shipped", `− ${qty(a.committed)}`],
          ["On quality hold", `${qty(a.held)} (never counts)`],
          ["Next planned batch", day(a.nextReadyDate)],
          ["Source", <SourceTag key="s">{a.source}</SourceTag>],
        ]}
      />
    </Panel>
  );
}
