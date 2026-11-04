"use client";

import type { OrderDetail, OrderSummary } from "@agent/lib/order/views";
import type { SimulateFeedItemResult } from "@agent/lib/order/service";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Panel } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { OrderDetailBody, OrderPill, OrdersTable } from "./order-parts";

type SimSummary = { total: number; ok: number; failed: number; awaiting_person: number };

/** The Orders page: every ORDERS message, its status and the check that decided it; a row opens the detail. */
export function OrdersView() {
  const [orders, setOrders] = useState<OrderSummary[]>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [simSummary, setSimSummary] = useState<SimSummary | null>(null);
  const [simResults, setSimResults] = useState<SimulateFeedItemResult[] | null>(null);
  const [simError, setSimError] = useState<string>();

  const reload = useCallback(() => {
    fetch("/api/orders")
      .then((r) => r.json())
      .then((d: { orders: OrderSummary[] }) => setOrders(d.orders))
      .catch(() => setOrders([]));
  }, []);

  useEffect(reload, [reload]);

  const open = useCallback((o: OrderSummary) => {
    setSelected(o.orderRef);
    setDetail(null);
    fetch(`/api/orders/${encodeURIComponent(o.orderRef)}`)
      .then((r) => r.json())
      .then((d: { order?: OrderDetail }) => setDetail(d.order ?? null))
      .catch(() => {});
  }, []);

  const runSimulation = async () => {
    setSimBusy(true);
    setSimError(undefined);
    try {
      const res = await fetch("/api/orders/simulate", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSimError(data.error ?? `Simulation failed (${res.status})`);
        return;
      }
      setSimSummary(data.summary ?? null);
      setSimResults(data.results ?? null);
      if (Array.isArray(data.orders)) setOrders(data.orders);
      else reload();
    } catch (err) {
      setSimError((err as Error).message);
    } finally {
      setSimBusy(false);
    }
  };

  const waiting = orders?.filter((o) => o.pill.tone === "attention" || o.pill.tone === "grok").length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Orders"
        sub={
          orders
            ? `${orders.length} orders, ${waiting} waiting for a person. Code parses and checks every ORDERS against available-to-promise; Grok steps in on exceptions; a person confirms before ORDRSP.`
            : "Loading orders…"
        }
      >
        <button
          type="button"
          disabled={simBusy}
          onClick={() => void runSimulation()}
          className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
        >
          {simBusy ? "Running simulation…" : "Run order simulation"}
        </button>
      </PageHeader>

      {simError ? <p className="text-[13px] text-st-wrong">{simError}</p> : null}
      {simSummary ? (
        <Panel
          title="Simulation feed"
          aside={`${simSummary.ok}/${simSummary.total} processed · ${simSummary.awaiting_person} in Sign-off Pending`}
        >
          <p className="mb-2 text-[13px] text-ink-78">
            Each run <b>clears</b> prior orders, sign-offs and shipping, then loads the <b>22 labelled bench POs</b> in{" "}
            <code className="text-[12px]">data/bench/cases.json</code>, plus the golden order and the ESS scenarios in{" "}
            <code className="text-[12px]">data/orders/feed.json</code> — as if they were the company’s first orders.
            Cases that need a person go to Sign-off Pending; the batch never stops on the first gate.
          </p>
          {simResults ? (
            <ul className="space-y-1.5 text-[12.5px]">
              {simResults.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-bold">{r.label}</span>
                  <span className="text-ink-68">{r.file}</span>
                  {r.ok && r.result ? (
                    <span className="text-ink-78">
                      → {r.result.step} ({r.result.case_id}
                      {r.result.order_ref ? `, ${r.result.order_ref}` : ""})
                    </span>
                  ) : (
                    <span className="text-st-wrong">→ {r.error ?? "failed"}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}

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
