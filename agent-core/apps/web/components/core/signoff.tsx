"use client";

/**
 * The one sign-off desk for every row (core/signoff). A person approves or rejects and must write
 * one line on why; the row's own decision path then runs (order confirms, shipping executes the
 * resolution, dispute writes the outcome). The agent shows these cards; it never decides.
 */
import type { Signoff } from "@agent/lib/core/erp";
import { useEffect, useState } from "react";
import { Facts, Panel, Pill, type PillTone, SourceTag, day } from "@/components/kit";
import { cn } from "@/lib/utils";

const ROW_LABEL: Record<string, string> = { order: "Order", shipping: "Shipping", dispute: "Dispute" };

export function signoffTone(status: string): PillTone {
  return status === "pending" ? "attention" : status === "approved" ? "ok" : "wait";
}

export function SignoffStatus({ status }: { readonly status: string }) {
  const label = status === "pending" ? "Needs a person" : status === "approved" ? "Approved" : "Rejected";
  return <Pill tone={signoffTone(status)}>{label}</Pill>;
}

/** Shows the proposal as readable lines; nested JSON is folded. */
function Proposal({ proposal }: { readonly proposal: Record<string, unknown> | null }) {
  if (!proposal || !Object.keys(proposal).length) return null;
  // File locations are for code, not for the person deciding.
  const shown = Object.entries(proposal).filter(([k]) => !/(_dir|_path)$/.test(k));
  const simple = shown.filter(([, v]) => v == null || typeof v !== "object");
  const nested = shown.filter(([, v]) => v != null && typeof v === "object");
  return (
    <div className="space-y-2">
      {simple.length ? <Facts items={simple.map(([k, v]) => [k.replace(/_/g, " "), String(v ?? "–")])} /> : null}
      {nested.length ? (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none text-ink-68">Proposal details</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] leading-relaxed text-ink-78">
            {JSON.stringify(Object.fromEntries(nested), null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function SignoffCard({
  signoff,
  onDecided,
  confirmLabel,
}: {
  readonly signoff: Signoff;
  readonly onDecided?: (result: unknown) => void;
  /** Override the primary approve label (e.g. Send-off on the confirm scheda). */
  readonly confirmLabel?: string;
}) {
  const [c, setC] = useState(signoff);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [manualEdi, setManualEdi] = useState("");
  // Order price cases: the person can paste the corrected EDI; it goes back to Parse (DECISIONS.md, Order).
  const takesEdi = c.row === "order" && (c.kind === "price_fix" || c.kind === "manual_edi");
  const qtyChoice = c.row === "order" && c.kind === "qty_choice";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Record<string, unknown>>();

  useEffect(() => {
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const decide = async (approve: boolean, edits?: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      localStorage.setItem("brc:signer", by);
    } catch {
      /* ignore */
    }
    const payloadEdits = edits ?? (takesEdi && manualEdi.trim() ? { manual_edi: manualEdi } : undefined);
    const res = await fetch(`/api/signoffs/${encodeURIComponent(c.caseId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve, by, reason, edits: payloadEdits }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? `Failed (${res.status})`);
    if (data.case) setC(data.case);
    setResult(data.result);
    onDecided?.(data);
  };

  const open = c.status === "pending";
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {c.title ?? c.kind}
        </span>
      }
      aside={
        <span className="flex items-center gap-2">
          <SourceTag>{c.caseId}</SourceTag>
          <span>{ROW_LABEL[c.row] ?? c.row}</span>
          <SignoffStatus status={c.status} />
        </span>
      }
    >
      <div className="space-y-3 text-[13px]">
        {c.subjectRef ? (
          <p className="text-ink-68">
            About <b className="text-ink">{c.subjectRef}</b> · asked {day(c.createdAt)}
          </p>
        ) : null}
        {c.reasons?.length ? (
          <div>
            <div className="mb-1 text-[12px] text-ink-68">Why a person is asked</div>
            <ul className="list-disc space-y-0.5 pl-5">
              {c.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <Proposal proposal={c.proposal} />

        {open ? (
          <div className="space-y-2 rounded-[12px] bg-hh-honeydew p-3">
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <input
                className="h-9 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
                placeholder="Your name"
                value={by}
                onChange={(e) => setBy(e.target.value)}
              />
              <input
                className="h-9 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
                placeholder="One line on why (the Playbook learns from it)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {takesEdi ? (
              <textarea
                className="h-24 w-full rounded-lg border bg-hh-seasalt p-2 font-mono text-[11px] outline-none focus:border-hh-asparagus"
                placeholder="Optional: paste the corrected ORDERS EDI. Approving without it parks the order as pending until a new ORDERS arrives."
                value={manualEdi}
                onChange={(e) => setManualEdi(e.target.value)}
              />
            ) : null}
            {qtyChoice ? (
              <p className="text-[12px] text-ink-68">
                Split continues toward ORDRSP for the available quantity only. Mail parks the order with the draft — no ORDRSP while blocked.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {qtyChoice ? (
                <>
                  <button
                    type="button"
                    disabled={busy || !by.trim() || !reason.trim()}
                    onClick={() => void decide(true, { qty_action: "split" })}
                    className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
                  >
                    Split available qty
                  </button>
                  <button
                    type="button"
                    disabled={busy || !by.trim() || !reason.trim()}
                    onClick={() => void decide(true, { qty_action: "mail" })}
                    className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
                  >
                    Mail &amp; park
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy || !by.trim() || !reason.trim()}
                  onClick={() => void decide(true)}
                  className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
                >
                  {confirmLabel ?? (c.kind === "confirm" ? "Send off" : "Approve")}
                </button>
              )}
              <button
                type="button"
                disabled={busy || !by.trim() || !reason.trim()}
                onClick={() => void decide(false)}
                className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
              >
                Reject
              </button>
              {busy ? <span className="text-[12px] text-ink-68">Running the decision…</span> : null}
              {error ? <span className="text-[12px] text-st-wrong">{error}</span> : null}
            </div>
          </div>
        ) : (
          <p className="text-ink-78">
            {c.status === "approved" ? "Approved" : "Rejected"} by <b>{c.decidedBy}</b>
            {c.decisionReason ? `: “${c.decisionReason}”` : ""} {c.decidedAt ? `· ${day(c.decidedAt)}` : ""}
          </p>
        )}
        {result ? (
          <details className="text-[12px]" open>
            <summary className="cursor-pointer select-none text-ink-68">What ran after the decision</summary>
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] text-ink-78">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

/** Compact queue list; opening a case shows its card. Used on Overview and as the chat card. */
export function SignoffQueue({ cases, compact = false }: { readonly cases: Signoff[]; readonly compact?: boolean }) {
  const [openId, setOpenId] = useState<string>();
  if (!cases.length) return <p className="py-3 text-[13px] text-ink-68">Nothing is waiting for a person.</p>;
  return (
    <ul className="divide-y divide-[var(--color-hairline)]">
      {cases.map((c) => (
        <li key={c.caseId} className="py-2">
          <button
            type="button"
            onClick={() => setOpenId(openId === c.caseId ? undefined : c.caseId)}
            className="flex w-full items-center gap-3 text-left"
          >
            <span className="w-[72px] shrink-0 font-bold text-[13px]">{c.caseId}</span>
            <span className="w-[64px] shrink-0 text-[12px] text-ink-68">{ROW_LABEL[c.row] ?? c.row}</span>
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", compact && "text-ink-78")}>{c.title ?? c.kind}</span>
            <SignoffStatus status={c.status} />
          </button>
          {openId === c.caseId ? (
            <div className="mt-2">
              <SignoffCard signoff={c} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
