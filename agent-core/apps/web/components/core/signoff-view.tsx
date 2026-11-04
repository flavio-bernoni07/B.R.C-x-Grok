"use client";

import type { Signoff } from "@agent/lib/core/erp";
import type { OrderBoardRow } from "@agent/lib/order/board";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, PageHeader, Panel, Pill, Segmented, day, qty } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { DeskModal } from "./desk-modal";
import { SignoffCard, SignoffStatus } from "./signoff";

/** Desk tabs: board + gates + Pending (mail/park) + Decided (true close). */
type DeskTab = "board" | "sendoff" | "price" | "quantity" | "pending" | "other" | "decided";

const SEND_OFF_KINDS = new Set(["confirm"]);
const PRICE_KINDS = new Set(["price_fix"]);
const QTY_KINDS = new Set(["qty_choice", "stock_short"]);

function tabFor(c: Signoff): Exclude<DeskTab, "decided" | "board" | "pending"> {
  if (c.status !== "pending") return "other";
  if (c.row === "order" && SEND_OFF_KINDS.has(c.kind)) return "sendoff";
  if (c.row === "order" && PRICE_KINDS.has(c.kind)) return "price";
  if (c.row === "order" && QTY_KINDS.has(c.kind)) return "quantity";
  return "other";
}

function countLabel(n: number) {
  return n > 0 ? ` (${n})` : "";
}

function stageTone(stage: string): "attention" | "ok" | "wait" | "quiet" {
  if (stage.startsWith("signoff_")) return "attention";
  if (stage === "parked" || stage === "rejected") return "quiet";
  if (stage === "done" || stage === "shipped") return "ok";
  return "wait";
}

