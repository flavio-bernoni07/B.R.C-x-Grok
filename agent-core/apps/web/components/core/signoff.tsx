"use client";

/**
 * The one sign-off desk for every row (core/signoff). A person approves or rejects and must write
 * one line on why; the row's own decision path then runs (order confirms, shipping executes the
 * resolution, dispute writes the outcome). The agent shows these cards; it never decides.
 *
 * Decide controls use <form action={serverAction}> so Cursor preview (no client JS) still works.
 */
import type { Signoff } from "@agent/lib/core/erp";
import { actionsCaseHref, deskTabForSignoff } from "@agent/lib/core/actions-desk";
import { useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { decideSignoffAction } from "@/app/(app)/actions/actions";
import { Panel, Pill, type PillTone, SourceTag, day } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";
import { cn } from "@/lib/utils";

const ROW_LABEL: Record<string, string> = { order: "Order", shipping: "Shipping", dispute: "Dispute" };

/** True when Grokbot actually stepped in (parse fix / Grok note), not merely any proposal note. */
export function signoffUsedGrokbot(c: Signoff): boolean {
  const mentions = (s: string) => /Grokbot|\bGrok\b/i.test(s);
  const notes = c.proposal?.grokbot;
  if (Array.isArray(notes) && notes.some((n) => mentions(String(n ?? "")))) return true;
  if (c.reasons?.some((r) => mentions(r))) return true;
  return false;
}

export function signoffTone(status: string, decidedAt?: string | null): PillTone {
  if ((status === "pending" && !!decidedAt) || status === "parked") return "pending";
  if (status === "pending") return "attention";
  if (status === "approved") return "ok";
  if (status === "rejected") return "reject";
  return "wait";
}

export function SignoffStatus({
  status,
  decidedAt,
}: {
  readonly status: string;
  readonly decidedAt?: string | null;
}) {
  const holdPending = (status === "pending" && !!decidedAt) || status === "parked";
  const label = holdPending
    ? "Pending"
    : status === "pending"
      ? "Needs a person"
      : status === "approved"
        ? "Approved"
        : "Rejected";
  return <Pill tone={signoffTone(status, decidedAt)}>{label}</Pill>;
}

const EdiBox = ({ title, text }: { readonly title: string; readonly text: string }) => (
  <div className="overflow-hidden rounded-[12px] border border-[rgb(32_49_25/0.12)] bg-hh-honeydew">
    <div className="border-[rgb(32_49_25/0.08)] border-b px-3 py-1.5 font-bold text-[12px] text-ink-78">{title}</div>
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11.5px] text-ink-78 leading-relaxed">
      {text.replace(/'(?!$)/g, "'\n")}
    </pre>
  </div>
);

function fmtQty(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "–";
  return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtMoney(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "–";
  return `€${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type ProblemLine = { title: string; detail?: string };

/** Turn the machine proposal into a short, person-facing problem list. No raw JSON / EDI. */
function proposalProblems(signoff: Signoff): ProblemLine[] {
  const p = signoff.proposal ?? {};
  const out: ProblemLine[] = [];

  if (typeof p.summary === "string" && p.summary.trim()) {
    out.push({ title: p.summary.trim() });
  }

  if (Array.isArray(p.lines) && (signoff.kind === "qty_choice" || signoff.kind === "confirm")) {
    for (const raw of p.lines as Record<string, unknown>[]) {
      if (signoff.kind === "qty_choice") {
        const name = String(raw.product || raw.gtin || `Line ${raw.line_no ?? "?"}`);
        const now = raw.ship_now ?? raw.now_qty ?? raw.available_qty;
        const later = raw.later ?? raw.later_qty;
        const laterDate = raw.later_date;
        const ordered = raw.ordered ?? raw.ordered_qty;
        let detail = `Ordered ${fmtQty(ordered)} · can ship now ${fmtQty(now)}`;
        if (Number(later) > 0 && laterDate) detail += ` · later ${fmtQty(later)} on ${laterDate}`;
        out.push({ title: name, detail });
      } else if (raw.gtin != null || raw.qty_confirmed != null || raw.quantity != null) {
        const name = String(raw.product || raw.gtin || `Line ${raw.line_no ?? "?"}`);
        const qty = raw.qty_confirmed ?? raw.quantity ?? raw.qty;
        out.push({ title: name, detail: qty != null ? `${fmtQty(qty)} units` : undefined });
      }
    }
  }

  const price = p.price_check as { lines?: Record<string, unknown>[] } | null | undefined;
  if (price?.lines?.length) {
    for (const line of price.lines) {
      if (line.ok === true) continue;
      out.push({
        title: `Price mismatch on ${String(line.gtin ?? "a line")}`,
        detail: `Ordered at ${fmtMoney(line.order_price)}; contract is ${fmtMoney(line.expected_price)}`,
      });
    }
  }

  if (Array.isArray(p.flags)) {
    for (const f of p.flags as Record<string, unknown>[]) {
      const what = String(f.what || f.message || f.code || "Read problem");
      const where = f.where || f.segment;
      out.push({ title: what, detail: where ? `In segment ${where}` : undefined });
    }
  }

  if (Array.isArray(p.availability) && signoff.kind === "stock_short") {
    for (const a of p.availability as Record<string, unknown>[]) {
      out.push({
        title: String(a.product || a.gtin || "Product"),
        detail: `Ordered ${fmtQty(a.ordered ?? a.ordered_qty)} · available ${fmtQty(a.available ?? a.available_qty)}`,
      });
    }
  }

  if (Array.isArray(p.backorders) && (p.backorders as unknown[]).length) {
    for (const b of p.backorders as Record<string, unknown>[]) {
      out.push({
        title: `Later shipment for ${String(b.gtin ?? "a product")}`,
        detail: `${fmtQty(b.qty)} units${b.date ? ` on ${b.date}` : ""}`,
      });
    }
  }

  return out.filter((row, i, arr) => arr.findIndex((x) => x.title === row.title && x.detail === row.detail) === i);
}

function ProblemList({ items }: { readonly items: ProblemLine[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-[12px] text-ink-68">What needs a decision</div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={`${item.title}-${item.detail ?? ""}`} className="rounded-[10px] bg-hh-honeydew px-3 py-2">
            <div className="font-bold text-[13px] tracking-[-0.01em]">{item.title}</div>
            {item.detail ? <div className="mt-0.5 text-[12.5px] text-ink-78">{item.detail}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProposalBody({ signoff }: { readonly signoff: Signoff }) {
  const p = signoff.proposal ?? {};
  const problems = proposalProblems(signoff);
  const draftOrdrsp = typeof p.draft_ordrsp === "string" ? p.draft_ordrsp : null;
  const rawEdi = typeof p.edi === "string" && p.edi.includes("UNA") ? p.edi : typeof p.edi === "string" && p.edi.length > 40 ? p.edi : null;

  return (
    <div className="space-y-3">
      <ProblemList items={problems} />
      {draftOrdrsp ? <EdiBox title="Draft ORDRSP" text={draftOrdrsp} /> : null}
      {rawEdi ? (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none text-ink-68">Technical EDI (for support)</summary>
          <div className="mt-2">
            <EdiBox title="ORDERS as received" text={rawEdi} />
          </div>
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

function qtySplitCopy(signoff: Signoff): { headline: string; detail: string } {
  const lines = (signoff.proposal?.lines as Record<string, unknown>[] | undefined) ?? [];
  const first = lines[0];
  if (!first) {
    return {
      headline: "Split: ship what is available now",
      detail: "Confirm the available quantity toward ORDRSP; any remainder can follow as a later order when stock returns.",
    };
  }
  const now = first.ship_now ?? first.now_qty ?? first.available_qty;
  const later = first.later ?? first.later_qty;
  const laterDate = first.later_date;
  if (Number(later) > 0 && laterDate) {
    return {
      headline: `Split: ship ${fmtQty(now)} now + ${fmtQty(later)} later`,
      detail: `Send an ORDRSP for ${fmtQty(now)} now. The remaining ${fmtQty(later)} stay as a later order (earliest ${laterDate}).`,
    };
  }
  return {
    headline: `Split: ship ${fmtQty(now)} now`,
    detail: `Accept the available quantity and continue toward ORDRSP for that amount only. The rest is not confirmed on this response.`,
  };
}

function splitDraft(draft: string): { subject: string; body: string } {
  const text = draft.replace(/\r\n/g, "\n").trim();
  const m = text.match(/^Subject:\s*(.+)\n\n?([\s\S]*)$/i);
  if (m) return { subject: m[1].trim(), body: m[2].replace(/\n?— Draft — review and send manually —\s*$/i, "").trim() };
  return { subject: "", body: text.replace(/\n?— Draft — review and send manually —\s*$/i, "").trim() };
}

function DecideSubmit({ label, className }: { readonly label: string; readonly className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={cn(className, "disabled:opacity-40")}>
      {pending ? "Running…" : label}
    </button>
  );
}

export function SignoffCard({
  signoff,
  confirmLabel,
  embedded = false,
  returnTab,
  initialCompose = false,
  formError,
}: {
  readonly signoff: Signoff;
  /** @deprecated navigation is handled by the server action redirect. */
  readonly onDecided?: (result: unknown) => void;
  readonly confirmLabel?: string;
  readonly embedded?: boolean;
  readonly returnTab?: string;
  readonly initialCompose?: boolean;
  readonly formError?: string;
}) {
  const c = signoff;
  const [by, setBy] = useState("");
  const takesEdi = c.row === "order" && (c.kind === "price_fix" || c.kind === "manual_edi");
  const qtyChoice = c.row === "order" && c.kind === "qty_choice";
  const priceCase = c.row === "order" && c.kind === "price_fix";
  const manualEdiCase = c.row === "order" && c.kind === "manual_edi";
  const draftMail = useMemo(() => {
    const fromProposal = c.proposal?.draft_mail;
    return typeof fromProposal === "string" ? fromProposal : "";
  }, [c.proposal]);
  const [composeMail, setComposeMail] = useState(initialCompose);
  const splitCopy = qtySplitCopy(c);
  const tab = returnTab ?? deskTabForSignoff(c);
  const closeMailHref = actionsCaseHref(c.caseId, tab);
  const mailHref = `${closeMailHref}${closeMailHref.includes("?") ? "&" : "?"}mail=1`;

  useEffect(() => {
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    setComposeMail(initialCompose);
  }, [signoff.caseId, initialCompose]);

  const open = c.status === "pending" && !c.decidedAt;
  const holdPending = (c.status === "pending" && !!c.decidedAt) || c.status === "parked";
  const sendOffLabel = confirmLabel ?? (c.kind === "confirm" ? "Send off" : "Approve");
  const defaultDraft =
    draftMail ||
    `Subject: Order no. ${c.subjectRef ?? c.caseId} — notice\n\nDear Customer,\n\nwe are writing with reference to order no. ${c.subjectRef ?? c.caseId}.\n\nKind regards,\nOrder office\n`;
  const mailParts = splitDraft(defaultDraft);

  if (composeMail && open) {
    const mailUi = (
      <form action={decideSignoffAction} className="space-y-3 text-[13px]">
        <input type="hidden" name="caseId" value={c.caseId} />
        <input type="hidden" name="tab" value={tab} />
        <input type="hidden" name="intent" value="mail" />
        <p className="text-[12.5px] text-ink-68">
          Review Grok’s draft, then send. Delivery is simulated — the order goes to Pending with no ORDRSP.
        </p>
        {formError ? <p className="text-[12px] text-st-wrong">{formError}</p> : null}
        <label className="block space-y-1">
          <span className="text-[12px] text-ink-68">Your name</span>
          <input
            name="by"
            required
            defaultValue={by}
            className="h-9 w-full rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
            placeholder="Who sends this mail"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-ink-68">To</span>
          <input
            name="mail_to"
            required
            defaultValue={defaultMailTo(c)}
            className="h-9 w-full rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
            placeholder="buyer@retailer.example"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-ink-68">Subject</span>
          <input
            name="mail_subject"
            required
            defaultValue={mailParts.subject || `Mail · ${c.subjectRef ?? c.caseId}`}
            className="h-9 w-full rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-ink-68">Message</span>
          <textarea
            name="mail_body"
            required
            defaultValue={mailParts.body}
            className="min-h-[240px] w-full rounded-lg border bg-hh-honeydew p-3 text-[13px] leading-relaxed outline-none focus:border-hh-asparagus"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <DecideSubmit label="Send mail" className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window" />
          <a
            href={closeMailHref}
            className="inline-flex h-9 items-center rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)]"
          >
            Back
          </a>
        </div>
      </form>
    );
    if (embedded) return mailUi;
    return (
      <Panel title={<span className="flex items-center gap-2">{c.title ?? c.kind}</span>} aside={<SignoffStatus status={c.status} decidedAt={c.decidedAt} />}>
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
          <div className="mb-1.5 text-[12px] text-ink-68">Why a person is asked</div>
          <ul className="space-y-2">
            {c.reasons.map((r) => (
              <li key={r} className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[13px] leading-snug">
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ProposalBody signoff={c} />

      {open ? (
        <form action={decideSignoffAction} className="space-y-3 rounded-[12px] bg-hh-honeydew p-3">
          <input type="hidden" name="caseId" value={c.caseId} />
          <input type="hidden" name="tab" value={tab} />
          {formError ? <p className="text-[12px] text-st-wrong">{formError}</p> : null}
          <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
            <input
              name="by"
              required
              defaultValue={by}
              className="h-9 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="Your name"
            />
            <input
              name="reason"
              required
              className="h-9 rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
              placeholder="One line on why (the Playbook learns from it)"
            />
          </div>
          {takesEdi ? (
            <textarea
              name="manual_edi"
              className="h-24 w-full rounded-lg border bg-hh-seasalt p-2 font-mono text-[11px] outline-none focus:border-hh-asparagus"
              placeholder="Optional: paste the corrected ORDERS EDI. Approving without it leaves the order Pending until a new ORDERS arrives."
            />
          ) : null}

          {qtyChoice ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="submit" name="intent" value="split" className="rounded-[12px] bg-hh-dark px-3 py-3 text-left text-hh-window">
                <div className="font-bold text-[13px]">{splitCopy.headline}</div>
                <div className="mt-1 text-[12px] text-hh-window/80">{splitCopy.detail}</div>
              </button>
              <a
                href={mailHref}
                className="rounded-[12px] bg-hh-seasalt px-3 py-3 text-left shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)]"
              >
                <div className="font-bold text-[13px] text-ink">Email &amp; Pending</div>
                <div className="mt-1 text-[12px] text-ink-68">
                  Open the mail to the retailer, send it, and move this order to Pending. No ORDRSP while it is blocked.
                </div>
              </a>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" name="intent" value="approve" className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window">
                {sendOffLabel}
              </button>
              {priceCase || manualEdiCase ? (
                <a
                  href={mailHref}
                  className="inline-flex h-8 items-center rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)]"
                >
                  Mail → Pending…
                </a>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" name="intent" value="reject" className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)]">
              Reject
            </button>
          </div>
        </form>
      ) : (
        <p className="text-ink-78">
          {holdPending ? "Pending" : c.status === "approved" ? "Approved" : "Rejected"} by <b>{c.decidedBy}</b>
          {c.decisionReason ? `: “${c.decisionReason}”` : ""} {c.decidedAt ? `· ${day(c.decidedAt)}` : ""}
        </p>
      )}
      {holdPending ? (
        <p className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[13px] text-ink">
          Waiting on the retailer (or a new ORDERS). This case stays under <b>Pending</b>, not Decided.
        </p>
      ) : null}
    </div>
  );

  if (embedded) return body;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {signoffUsedGrokbot(c) ? <GrokbotIcon size={16} title="Grokbot worked on this case" /> : null}
          {c.title ?? c.kind}
        </span>
      }
      aside={
        <span className="flex items-center gap-2">
          <SourceTag>{c.caseId}</SourceTag>
          <span>{ROW_LABEL[c.row] ?? c.row}</span>
          <SignoffStatus status={c.status} decidedAt={c.decidedAt} />
        </span>
      }
    >
      {body}
    </Panel>
  );
}

/** Compact queue: Links into Actions so opening a case works without client JS. */
export function SignoffQueue({ cases, compact = false }: { readonly cases: Signoff[]; readonly compact?: boolean }) {
  if (!cases.length) return <p className="py-3 text-[13px] text-ink-68">Nothing is waiting for a person.</p>;
  return (
    <ul className="divide-y divide-[var(--color-hairline)]">
      {cases.map((c) => (
        <li key={c.caseId} className="py-2">
          <a href={actionsCaseHref(c.caseId, deskTabForSignoff(c))} className="flex w-full items-center gap-3 text-left">
            <span className="inline-flex w-[88px] shrink-0 items-center gap-1.5 font-bold text-[13px]">
              {signoffUsedGrokbot(c) ? <GrokbotIcon size={14} title="Grokbot worked on this case" /> : null}
              {c.caseId}
            </span>
            <span className="w-[64px] shrink-0 text-[12px] text-ink-68">{ROW_LABEL[c.row] ?? c.row}</span>
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", compact && "text-ink-78")}>{c.title ?? c.kind}</span>
            <SignoffStatus status={c.status} decidedAt={c.decidedAt} />
          </a>
        </li>
      ))}
    </ul>
  );
}
