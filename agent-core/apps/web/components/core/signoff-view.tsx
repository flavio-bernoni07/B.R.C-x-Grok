"use client";

import type { Signoff } from "@agent/lib/core/erp";
import type { OrderBoardRow } from "@agent/lib/order/board";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, PageHeader, Panel, Pill, day, qty } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";
import { cn } from "@/lib/utils";
import { Page } from "@/components/shell/app-shell";
import { SignoffCard, SignoffStatus, signoffUsedGrokbot } from "./signoff";

/** Desk tabs: board + gates + Pending (mail/hold) + Decided (true close). */
export type DeskTab = "board" | "sendoff" | "price" | "quantity" | "pending" | "other" | "decided";

const SEND_OFF_KINDS = new Set(["confirm"]);
const PRICE_KINDS = new Set(["price_fix"]);
const QTY_KINDS = new Set(["qty_choice", "stock_short"]);

function isOpenCase(c: Signoff) {
  return c.status === "pending" && !c.decidedAt;
}

function isPendingCase(c: Signoff) {
  return (c.status === "pending" && !!c.decidedAt) || c.status === "parked";
}

function tabFor(c: Signoff): Exclude<DeskTab, "decided" | "board" | "pending"> {
  if (!isOpenCase(c)) return "other";
  if (c.row === "order" && SEND_OFF_KINDS.has(c.kind)) return "sendoff";
  if (c.row === "order" && PRICE_KINDS.has(c.kind)) return "price";
  if (c.row === "order" && QTY_KINDS.has(c.kind)) return "quantity";
  return "other";
}

function countLabel(n: number) {
  return n > 0 ? ` (${n})` : "";
}

function stageTone(stage: string): "attention" | "ok" | "wait" | "quiet" | "pending" | "reject" {
  if (stage.startsWith("signoff_")) return "attention";
  if (stage === "pending" || stage === "parked") return "pending";
  if (stage === "rejected") return "reject";
  if (stage === "done" || stage === "shipped") return "ok";
  return "wait";
}

function actionsHref(tab: DeskTab, caseId?: string) {
  const q = new URLSearchParams();
  if (tab !== "board") q.set("tab", tab);
  if (caseId) q.set("case", caseId);
  const s = q.toString();
  return s ? `/actions?${s}` : "/actions";
}

