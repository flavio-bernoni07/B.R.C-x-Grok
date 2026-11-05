"use client";

import type { Signoff } from "@agent/lib/core/erp";
import { actionsCaseHref, deskTabForSignoff, type DeskTab as CoreDeskTab } from "@agent/lib/core/actions-desk";
import type { OrderBoardRow } from "@agent/lib/order/board";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { sendOffAllAction } from "@/app/(app)/actions/actions";
import { DataTable, PageHeader, Panel, Pill, day, qty } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";
import { cn } from "@/lib/utils";
import { Page } from "@/components/shell/app-shell";
import { SignoffCard, SignoffStatus, signoffUsedGrokbot } from "./signoff";

/** Desk tabs: board + gates + Pending (mail/hold) + Decided (true close). */
export type DeskTab = CoreDeskTab;

const DESK_TABS = new Set<DeskTab>(["board", "sendoff", "price", "quantity", "pending", "other", "decided"]);

function isOpenCase(c: Signoff) {
  return c.status === "pending" && !c.decidedAt;
}

function isPendingCase(c: Signoff) {
  return (c.status === "pending" && !!c.decidedAt) || c.status === "parked";
}

function tabFor(c: Signoff): Exclude<DeskTab, "board"> {
  return deskTabForSignoff(c);
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

function tabForBoardStage(stage: string): DeskTab {
  if (stage === "signoff_price") return "price";
  if (stage === "signoff_qty") return "quantity";
  if (stage === "signoff_sendoff") return "sendoff";
  if (stage === "signoff_edi") return "other";
  if (stage === "pending" || stage === "parked") return "pending";
  if (stage === "rejected") return "decided";
  return "board";
}

function actionsHref(tab: DeskTab, caseId?: string) {
  if (caseId) return actionsCaseHref(caseId, tab);
  const q = new URLSearchParams();
  if (tab !== "board") q.set("tab", tab);
  const s = q.toString();
  return s ? `/actions?${s}` : "/actions";
}

/** Plain <a> tabs — full page load so ?tab= SSR sticks without next/link hydration. */
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
        <a
          key={o.value}
          href={actionsHref(o.value)}
          className={cn(
            "inline-flex h-[26px] items-center rounded-full px-3 text-[13px] transition-colors",
            o.value === tab ? "bg-hh-dark font-bold text-hh-window" : "text-ink-68 hover:text-ink",
          )}
        >
          {o.label}
        </a>
      ))}
    </div>
  );
}

function SendOffAllSubmit({ count }: { readonly count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
    >
      {pending ? "Sending off…" : `Send-off all (${count})`}
    </button>
  );
}

/** Actions desk: Board + Send-off / Price / Quantity / Pending / Decided schede. */
export function SignoffView({
  initialCases,
  initialBoard,
  simBanner,
  initialTab = "board",
  initialCaseId,
  openMail = false,
  formError,
}: {
  readonly initialCases?: Signoff[];
  readonly initialBoard?: OrderBoardRow[];
  readonly simBanner?: string;
  readonly initialTab?: DeskTab;
  readonly initialCaseId?: string;
  readonly openMail?: boolean;
  readonly formError?: string;
} = {}) {
  const [cases, setCases] = useState<Signoff[]>(() => initialCases ?? []);
  const [board, setBoard] = useState<OrderBoardRow[]>(() => initialBoard ?? []);
  // Prefer live URL so opening a case works even if soft-nav skips a full RSC remount.
  const params = useSearchParams();
  const tabRaw = params.get("tab");
  const tab: DeskTab =
    tabRaw && DESK_TABS.has(tabRaw as DeskTab) ? (tabRaw as DeskTab) : (initialTab ?? "board");
  const selected = params.get("case") ?? initialCaseId;
  const [byDefault, setByDefault] = useState("");

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
      setByDefault(localStorage.getItem("brc:signer") ?? "");
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
        title="Sign-off"
      >
        <DeskTabs tab={tab} options={tabOptions} />
      </PageHeader>

      {simBanner ? (
        <p className="mb-3 rounded-[10px] bg-st-ok px-3 py-2 text-[13px] text-st-ok-ink">{simBanner}</p>
      ) : null}
      {formError && !current ? <p className="mb-3 text-[12px] text-st-wrong">{formError}</p> : null}

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
                cell: (r) => {
                  const href = r.caseId
                    ? actionsHref(tabForBoardStage(r.stage), r.caseId)
                    : r.stage === "pending"
                      ? actionsHref("pending")
                      : undefined;
                  const inner = (
                    <span className="inline-flex items-center gap-1.5">
                      {r.grokUsed ? <GrokbotIcon size={14} title="Grokbot worked on this order" /> : null}
                      <span>{r.orderRef}</span>
                    </span>
                  );
                  return href ? (
                    <a href={href} className="hover:underline">
                      {inner}
                    </a>
                  ) : (
                    inner
                  );
                },
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
          <form action={sendOffAllAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="caseIds" value={sendoff.map((c) => c.caseId).join(",")} />
            <input
              className="h-9 w-[160px] rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="Your name"
              name="by"
              required
              defaultValue={byDefault}
            />
            <input
              className="h-9 min-w-[220px] flex-1 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="Reason for Send-off all (optional)"
              name="reason"
            />
            <SendOffAllSubmit count={sendoff.length} />
          </form>
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
        <div
          className={
            current
              ? "mt-1 grid items-start gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]"
              : "mt-1 grid gap-5"
          }
        >
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
                    <a
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
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {current ? (
            <Panel
              title={
                <span className="inline-flex items-center gap-2">
                  {signoffUsedGrokbot(current) ? <GrokbotIcon size={16} title="Grokbot worked on this case" /> : null}
                  {current.title ?? current.kind}
                </span>
              }
              aside={
                <a
                  href={actionsHref(tab === "board" ? tabFor(current) : tab)}
                  className="text-[13px] text-ink-68 hover:text-ink"
                >
                  Close
                </a>
              }
              className="lg:sticky lg:top-0"
            >
              <p className="mb-3 text-[12px] text-ink-68">
                {current.caseId} · {current.subjectRef ?? current.row}
              </p>
              <SignoffCard
                key={`${current.caseId}-${openMail ? "mail" : "card"}`}
                signoff={current}
                confirmLabel={current.kind === "confirm" ? "Send off" : undefined}
                embedded
                returnTab={tab === "board" ? tabFor(current) : tab}
                initialCompose={openMail}
                formError={formError}
              />
            </Panel>
          ) : null}
        </div>
      ) : null}

      {tab === "board" && current ? (
        <Panel
          title={
            <span className="inline-flex items-center gap-2">
              {signoffUsedGrokbot(current) ? <GrokbotIcon size={16} title="Grokbot worked on this case" /> : null}
              {current.title ?? current.kind}
            </span>
          }
          aside={
            <a href={actionsHref(tabFor(current))} className="text-[13px] text-ink-68 hover:text-ink">
              Close
            </a>
          }
          className="mt-5"
        >
          <p className="mb-3 text-[12px] text-ink-68">
            {current.caseId} · {current.subjectRef ?? current.row}
          </p>
          <SignoffCard
            key={`${current.caseId}-${openMail ? "mail" : "card"}`}
            signoff={current}
            confirmLabel={current.kind === "confirm" ? "Send off" : undefined}
            embedded
            returnTab={tabFor(current)}
            initialCompose={openMail}
            formError={formError}
          />
        </Panel>
      ) : null}
    </Page>
  );
}
