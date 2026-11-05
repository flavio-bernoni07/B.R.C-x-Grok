"use client";

/**
 * Orders: one table, the launch film's way (avatar, bold main cell, quiet cells, one pill). A row
 * opens the order in a panel from the right edge (/orders?ref=REF). Filters run on the loaded rows.
 */
import type { InboxRow, InboxStatus } from "@agent/lib/order/inbox";
import type { OrderWorkspace } from "@agent/lib/order/workspace";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, DataTable, Drawer, type OwnerKind, PageHeader, Pill, Segmented, eur, personFor, qty } from "@/components/kit";
import { Page, RetailerLogo } from "@/components/shell/app-shell";
import { OrderDetail } from "./order-detail";
import { STATUS_TONE } from "./workspace";
import { SectionChat } from "@/components/shell/section-chat";

/** "On it": the face and name of whoever holds the order (a person, the warehouse team or a Grok agent), the desk underneath. */
function OnIt({ kind, name }: { readonly kind: OwnerKind; readonly name: string }) {
  const person = kind === "person" || kind === "team" ? personFor(name) : undefined;
  return (
    <span className="flex items-center gap-2.5">
      <Avatar kind={kind} name={name} size={30} />
      {kind === "none" ? (
        <span className="text-ink-50">Done</span>
      ) : (
        <span className="min-w-0 leading-tight">
          {/* An agent is Grok (and code), never a person: say so, with the job it is doing underneath. */}
          <b className="block font-bold text-ink">{kind === "agent" ? "Grok" : person ? person.name : name}</b>
          {kind === "agent" ? <span className="block text-[12px] text-ink-68">{name}</span> : person ? <span className="block text-[12px] text-ink-68">{person.role}</span> : null}
        </span>
      )}
    </span>
  );
}

type Filter = "all" | "attention" | "moving" | "completed";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs you" },
  { value: "moving", label: "Moving" },
  { value: "completed", label: "Done" },
];

const inFilter = (f: Filter, s: InboxStatus) => f === "all" || (f === "moving" ? s === "on_track" || s === "waiting" : s === f);

export function OrdersView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get("ref") ?? undefined;
  const retailer = params.get("retailer") ?? undefined;
  const [filter, setFilter] = useState<Filter>("all");
  const [rows, setRows] = useState<InboxRow[]>();
  const [failed, setFailed] = useState(false);
  const [ws, setWs] = useState<OrderWorkspace | null>(null);
  // Bumped when a choice is saved anywhere (announceChange), so the list and the panel reload.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener("brc:changed", bump);
    return () => window.removeEventListener("brc:changed", bump);
  }, []);

  useEffect(() => {
    void version;
    fetch("/api/orders/inbox?filter=all")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { rows: InboxRow[] }) => setRows(d.rows))
      .catch(() => setFailed(true));
  }, [version]);

  useEffect(() => {
    void version;
    if (!selected) return;
    fetch(`/api/orders/${encodeURIComponent(selected)}/workspace`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { workspace?: OrderWorkspace }) => setWs(d.workspace ?? null))
      .catch(() => setWs(null));
  }, [selected, version]);

  const go = useCallback(
    (ref?: string) => {
      const next = new URLSearchParams(params.toString());
      if (ref) next.set("ref", ref);
      else next.delete("ref");
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname, params],
  );

  const scoped = useMemo(() => (rows ?? []).filter((r) => !retailer || r.retailer === retailer), [rows, retailer]);
  const shown = scoped.filter((r) => inFilter(filter, r.status));

  return (
    <>
      <Page>
        <PageHeader title={retailer ?? "Orders"}>
          <Segmented options={FILTERS.map((f) => ({ ...f, count: scoped.filter((r) => inFilter(f.value, r.status)).length }))} value={filter} onChange={setFilter} />
        </PageHeader>
        {failed ? (
          <p className="text-[15px] text-ink-68">The orders could not be loaded.</p>
        ) : !rows ? (
          <div className="h-80 animate-pulse rounded-[16px] bg-hh-honeydew" />
        ) : (
          <DataTable
            rows={shown}
            rowKey={(r) => r.orderRef}
            selectedKey={selected}
            onRowClick={(r) => go(r.orderRef)}
            empty="No orders here."
            columns={[
              {
                key: "o",
                header: "Order",
                main: true,
                cell: (r) => r.orderRef,
              },
              {
                key: "r",
                header: "Retailer",
                cell: (r) => (
                  <span className="flex items-center gap-2.5">
                    <RetailerLogo name={r.retailer} size={22} />
                    {r.retailer}
                  </span>
                ),
              },
              { key: "p", header: "Product", cell: (r) => `${r.description.replace(/ · .*$/, "").replace(/^Riso Scotti |^Scotti /, "")} · ${qty(r.units)}` },
              {
                key: "w",
                header: "On it",
                cell: (r) => (
                  <OnIt kind={r.owner.kind} name={r.owner.name} />
                ),
              },
              { key: "v", header: "Value", align: "right", cell: (r) => <b className="font-bold text-[16px] text-ink">{r.value ? eur(r.value, 0) : "–"}</b> },
              {
                key: "s",
                header: "Status",
                cell: (r) => (r.split ? <Pill tone="grok">Grok: split</Pill> : <Pill tone={STATUS_TONE[r.status]}>{r.statusLabel}</Pill>),
              },
            ]}
          />
        )}
        <SectionChat
          placeholder="Ask Grok about the orders…"
          context={{ page: "orders" }}
          suggestions={["Which orders need a person?", "Which orders ship this week?"]}
        />
      </Page>
      <Drawer
        open={!!selected}
        onClose={() => {
          go();
          setWs(null);
        }}
      >
        {ws && ws.orderRef === selected ? <OrderDetail ws={ws} /> : <div className="m-8 h-64 animate-pulse rounded-[16px] bg-hh-honeydew" />}
      </Drawer>
    </>
  );
}