/** Actions desk: Board + Send-off / Price / Quantity schede. */
export function SignoffView() {
  const [cases, setCases] = useState<Signoff[]>([]);
  const [board, setBoard] = useState<OrderBoardRow[]>([]);
  const [tab, setTab] = useState<DeskTab>("board");
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
    fetch("/api/orders/board")
      .then((r) => r.json())
      .then((d: { rows?: OrderBoardRow[] }) => setBoard(d.rows ?? []))
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

  const waiting = useMemo(() => cases.filter((c) => c.status === "pending"), [cases]);
  const sendoff = useMemo(() => waiting.filter((c) => tabFor(c) === "sendoff"), [waiting]);
  const price = useMemo(() => waiting.filter((c) => tabFor(c) === "price"), [waiting]);
  const quantity = useMemo(() => waiting.filter((c) => tabFor(c) === "quantity"), [waiting]);
  const other = useMemo(() => waiting.filter((c) => tabFor(c) === "other"), [waiting]);
  /** Mail sent / parked — waiting on the retailer, not a closed decision. */
  const parked = useMemo(() => cases.filter((c) => c.status === "parked"), [cases]);
  const decided = useMemo(() => cases.filter((c) => c.status === "approved" || c.status === "rejected"), [cases]);

  const rows = useMemo(() => {
    if (tab === "sendoff") return sendoff;
    if (tab === "price") return price;
    if (tab === "quantity") return quantity;
    if (tab === "pending") return parked;
    if (tab === "other") return other;
    if (tab === "decided") return decided;
    return [];
  }, [tab, sendoff, price, quantity, parked, other, decided]);

  const current = cases.find((c) => c.caseId === selected) ?? null;

  useEffect(() => {
    if (!selected) return;
    const c = cases.find((x) => x.caseId === selected);
    if (!c) {
      setSelected(undefined);
      return;
    }
    if (tab === "pending" && c.status === "parked") return;
    if (tab === "decided" && (c.status === "approved" || c.status === "rejected")) return;
    if (c.status === "pending" && tabFor(c) === tab) return;
    if (c.status !== "pending") setSelected(undefined);
  }, [cases, selected, tab]);

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
    try {
      const res = await fetch("/api/signoffs/send-off-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          by: signer,
          reason: why,
          caseIds: sendoff.map((c) => c.caseId),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBulkMsg(data.error ?? `Send-off all failed (${res.status})`);
      } else {
        const shipped = (data.results as { shipping_ref?: string }[] | undefined)?.filter((r) => r.shipping_ref).length ?? data.ok;
        const failed = data.failed ?? 0;
        setBulkMsg(
          failed
            ? `Sent off ${data.ok}/${(data.results as unknown[]).length} (${shipped} to Shipping). ${failed} need a look.`
            : `Sent off all ${data.ok} orders · ${shipped} now in Shipping.`,
        );
      }
    } catch (err) {
      setBulkMsg((err as Error).message);
    }
    setBulkBusy(false);
    setSelected(undefined);
    try {
      window.dispatchEvent(new Event("brc:changed"));
    } catch {
      /* ignore */
    }
    load();
  };

  const emptyCopy =
    tab === "sendoff"
      ? "No orders waiting to send off."
      : tab === "price"
        ? "No price errors waiting."
        : tab === "quantity"
          ? "No quantity errors waiting."
          : tab === "pending"
            ? "No parked orders waiting on the retailer."
            : tab === "other"
              ? "No other cases waiting."
              : "No decisions yet.";

  const onCaseDecided = () => {
    setSelected(undefined);
    load();
  };

  return (
    <Page>
      <PageHeader
        title="Actions"
        sub="Board shows every order’s stage. After a price/qty mail the case moves to Pending (not Decided). Send-off all releases every ready ORDRSP."
      >
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "board", label: `Board${countLabel(board.length)}` },
            { value: "sendoff", label: `Send-off${countLabel(sendoff.length)}` },
            { value: "price", label: `Price error${countLabel(price.length)}` },
            { value: "quantity", label: `Quantity error${countLabel(quantity.length)}` },
            { value: "pending", label: `Pending${countLabel(parked.length)}` },
            ...(other.length ? [{ value: "other" as const, label: `Other${countLabel(other.length)}` }] : []),
            { value: "decided", label: `Decided${countLabel(decided.length)}` },
          ]}
        />
      </PageHeader>

      {tab === "board" ? (
        <Panel title="Order board" aside={`${board.length} orders`}>
          <p className="mb-3 text-[13px] text-ink-78">
            Pipeline for every order: sign-off gates, parked, assigned to shipping, sent to WMS, preparing, shipped, done.
          </p>
          <DataTable
            rows={board}
            rowKey={(r) => r.orderRef}
            empty="No orders on the desk yet. Run the order simulation from Orders."
            columns={[
              { key: "order", header: "Order", main: true, cell: (r) => r.orderRef },
              { key: "retailer", header: "Retailer", cell: (r) => r.retailer },
              {
                key: "stage",
                header: "Stage",
                cell: (r) => <Pill tone={stageTone(r.stage)}>{r.stageLabel}</Pill>,
              },
              {
                key: "qty",
                header: "Qty",
                align: "right",
                cell: (r) => qty(r.qtyConfirmed ?? r.qtyOrdered),
              },
              {
                key: "detail",
                header: "Detail",
                cell: (r) => (
                  <span className="inline-block max-w-[360px] truncate align-middle" title={r.detail}>
                    {r.detail}
                  </span>
                ),
              },
            ]}
          />
        </Panel>
      ) : null}

      {tab === "sendoff" ? (
        <Panel title="Send-off" aside={`${sendoff.length} ready for ORDRSP`} className="mb-5">
          <p className="mb-3 text-[13px] text-ink-78">
            These orders already passed parse, stock and price. Open one to <b>Send off</b> (goes to Shipping), or{" "}
            <b>Send-off all</b> to release every ORDRSP in this scheda.
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
          Price does not match the contract. Open a case: paste a corrected ORDERS, send the price mail, or park (no
          ORDRSP while blocked).
        </p>
      ) : null}
      {tab === "quantity" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Stock is short. Open a case and choose: <b>Split</b> (ship available now, remainder as a later order) or{" "}
          <b>Email &amp; park</b> (mail the retailer, order stays pending — no ORDRSP).
        </p>
      ) : null}
      {tab === "pending" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Mail sent or order parked: waiting on the retailer (or a new ORDERS). These are not closed decisions — they
          stay here until a new message arrives.
        </p>
      ) : null}

      {tab !== "board" ? (
        <Panel
          title={
            tab === "sendoff"
              ? "Ready to send off"
              : tab === "price"
                ? "Price errors"
                : tab === "quantity"
                  ? "Quantity errors"
                  : tab === "pending"
                    ? "Pending (parked)"
                    : tab === "other"
                      ? "Other"
                      : "Decided"
          }
        >
          <DataTable
            rows={rows}
            rowKey={(c) => c.caseId}
            selectedKey={selected}
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
      ) : null}

      {current && tab !== "board" ? (
        <DeskModal
          title={current.title ?? current.kind}
          aside={`${current.caseId} · ${current.subjectRef ?? current.row}`}
          onClose={() => setSelected(undefined)}
          wide
        >
          <SignoffCard
            key={current.caseId}
            signoff={current}
            onDecided={onCaseDecided}
            confirmLabel={current.kind === "confirm" ? "Send off" : undefined}
            embedded
          />
        </DeskModal>
      ) : null}
    </Page>
  );
}
