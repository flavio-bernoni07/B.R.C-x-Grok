"use client";

import type { OrderDetail, OrderSummary } from "@agent/lib/order/views";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Panel } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { OrderDetailBody, OrderPill, OrdersTable } from "./order-parts";

/** The Orders page: every ORDERS message, its status and the check that decided it; a row opens the detail. */
export function OrdersView() {
  const [orders, setOrders] = useState<OrderSummary[]>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<OrderDetail | null>(null);

  useEffect(() => {
    fetch("/api/orders")
      .then((r) => r.json())
      .then((d: { orders: OrderSummary[] }) => setOrders(d.orders))
      .catch(() => setOrders([]));
  }, []);

  const open = useCallback((o: OrderSummary) => {
    setSelected(o.orderRef);
    setDetail(null);
    fetch(`/api/orders/${encodeURIComponent(o.orderRef)}`)
      .then((r) => r.json())
      .then((d: { order?: OrderDetail }) => setDetail(d.order ?? null))
      .catch(() => {});
  }, []);

  const waiting = orders?.filter((o) => o.pill.tone === "attention" || o.pill.tone === "grok").length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Orders"
        sub={
          orders
            ? `${orders.length} orders, ${waiting} waiting for a person. Code parses and checks every ORDERS; Grok steps in on exceptions; a person confirms before ORDRSP.`
            : "Loading orders…"
        }
      />
      <div className={selected ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_440px]" : "grid gap-5"}>
        <Panel title="Orders">
          {orders ? <OrdersTable orders={orders} onSelect={open} selected={selected} /> : <div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />}
        </Panel>
        {selected ? (
          <Panel
            title={selected}
            aside={
              <span className="flex items-center gap-2">
                {detail ? <OrderPill order={detail} /> : null}
                <button type="button" onClick={() => setSelected(undefined)} className="text-ink-68 hover:text-ink">
                  Close
                </button>
              </span>
            }
            className="lg:sticky lg:top-0"
          >
            {detail ? <OrderDetailBody order={detail} /> : <div className="h-64 animate-pulse rounded-[12px] bg-hh-honeydew" />}
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
