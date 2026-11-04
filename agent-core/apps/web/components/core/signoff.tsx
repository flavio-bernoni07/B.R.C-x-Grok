"use client";

/**
 * The one sign-off desk for every row (core/signoff). A person approves or rejects and must write
 * one line on why; the row's own decision path then runs (order confirms, shipping executes the
 * resolution, dispute writes the outcome). The agent shows these cards; it never decides.
 */
import type { Signoff } from "@agent/lib/core/erp";
import { useEffect, useMemo, useState } from "react";
import { Facts, Panel, Pill, type PillTone, SourceTag, day } from "@/components/kit";
import { cn } from "@/lib/utils";
import { MailCompose } from "./mail-compose";

const ROW_LABEL: Record<string, string> = { order: "Order", shipping: "Shipping", dispute: "Dispute" };

const EDI_KEYS = new Set(["draft_ordrsp", "ordrsp", "edi", "corrected_edi", "manual_edi"]);
const HIDDEN_KEYS = new Set(["_dir", "_path", "draft_mail", "options", "grokbot"]);

export function signoffTone(status: string): PillTone {
  return status === "pending" ? "attention" : status === "approved" ? "ok" : "wait";
}

export function SignoffStatus({ status }: { readonly status: string }) {
  const label = status === "pending" ? "Needs a person" : status === "approved" ? "Approved" : "Rejected";
  return <Pill tone={signoffTone(status)}>{label}</Pill>;
}