/** Link tabs — work without client JS (full navigation + SSR). */
function DeskTabs({
  tab,
  options,
}: {
  readonly tab: DeskTab;
  readonly options: { value: DeskTab; label: string }[];
}) {
  return (
    <div className="inline-flex h-[34px] flex-wrap items-center gap-0.5 rounded-full bg-white/85 p-1 shadow-[inset_0_1.5px_0.5px_rgb(255_255_255/0.95),inset_0_0_0_1px_rgb(32_49_25/0.07),0_10px_26px_-16px_rgb(32_49_25/0.35),0_2px_6px_rgb(32_49_25/0.06)]">
      {options.map((o) => (
        <Link
          key={o.value}
          href={actionsHref(o.value)}
          className={cn(
            "inline-flex h-[26px] items-center rounded-full px-3 text-[13px] transition-colors",
            o.value === tab ? "bg-hh-dark font-bold text-hh-window" : "text-ink-68 hover:text-ink",
          )}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

/** Actions desk: Board + Send-off / Price / Quantity schede. */
export function SignoffView({
  initialCases,
  initialBoard,
  simBanner,
  initialTab = "board",
  initialCaseId,
}: {
  readonly initialCases?: Signoff[];
  readonly initialBoard?: OrderBoardRow[];
  readonly simBanner?: string;
  readonly initialTab?: DeskTab;
  readonly initialCaseId?: string;
} = {}) {
  /** SSR seeds the desk so simulation results show even when client fetch/HMR is flaky. */
  const [cases, setCases] = useState<Signoff[]>(() => initialCases ?? []);
  const [board, setBoard] = useState<OrderBoardRow[]>(() => initialBoard ?? []);
  const tab = initialTab;
  const selected = initialCaseId;
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
    if (initialCases) setCases(initialCases);
  }, [initialCases]);
  useEffect(() => {
    if (initialBoard) setBoard(initialBoard);
  }, [initialBoard]);

  useEffect(() => {
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const waiting = useMemo(() => cases.filter(isOpenCase), [cases]);
  const sendoff = useMemo(() => waiting.filter((c) => tabFor(c) === "sendoff"), [waiting]);
  const price = useMemo(() => waiting.filter((c) => tabFor(c) === "price"), [waiting]);
  const quantity = useMemo(() => waiting.filter((c) => tabFor(c) === "quantity"), [waiting]);
  const other = useMemo(() => waiting.filter((c) => tabFor(c) === "other"), [waiting]);
  const pendingHold = useMemo(() => cases.filter(isPendingCase), [cases]);
  const decided = useMemo(() => cases.filter((c) => c.status === "approved" || c.status === "rejected"), [cases]);

  const rows = useMemo(() => {
    if (tab === "sendoff") return sendoff;
    if (tab === "price") return price;
    if (tab === "quantity") return quantity;
    if (tab === "pending") return pendingHold;
    if (tab === "other") return other;
    if (tab === "decided") return decided;
    return [];
  }, [tab, sendoff, price, quantity, pendingHold, other, decided]);

  const current = cases.find((c) => c.caseId === selected) ?? null;

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
            ? "No Pending orders waiting on the retailer."
            : tab === "other"
              ? "No other cases waiting."
              : "No decisions yet.";

  const onCaseDecided = () => {
    load();
    // Full navigation clears ?case= even if client router is flaky.
    window.location.href = actionsHref(tab);
  };

  const tabOptions: { value: DeskTab; label: string }[] = [
    { value: "board", label: `Board${countLabel(board.length)}` },
    { value: "sendoff", label: `Send-off${countLabel(sendoff.length)}` },
    { value: "price", label: `Price error${countLabel(price.length)}` },
    { value: "quantity", label: `Quantity error${countLabel(quantity.length)}` },
    { value: "pending", label: `Pending${countLabel(pendingHold.length)}` },
    ...(other.length ? [{ value: "other" as const, label: `Other${countLabel(other.length)}` }] : []),
    { value: "decided", label: `Decided${countLabel(decided.length)}` },
  ];

  return (
    <Page>
      <PageHeader
        title="Actions"
        sub="Board shows every order’s stage. After a price/qty mail the case moves to Pending (not Decided). Send-off all releases every ready ORDRSP."
      >
        <DeskTabs tab={tab} options={tabOptions} />
      </PageHeader>

      {simBanner ? (
        <p className="mb-3 rounded-[10px] bg-st-ok px-3 py-2 text-[13px] text-st-ok-ink">{simBanner}</p>
      ) : null}
      {bulkMsg ? <p className="mb-3 text-[12.5px] text-ink-78">{bulkMsg}</p> : null}

      {tab === "board" ? (
        <Panel title="Order board" aside={`${board.length} orders`}>
          <p className="mb-3 text-[13px] text-ink-78">
            Pipeline for every order: sign-off gates, Pending, assigned to shipping, sent to WMS, preparing, shipped, done.
          </p>
          <DataTable
            rows={board}
            rowKey={(r) => r.orderRef}
            empty="No orders on the desk yet. Run the order simulation from Orders."
            columns={[
              {
                key: "order",
                header: "Order",
                main: true,
                cell: (r) => (
                  <span className="inline-flex items-center gap-1.5">
                    {r.grokUsed ? <GrokbotIcon size={14} title="Grokbot worked on this order" /> : null}
                    <span>{r.orderRef}</span>
                  </span>
                ),
              },
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
              name="by"
            />
            <input
              className="h-9 min-w-[220px] flex-1 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="Reason for Send-off all (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              name="reason"
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
        </Panel>
      ) : null}

      {tab === "price" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Price does not match the contract. Open a case: paste a corrected ORDERS, send the price mail, or leave as
          Pending (no ORDRSP while blocked).
        </p>
      ) : null}
      {tab === "quantity" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Stock is short. Open a case and choose: <b>Split</b> (ship available now, remainder as a later order) or{" "}
          <b>Email &amp; Pending</b> (mail the retailer, order stays Pending — no ORDRSP).
        </p>
      ) : null}
      {tab === "pending" ? (
        <p className="mb-3 text-[13px] text-ink-78">
          Mail sent or held as Pending: waiting on the retailer (or a new ORDERS). These are not closed decisions — they
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
                    ? "Pending"
                    : tab === "other"
                      ? "Other"
                      : "Decided"
          }
        >
          {rows.length === 0 ? (
            <p className="py-6 text-center text-[14px] text-ink-68">{emptyCopy}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-hairline)]">
              {rows.map((c) => (
                <li key={c.caseId}>
                  <Link
                    href={actionsHref(tab, c.caseId)}
                    className={cn(
                      "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 px-1 py-2.5 transition-colors hover:bg-hh-honeydew/60",
                      selected === c.caseId ? "bg-hh-honeydew" : "",
                    )}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[14px]">
                      {signoffUsedGrokbot(c) ? <GrokbotIcon size={14} title="Grokbot worked on this case" /> : null}
                      <b className="tracking-[-0.02em]">{c.caseId}</b>
                      <span className="truncate text-ink-68">{c.title ?? c.kind}</span>
                    </span>
                    <span className="justify-self-end">
                      <SignoffStatus status={c.status} decidedAt={c.decidedAt} />
                    </span>
                    <span className="truncate text-[12px] text-ink-68">
                      {c.subjectRef ?? c.row} · {c.kind.replace(/_/g, " ")} · {day(c.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      {current && tab !== "board" ? (
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              {signoffUsedGrokbot(current) ? <GrokbotIcon size={16} title="Grokbot worked on this case" /> : null}
              {current.title ?? current.kind}
            </span>
          }
          aside={
            <Link href={actionsHref(tab)} className="text-[13px] text-ink-68 hover:text-ink">
              Close
            </Link>
          }
          className="mt-5"
        >
          <p className="mb-3 text-[12px] text-ink-68">
            {current.caseId} · {current.subjectRef ?? current.row}
          </p>
          <SignoffCard
            key={current.caseId}
            signoff={current}
            onDecided={onCaseDecided}
            confirmLabel={current.kind === "confirm" ? "Send off" : undefined}
            embedded
          />
        </Panel>
      ) : null}
    </Page>
  );
}
