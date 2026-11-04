"use client";

import type { Signoff } from "@agent/lib/core/erp";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, PageHeader, Panel, Segmented, day } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { SignoffCard, SignoffStatus } from "./signoff";

/** Desk tabs: confirm (Send-off), price errors, quantity errors, plus other rows / decided. */
type DeskTab = "sendoff" | "price" | "quantity" | "other" | "decided";

const SEND_OFF_KINDS = new Set(["confirm"]);
const PRICE_KINDS = new Set(["price_fix"]);
const QTY_KINDS = new Set(["qty_choice", "stock_short"]);

function tabFor(c: Signoff): Exclude<DeskTab, "decided"> {
  if (c.status !== "pending") return "other";
  if (c.row === "order" && SEND_OFF_KINDS.has(c.kind)) return "sendoff";
  if (c.row === "order" && PRICE_KINDS.has(c.kind)) return "price";
  if (c.row === "order" && QTY_KINDS.has(c.kind)) return "quantity";
  return "other";
}

function countLabel(n: number) {
  return n > 0 ? ` (${n})` : "";
}

/** Sign-off Pending desk: Send-off / Price error / Quantity error schede. */
export function SignoffView() {
  const [cases, setCases] = useState<Signoff[]>([]);
  const [tab, setTab] = useState<DeskTab>("sendoff");
  const [selected, setSelected] = useState<string>();
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string>();

  const load = useCallback(() => {
    fetch("/api/signoffs?all=1")
      .then((r) => r.json())
      .then((d) => setCases(d.all ?? d.pending ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const pending = useMemo(() => cases.filter((c) => c.status === "pending"), [cases]);
  const sendoff = useMemo(() => pending.filter((c) => tabFor(c) === "sendoff"), [pending]);
  const price = useMemo(() => pending.filter((c) => tabFor(c) === "price"), [pending]);
  const quantity = useMemo(() => pending.filter((c) => tabFor(c) === "quantity"), [pending]);
  const other = useMemo(() => pending.filter((c) => tabFor(c) === "other"), [pending]);
  const decided = useMemo(() => cases.filter((c) => c.status !== "pending"), [cases]);

  const rows = useMemo(() => {
    if (tab === "sendoff") return sendoff;
    if (tab === "price") return price;
    if (tab === "quantity") return quantity;
    if (tab === "other") return other;
    return decided;
  }, [tab, sendoff, price, quantity, other, decided]);

  const current = cases.find((c) => c.caseId === selected && rows.some((r) => r.caseId === c.caseId)) ?? rows[0];

  useEffect(() => {
    if (selected && !rows.some((r) => r.caseId === selected)) setSelected(undefined);
  }, [rows, selected]);

  const sendOffOne = async (caseId: string, signer: string, why: string) => {
    const res = await fetch(`/api/signoffs/${encodeURIComponent(caseId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true, by: signer, reason: why }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Failed ${caseId} (${res.status})`);
    return data;
  };

  const sendOffAll = async () => {
    const signer = by.trim();
    const why = reason.trim() || "Send-off all: checks already passed; release ORDRSP batch";
    if (!signer) {
      setBulkMsg("Enter your name before Send-off all.");
      return;
    }
    setBulkBusy(true);
    setBulkMsg(undefined);
    try {
      localStorage.setItem("brc:signer", signer);
    } catch {
      /* ignore */
    }
    let ok = 0;
    const errors: string[] = [];
    for (const c of sendoff) {
      try {
        await sendOffOne(c.caseId, signer, why);
        ok += 1;
      } catch (err) {
        errors.push(`${c.caseId}: ${(err as Error).message}`);
      }
    }
    setBulkBusy(false);
    setBulkMsg(
      errors.length
        ? `Sent off ${ok}/${sendoff.length}. Issues: ${errors.slice(0, 3).join("; ")}`
        : `Sent off all ${ok} orders.`,
    );
    load();
  };

  const emptyCopy =
    tab === "sendoff"
      ? "No orders waiting to send off."
      : tab === "price"
        ? "No price errors waiting."
        : tab === "quantity"
          ? "No quantity errors waiting."
          : tab === "other"
            ? "No other cases waiting."
            : "No decisions yet.";

  return (
    <Page>
      <PageHeader
        title="Sign-off Pending"
        sub="Schede by gate: Send-off (confirm ORDRSP), Price error, Quantity error. Resolve one by one, or send off every ready order in one go."
      >
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "sendoff", label: `Send-off${countLabel(sendoff.length)}` },
            { value: "price", label: `Price error${countLabel(price.length)}` },
            { value: "quantity", label: `Quantity error${countLabel(quantity.length)}` },
            ...(other.length ? [{ value: "other" as const, label: `Other${countLabel(other.length)}` }] : []),
            { value: "decided", label: `Decided${countLabel(decided.length)}` },
          ]}
        />
      </PageHeader>

      {tab === "sendoff" ? (
        <Panel
          title="Send-off"
          aside={`${sendoff.length} ready for ORDRSP`}
          className="mb-5"
        >
          <p className="mb-3 text-[13px] text-ink-78">
            These orders already passed parse, stock and price. Confirm one by one, or <b>Send-off all</b> to release
            every ORDRSP in this scheda.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <input
              className="h-9 w-[160px] rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="Your name"
              value={by}
              onChange={(e) => setBy(e.target.value)}
            />
            <input
              className="h-9 min-w-[220px] flex-1 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="Reason for Send-off all (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              disabled={bulkBusy || sendoff.length === 0 || !by.trim()}
              onClick={() => void sendOffAll()}
              className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
            >
              {bulkBusy ? "Sending off…" : `Send-off all (${sendoff.length})`}
            </button>
          </div>
          {bulkMsg ? <p className="mt-2 text-[12.5px] text-ink-78">{bulkMsg}</p> : null}
        </Panel>
      ) : null}

      {tab === "price" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Price does not match the contract. Open a case: paste a corrected ORDERS or park as pending (no ORDRSP while
          blocked).
        </p>
      ) : null}
      {tab === "quantity" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Stock is short. Open a case: <b>Split available qty</b> (continue toward ORDRSP) or <b>Mail &amp; park</b> (no
          ORDRSP while blocked).
        </p>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Panel title={tab === "sendoff" ? "Ready to send off" : tab === "price" ? "Price errors" : tab === "quantity" ? "Quantity errors" : tab === "other" ? "Other" : "Decided"}>
          <DataTable
            rows={rows}
            rowKey={(c) => c.caseId}
            selectedKey={current?.caseId}
            onRowClick={(c) => setSelected(c.caseId)}
            empty={emptyCopy}
            columns={[
              { key: "id", header: "Case", main: true, cell: (c) => c.caseId },
              {
                key: "about",
                header: "About",
                cell: (c) => (
                  <span className="inline-flex max-w-[230px] flex-col align-middle leading-tight">
                    <span className="truncate">{c.title ?? c.kind}</span>
                    <span className="text-[11px] text-ink-68">
                      {c.subjectRef ?? c.row} · {day(c.createdAt)}
                    </span>
                  </span>
                ),
              },
              { key: "kind", header: "Gate", cell: (c) => c.kind.replace(/_/g, " ") },
              { key: "status", header: "Status", cell: (c) => <SignoffStatus status={c.status} /> },
            ]}
          />
        </Panel>
        {current ? (
          <SignoffCard
            key={current.caseId}
            signoff={current}
            onDecided={load}
            confirmLabel={tab === "sendoff" ? "Send off" : undefined}
          />
        ) : null}
      </div>
    </Page>
  );
}