const EdiBox = ({ title, text }: { readonly title: string; readonly text: string }) => (
  <div className="overflow-hidden rounded-[12px] border border-[rgb(32_49_25/0.12)] bg-hh-honeydew">
    <div className="border-[rgb(32_49_25/0.08)] border-b px-3 py-1.5 font-bold text-[12px] text-ink-78">{title}</div>
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11.5px] text-ink-78 leading-relaxed">
      {text.replace(/'(?!$)/g, "'\n")}
    </pre>
  </div>
);

/** Shows the proposal as readable lines; EDI drafts get their own scroll box. */
function Proposal({ proposal }: { readonly proposal: Record<string, unknown> | null }) {
  if (!proposal || !Object.keys(proposal).length) return null;
  const shown = Object.entries(proposal).filter(([k]) => !HIDDEN_KEYS.has(k) && !/_dir$|_path$/.test(k));
  const ediEntries = shown.filter(([k, v]) => EDI_KEYS.has(k) || (typeof v === "string" && v.includes("UNA:") && v.length > 80));
  const ediKeys = new Set(ediEntries.map(([k]) => k));
  const simple = shown.filter(([k, v]) => !ediKeys.has(k) && (v == null || typeof v !== "object"));
  const nested = shown.filter(([k, v]) => !ediKeys.has(k) && v != null && typeof v === "object");
  return (
    <div className="space-y-3">
      {simple.length ? <Facts items={simple.map(([k, v]) => [k.replace(/_/g, " "), String(v ?? "–")])} /> : null}
      {ediEntries.map(([k, v]) => (
        <EdiBox key={k} title={k === "draft_ordrsp" ? "Draft ORDRSP" : k.replace(/_/g, " ")} text={String(v)} />
      ))}
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

function defaultMailTo(signoff: Signoff): string {
  const buyer = (signoff.proposal?.buyer_name || signoff.proposal?.buyer || signoff.proposal?.retailer) as string | undefined;
  if (buyer && typeof buyer === "string") {
    const slug = buyer
      .toLowerCase()
      .replace(/\(demo\)/g, "")
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "");
    if (slug) return `orders@${slug}.example`;
  }
  return "buyer@retailer.example";
}

export function SignoffCard({
  signoff,
  onDecided,
  confirmLabel,
  embedded = false,
}: {
  readonly signoff: Signoff;
  readonly onDecided?: (result: unknown) => void;
  /** Override the primary approve label (e.g. Send-off on the confirm scheda). */
  readonly confirmLabel?: string;
  /** When true, omit the outer Panel chrome (used inside DeskModal). */
  readonly embedded?: boolean;
}) {
  const [c, setC] = useState(signoff);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [manualEdi, setManualEdi] = useState("");
  const takesEdi = c.row === "order" && (c.kind === "price_fix" || c.kind === "manual_edi");
  const qtyChoice = c.row === "order" && c.kind === "qty_choice";
  const priceCase = c.row === "order" && (c.kind === "price_fix" || c.kind === "manual_edi");
  const draftMail = useMemo(() => {
    const fromProposal = c.proposal?.draft_mail;
    return typeof fromProposal === "string" ? fromProposal : "";
  }, [c.proposal]);
  const [composeMail, setComposeMail] = useState(false);
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

  useEffect(() => {
    setC(signoff);
    setResult(undefined);
    setError(undefined);
    setComposeMail(false);
    setManualEdi("");
  }, [signoff.caseId]);

  const decide = async (approve: boolean, edits?: Record<string, unknown>, reasonOverride?: string) => {
    const why = (reasonOverride ?? reason).trim();
    if (!by.trim() || !why) {
      setError("Enter your name and one line on why.");
      return;
    }
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
      body: JSON.stringify({ approve, by, reason: why, edits: payloadEdits }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? `Failed (${res.status})`);
    if (data.case) setC(data.case);
    setResult(data.result);
    setComposeMail(false);
    onDecided?.(data);
  };

  const open = c.status === "pending";
  const sendOffLabel = confirmLabel ?? (c.kind === "confirm" ? "Send off" : "Approve");

  if (composeMail && open) {
    const mailUi = (
      <MailCompose
        title={`Mail · ${c.subjectRef ?? c.caseId}`}
        defaultTo={defaultMailTo(c)}
        draft={draftMail}
        busy={busy}
        error={error}
        inline={embedded}
        onCancel={() => setComposeMail(false)}
        onSend={(mail) => {
          const why = reason.trim() || `Sent availability mail to ${mail.to}`;
          setReason(why);
          void decide(
            true,
            {
              qty_action: qtyChoice ? "mail" : undefined,
              send_mail: priceCase ? true : undefined,
              draft_mail: mail.full,
              mail_to: mail.to,
            },
            why,
          );
        }}
      />
    );
    if (embedded) return mailUi;
    return (
      <Panel title={<span className="flex items-center gap-2">{c.title ?? c.kind}</span>} aside={<SignoffStatus status={c.status} />}>
        {mailUi}
      </Panel>
    );
  }

  const body = (
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
              Split continues toward ORDRSP for the available quantity only. Mail opens a compose window — no ORDRSP while
              blocked.
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
                  disabled={busy || !by.trim() || !reason.trim() || !draftMail}
                  onClick={() => setComposeMail(true)}
                  className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
                >
                  Mail…
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy || !by.trim() || !reason.trim()}
                onClick={() => void decide(true)}
                className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
              >
                {sendOffLabel}
              </button>
            )}
            {priceCase && draftMail ? (
              <button
                type="button"
                disabled={busy || !by.trim() || !reason.trim()}
                onClick={() => setComposeMail(true)}
                className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
              >
                Mail &amp; park…
              </button>
            ) : null}
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
          {typeof result.shipping_ref === "string" ? (
            <p className="mt-2 rounded-[10px] bg-[#e8f2dc] px-3 py-2 text-[13px] text-ink">
              Sent to Shipping as <b>{String(result.shipping_ref)}</b> (ready to ship).
            </p>
          ) : null}
          <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] text-ink-78">
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      ) : null}

    </div>
  );

  if (embedded) return body;

  return (
    <Panel
      title={<span className="flex items-center gap-2">{c.title ?? c.kind}</span>}
      aside={
        <span className="flex items-center gap-2">
          <SourceTag>{c.caseId}</SourceTag>
          <span>{ROW_LABEL[c.row] ?? c.row}</span>
          <SignoffStatus status={c.status} />
        </span>
      }
    >
      {body}
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
