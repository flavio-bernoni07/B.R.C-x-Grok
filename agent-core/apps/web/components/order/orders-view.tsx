"use client";

import type { InboxFilter, InboxRow } from "@agent/lib/order/inbox";
import type { OrderWorkspace } from "@agent/lib/order/workspace";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { day, PageHeader, Panel, Pill, Segmented } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { OrderWorkspaceBody, STATUS_TONE } from "./workspace";

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

function InboxList({ rows, selected, onOpen }: { readonly rows: InboxRow[]; readonly selected?: string; readonly onOpen: (r: InboxRow) => void }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.orderRef} className="border-hairline border-t first:border-t-0">
          <button
            type="button"
            onClick={() => onOpen(r)}
            className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-1 py-2.5 text-left transition-colors hover:bg-hh-honeydew/60 ${selected === r.orderRef ? "bg-hh-honeydew" : ""}`}
          >
            <span className="truncate text-[14px]">
              <b className="tracking-[-0.02em]">{r.retailer}</b> <span className="text-ink-68">{r.orderRef}</span>
            </span>
            <span className="flex items-center gap-2 justify-self-end">
              <span className="text-[12px] text-ink-68">{r.deliveryDate ? day(r.deliveryDate) : "no date"}</span>
              <Pill tone={STATUS_TONE[r.status]}>{r.statusLabel}</Pill>
            </span>
            <span className="truncate text-[13px] text-ink-78">{r.description}</span>
            <span className="flex flex-wrap justify-end gap-1">
              {r.agents.map((a) => (
                <span key={a} className="rounded-md bg-hh-honeydew px-1.5 py-0.5 text-[11px] text-ink-78">
                  {a}
                </span>
              ))}
            </span>
            <span className="col-span-2 truncate text-[13px] text-ink-68">{r.statusLine}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The Orders page: an email-style inbox; a row (or /orders?ref=REF) opens the order workspace. */
export function OrdersView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get("ref") ?? undefined;
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<InboxRow[]>();
  const [listError, setListError] = useState(false);
  const [ws, setWs] = useState<OrderWorkspace | null>(null);
  const [wsState, setWsState] = useState<"idle" | "loading" | "error" | "missing">("idle");

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setListError(false);
      fetch(`/api/orders/inbox?filter=${filter}&q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
        .then((d: { rows: InboxRow[] }) => setRows(d.rows))
        .catch((e: Error) => {
          if (e.name !== "AbortError") setListError(true);
        });
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [filter, q]);

  useEffect(() => {
    if (!selected) {
      setWs(null);
      setWsState("idle");
      return;
    }
    setWs(null);
    setWsState("loading");
    fetch(`/api/orders/${encodeURIComponent(selected)}/workspace`)
      .then((r) => (r.status === 404 ? { missing: true } : r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { workspace?: OrderWorkspace; missing?: boolean }) => {
        if (d.workspace) {
          setWs(d.workspace);
          setWsState("idle");
        } else setWsState("missing");
      })
      .catch(() => setWsState("error"));
  }, [selected]);

  const go = useCallback((ref?: string) => router.replace(ref ? `${pathname}?ref=${encodeURIComponent(ref)}` : pathname, { scroll: false }), [router, pathname]);

  const attention = rows?.filter((r) => r.status === "attention").length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Orders"
        sub={rows ? `${rows.length} orders shown, ${attention} need attention. Agents do the steps; a person approves what needs a person.` : "Loading orders..."}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search order, retailer or product"
          className="h-[34px] w-[240px] rounded-full bg-white/85 px-3.5 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)] outline-none"
        />
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
      </PageHeader>
      <div className={selected ? "mt-4 grid items-start gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]" : "mt-4 grid gap-5"}>
        <Panel title="Inbox">
          {listError ? (
            <p className="py-6 text-center text-[14px] text-ink-68">The orders could not be loaded. Try again in a moment.</p>
          ) : !rows ? (
            <div className="h-48 animate-pulse rounded-[12px] bg-hh-honeydew" />
          ) : rows.length ? (
            <InboxList rows={rows} selected={selected} onOpen={(r) => go(r.orderRef)} />
          ) : (
            <p className="py-6 text-center text-[14px] text-ink-68">{q || filter !== "all" ? "No orders match." : "No orders yet."}</p>
          )}
        </Panel>
        {selected ? (
          <Panel
            title={selected}
            aside={
              <button type="button" onClick={() => go()} className="text-ink-68 hover:text-ink">
                Close
              </button>
            }
            className="xl:sticky xl:top-0"
          >
            {ws ? (
              <OrderWorkspaceBody ws={ws} />
            ) : wsState === "missing" ? (
              <p className="text-[13px] text-ink-68">There is no saved order {selected}. It may still be a case waiting for a person in Actions.</p>
            ) : wsState === "error" ? (
              <p className="text-[13px] text-ink-68">This order could not be loaded. Try again in a moment.</p>
            ) : (
              <div className="h-64 animate-pulse rounded-[12px] bg-hh-honeydew" />
            )}
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}
