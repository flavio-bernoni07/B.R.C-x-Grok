"use client";

/**
 * Sign-off: the same table as Orders and Stock. A row opens the case in a panel: the problem,
 * Grok's mark with the action it suggests, and a real Approve / Reject. Evidence stays behind
 * "Details". A person decides; the reason they write is what the Playbook learns. Nothing is sent
 * until they confirm.
 */
import { caseAmount, caseNextStep, caseOrderRef, caseRole } from "@agent/lib/core/case-view";
import type { Signoff } from "@agent/lib/core/erp";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Btn, DataTable, Drawer, PageHeader, Pill, type PillTone, Segmented, day, eur, personFor } from "@/components/kit";
import { GrokMark } from "@/components/kit/icons";
import { announceChange, Page } from "@/components/shell/app-shell";
import { SectionChat } from "@/components/shell/section-chat";
import { cn } from "@/lib/utils";
import { CaseDetail } from "./actions-view";

type Filter = "sendoff" | "errors" | "claims" | "decided" | "all";
type J = Record<string, unknown>;
const obj = (v: unknown): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : undefined);

/** Send-off: checks passed; a person only confirms before ORDRSP / shipping. */
function isSendOff(c: Signoff): boolean {
  return c.status === "pending" && c.row === "order" && c.kind === "confirm";
}

/** Pending retailer claims waiting on the credit desk. */
function isClaimCase(c: Signoff): boolean {
  return c.status === "pending" && c.row === "dispute";
}

/** Waiting order/warehouse issues (not send-off, not claims). */
function isErrorCase(c: Signoff): boolean {
  return c.status === "pending" && !isSendOff(c) && !isClaimCase(c);
}

/** What kind of decision this is, in two words (open panel + On it — same as before). */
function kindLabel(c: Signoff): string {
  if (c.row === "dispute") return "Claim";
  if (c.row === "purchasing") return "Paddy purchase";
  if (c.kind === "dispatch_plan") return "Truck plan";
  if (c.row === "shipping") return "Warehouse";
  if (c.kind === "confirm") return "Order";
  if (c.kind === "price_fix") return "Price check";
  if (c.kind === "qty_choice" || c.kind === "stock_short") return "Quantity check";
  if (c.kind === "manual_edi") return "Unreadable order";
  return c.row.charAt(0).toUpperCase() + c.row.slice(1);
}

const STATUS: Record<string, [PillTone, string]> = { pending: ["attention", "Needs you"], approved: ["live", "Approved"], rejected: ["quiet", "Rejected"] };

/** Table category only: Send-off / Claims / error kinds / closed status. */
function categoryPill(c: Signoff): [PillTone, string] {
  if (c.status === "approved" || c.status === "rejected") return STATUS[c.status] ?? ["quiet", c.status];
  if (isSendOff(c)) return ["ok", "Send-off"];
  if (isClaimCase(c)) return ["attention", "Claim"];
  if (c.kind === "price_fix") return ["attention", "Price error"];
  if (c.kind === "qty_choice" || c.kind === "stock_short") return ["attention", "Quantity error"];
  return ["attention", kindLabel(c)];
}

/** Grok's confidence, when the proposal carries one. */
function confidence(c: Signoff): number | null {
  const p = obj(c.proposal) ?? {};
  const v = obj(p.verdict);
  const x = v?.confidence ?? p.confidence;
  return typeof x === "number" ? x : null;
}

/** Grok's verdict on a claim ("reject", "accept", "partial"…), or null for other rows. */
function claimDecision(c: Signoff): string | null {
  if (c.row !== "dispute") return null;
  const d = obj(obj(c.proposal)?.verdict)?.decision;
  return typeof d === "string" ? d.replace(/_/g, " ") : null;
}

/**
 * Turning a claim down is a hard call on a customer, so Grok never proposes it as a one-click
 * approve: the card asks for a human check, and the buttons name what happens to the claim.
 */
const needsHumanCheck = (c: Signoff) => claimDecision(c) === "reject";

/** The two buttons, in the words of what happens: for a claim, its outcome; otherwise approve / reject. */
function choiceLabels(c: Signoff): { approve: string; reject: string } {
  const d = claimDecision(c);
  if (d) return { approve: `${d.charAt(0).toUpperCase()}${d.slice(1)} the claim`, reject: "Reopen the claim" };
  return { approve: "Approve", reject: "Reject" };
}

const firstSentence = (s: string) => s.split(/(?<=[.!?])\s+/)[0];

/**
 * What happened, in one line each: the problem as the retailer or the warehouse put it, and the
 * reason behind Grok's suggestion (its own summary, or the first sign-off reason).
 */
function whatHappened(c: Signoff): { what: string | null; why: string | null } {
  const p = obj(c.proposal) ?? {};
  if (c.row === "dispute") {
    const v = obj(p.verdict) ?? {};
    const claim = obj(v.claim) ?? obj(obj(p.facts)?.claim) ?? {};
    const type = String(claim.claim_type ?? "a deduction").replace(/_/g, " ");
    const amount = typeof claim.amount === "number" ? ` of ${eur(claim.amount, 0)}` : "";
    const notes = typeof claim.raw_notes === "string" && claim.raw_notes.trim() ? `: ${claim.raw_notes.trim().replace(/\.$/, "")}` : "";
    return {
      what: `The retailer claims ${type === "other" ? "a deduction" : type}${amount}${notes}.`,
      why: typeof v.summary === "string" ? firstSentence(v.summary) : null,
    };
  }
  const problem = typeof p.problem === "string" ? p.problem : typeof p.reason === "string" ? p.reason : null;
  return { what: problem, why: (c.reasons ?? [])[0] ?? null };
}

/** The decision, inline: the button first, then name and one line of why, then confirm. */
export function DecideBar({ c, onDecided, onCheck }: { readonly c: Signoff; readonly onDecided: () => void; readonly onCheck?: () => void }) {
  const [choice, setChoice] = useState<"approve" | "reject" | null>(null);
  const labels = choiceLabels(c);
  const check = needsHumanCheck(c);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      const who = personFor(caseRole(c));
      setBy(localStorage.getItem("brc:signer") || (who ? `${who.name}, ${who.role.toLowerCase()}` : ""));
    } catch {
      /* private mode */
    }
  }, [c]);
  useEffect(() => {
    if (choice) ref.current?.focus();
  }, [choice]);

  const send = async () => {
    if (!choice || !by.trim() || !reason.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      localStorage.setItem("brc:signer", by);
    } catch {
      /* ignore */
    }
    const res = await fetch(`/api/signoffs/${encodeURIComponent(c.caseId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: choice === "approve", by, reason }),
    }).catch(() => undefined);
    const data = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string };
    setBusy(false);
    if (!res?.ok) return setError(data.error ?? "The decision did not go through. Nothing changed.");
    announceChange();
    onDecided();
  };

  if (!choice)
    return (
      <div className="flex flex-wrap items-center gap-2">
        {check && onCheck ? <Btn onClick={onCheck}>Check the evidence</Btn> : null}
        <Btn variant={check ? "outline" : undefined} onClick={() => setChoice("approve")}>
          {labels.approve}
        </Btn>
        <Btn variant="outline" onClick={() => setChoice("reject")}>
          {labels.reject}
        </Btn>
      </div>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input
        value={by}
        onChange={(e) => setBy(e.target.value)}
        placeholder="Your name"
        className="h-[38px] w-[150px] rounded-full bg-white px-4 text-[14px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.14)] outline-none focus:shadow-[inset_0_0_0_1.5px_#203119]"
      />
      <input
        ref={ref}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={`Why: ${(choice === "approve" ? labels.approve : labels.reject).toLowerCase()}, in one line`}
        className="h-[38px] min-w-[220px] flex-1 rounded-full bg-white px-4 text-[14px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.14)] outline-none focus:shadow-[inset_0_0_0_1.5px_#203119]"
      />
      <Btn type="submit" disabled={busy || !by.trim() || !reason.trim()} className="h-[38px]">
        {busy ? "Saving…" : `Confirm: ${(choice === "approve" ? labels.approve : labels.reject).toLowerCase()}`}
      </Btn>
      <button type="button" onClick={() => setChoice(null)} className="h-[38px] px-2 text-[13px] text-ink-68 hover:text-ink">
        Cancel
      </button>
      {error ? <p className="w-full text-[13px] text-st-wrong">{error}</p> : null}
    </form>
  );
}

/**
 * The sign-off card's decision, on the page the person is already on (an order or a claim).
 * Same buttons, same reason, same API. Nothing is sent until they confirm.
 */
export function SignoffInline({ c, onDecided }: { readonly c: Signoff; readonly onDecided: () => void }) {
  const [open, setOpen] = useState(false);
  const conf = confidence(c);
  const check = needsHumanCheck(c);
  const story = whatHappened(c);
  const amount = caseAmount(c);
  if (c.status !== "pending") return null;
  return (
    <section className="space-y-4 rounded-[16px] bg-white px-4 py-4 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-bold text-[16px] leading-snug tracking-[-0.02em]">{(c.title ?? c.kind).replace(/:.*$/, "")}</h3>
        {amount ? <b className="shrink-0 text-[16px] tabular-nums">{eur(amount.eur, 0)}</b> : null}
      </div>
      <div className="flex items-start gap-3 rounded-[12px] bg-hh-honeydew px-4 py-3">
        <GrokMark size={28} title="Grok's suggestion" />
        <span className="min-w-0 flex-1 text-[15px] leading-snug">
          {check ? (
            <>
              <b className="text-st-pending-ink">Human check</b>
              <span className="text-ink-78"> · Grok leans to {caseNextStep(c).toLowerCase()}</span>
            </>
          ) : (
            <>
              <span className="text-ink-68">Grok suggests </span>
              <b>{caseNextStep(c)}</b>
            </>
          )}
          {story.why ? <span className="mt-1 block text-[14px] text-ink-68">{story.why}</span> : null}
        </span>
        {conf != null ? <span className={cn("shrink-0 text-[13px] tabular-nums", conf < 0.55 ? "font-bold text-st-pending-ink" : "text-ink-68")}>{Math.round(conf * 100)}%</span> : null}
      </div>
      <DecideBar c={c} onDecided={onDecided} onCheck={open ? undefined : () => setOpen(true)} />
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[14px] font-bold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
        {open ? "Hide details" : "Details"} <span className={cn("inline-block transition-transform", open && "rotate-90")}>›</span>
      </button>
      {open ? (
        <div className="border-hairline border-t pt-4">
          <CaseDetail signoff={c} onChanged={onDecided} hideDecision />
        </div>
      ) : null}
    </section>
  );
}

const caseTitle = (c: Signoff) => (c.title ?? c.kind).replace(/:.*$/, "");

/** Who has to decide, or who did: the same face-and-desk cell as Orders. */
function OnIt({ c }: { readonly c: Signoff }) {
  const who = c.status === "pending" ? caseRole(c) : (c.decidedBy ?? caseRole(c));
  const person = personFor(who);
  return (
    <span className="flex items-center gap-2.5">
      <Avatar kind="person" name={who} size={30} />
      <span className="min-w-0 leading-tight">
        <b className="block font-bold text-ink">{person ? person.name : who.replace(/,.*$/, "")}</b>
        <span className="block text-[12px] text-ink-68">{person ? person.role : kindLabel(c)}</span>
      </span>
    </span>
  );
}

/** The opened case: same decision as the old card, in the side panel. */
function CasePanel({ c, onDecided }: { readonly c: Signoff; readonly onDecided: () => void }) {
  const [open, setOpen] = useState(false);
  const amount = caseAmount(c);
  const ref = caseOrderRef(c) ?? c.subjectRef;
  const conf = confidence(c);
  const [tone, label] = STATUS[c.status] ?? ["quiet", c.status];
  const pending = c.status === "pending";
  const check = pending && needsHumanCheck(c);
  const story = whatHappened(c);
  return (
    <div className="space-y-5 p-8 pr-16">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="quiet">{kindLabel(c)}</Pill>
            <Pill tone={tone}>{label}</Pill>
          </div>
          <h2 className="mt-3 font-bold text-[24px] leading-tight tracking-[-0.03em]">{caseTitle(c)}</h2>
          <p className="mt-1 text-[14px] text-ink-68 tabular-nums">
            {[ref, caseRole(c), amount ? `${eur(amount.eur, 0)} ${amount.label}` : null, `asked ${day(c.createdAt)}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        {amount ? <b className="shrink-0 font-bold text-[28px] tabular-nums tracking-[-0.03em]">{eur(amount.eur, 0)}</b> : null}
      </div>
      {story.what ? <p className="text-[15px] leading-snug">{story.what}</p> : null}

      <div className="flex items-start gap-3 rounded-[12px] bg-hh-honeydew px-4 py-3">
        <GrokMark size={28} title="Grok's suggestion" />
        <span className="min-w-0 flex-1 text-[15px] leading-snug">
          {check ? (
            <>
              <b className="text-st-pending-ink">Human check</b>
              <span className="text-ink-78"> · Grok leans to {caseNextStep(c).toLowerCase()}</span>
            </>
          ) : (
            <>
              <span className="text-ink-68">Grok suggests </span>
              <b>{caseNextStep(c)}</b>
            </>
          )}
          {story.why ? <span className="mt-1 block text-[14px] text-ink-68">{story.why}</span> : null}
        </span>
        {conf != null ? (
          <span className={cn("mt-0.5 shrink-0 text-[13px] tabular-nums", conf < 0.55 ? "font-bold text-st-pending-ink" : "text-ink-68")}>{Math.round(conf * 100)}%</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {pending ? (
          <DecideBar c={c} onDecided={onDecided} onCheck={open ? undefined : () => setOpen(true)} />
        ) : (
          <p className="text-[14px] text-ink-68">{c.decidedBy ? `${label} by ${c.decidedBy}${c.decisionReason ? `: ${c.decisionReason}` : ""}` : label}</p>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-[14px] font-bold text-ink-78 hover:text-ink">
          {open ? "Hide details" : "Details"} <span className={cn("inline-block transition-transform", open && "rotate-90")}>›</span>
        </button>
      </div>
      {open ? (
        <div className="hh-rise border-hairline border-t pt-5">
          <CaseDetail signoff={c} onChanged={onDecided} hideDecision={pending} />
        </div>
      ) : null}
    </div>
  );
}

function matchesFilter(c: Signoff, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "sendoff") return isSendOff(c);
  if (f === "errors") return isErrorCase(c);
  if (f === "claims") return isClaimCase(c);
  return c.status !== "pending";
}

function filterForCase(c: Signoff): Filter {
  if (isSendOff(c)) return "sendoff";
  if (isClaimCase(c)) return "claims";
  if (isErrorCase(c)) return "errors";
  return "decided";
}

export function SignoffDesk() {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get("case") ?? undefined;
  const [cases, setCases] = useState<Signoff[]>();
  const [filter, setFilter] = useState<Filter>("errors");
  const filterTouched = useRef(false);

  const load = useCallback(() => {
    fetch("/api/signoffs?all=1")
      .then((r) => r.json())
      .then((d: { all?: Signoff[]; pending?: Signoff[] }) => setCases(d.all ?? d.pending ?? []))
      .catch(() => setCases([]));
  }, []);
  useEffect(load, [load]);

  // Deep link: open the matching scheda once when the case arrives (don't fight manual tabs).
  useEffect(() => {
    if (!selected || filterTouched.current) return;
    const c = cases?.find((x) => x.caseId === selected);
    if (c) setFilter(filterForCase(c));
  }, [cases, selected]);

  // First load with no deep link: Errors, else Claims, else Send-off.
  useEffect(() => {
    if (!cases || selected || filterTouched.current) return;
    if (cases.some(isErrorCase)) setFilter("errors");
    else if (cases.some(isClaimCase)) setFilter("claims");
    else if (cases.some(isSendOff)) setFilter("sendoff");
    else setFilter("decided");
  }, [cases, selected]);

  const all = cases ?? [];
  const rows = all.filter((c) => matchesFilter(c, filter));
  const count = (f: Filter) => all.filter((c) => matchesFilter(c, f)).length;
  const openCase = selected ? all.find((c) => c.caseId === selected) : undefined;
  const go = (id?: string) => router.replace(id ? `/signoff?case=${encodeURIComponent(id)}` : "/signoff", { scroll: false });
  const setTab = (f: Filter) => {
    filterTouched.current = true;
    setFilter(f);
  };
  const empty =
    filter === "sendoff"
      ? "No clean orders waiting to send off."
      : filter === "errors"
        ? "No cases with errors."
        : filter === "claims"
          ? "No claims waiting."
          : filter === "decided"
            ? "No decisions yet."
            : "No cases.";

  return (
    <>
      <Page>
        <PageHeader title="Sign-off">
          <Segmented
            value={filter}
            onChange={setTab}
            options={[
              { value: "sendoff", label: "Send-off", count: count("sendoff") },
              { value: "errors", label: "Errors", count: count("errors") },
              { value: "claims", label: "Claims", count: count("claims") },
              { value: "decided", label: "Decided", count: count("decided") },
              { value: "all", label: "All", count: count("all") },
            ]}
          />
        </PageHeader>
        {!cases ? (
          <div className="h-80 animate-pulse rounded-[16px] bg-hh-honeydew" />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(c) => c.caseId}
            selectedKey={selected}
            onRowClick={(c) => go(c.caseId)}
            empty={empty}
            columns={[
              {
                key: "c",
                header: "Case",
                main: true,
                cell: (c) => <span className="block max-w-[360px] truncate">{caseTitle(c)}</span>,
              },
              { key: "w", header: "On it", cell: (c) => <OnIt c={c} /> },
              { key: "a", header: "Asked", cell: (c) => day(c.createdAt) },
              {
                key: "v",
                header: "Value",
                align: "right",
                cell: (c) => {
                  const amount = caseAmount(c);
                  return <b className="font-bold text-[16px] text-ink">{amount ? eur(amount.eur, 0) : "–"}</b>;
                },
              },
              {
                key: "s",
                header: "Status",
                cell: (c) => {
                  // Pending: show Send-off vs error category; closed: Approved / Rejected as before.
                  if (c.status === "pending") {
                    const [tone, label] = categoryPill(c);
                    return <Pill tone={tone}>{label}</Pill>;
                  }
                  const [tone, label] = STATUS[c.status] ?? ["quiet", c.status];
                  return <Pill tone={tone}>{label}</Pill>;
                },
              },
            ]}
          />
        )}
        <SectionChat
          placeholder="Ask Grok about a case before you decide…"
          context={{ page: "signoff", case: selected ?? "" }}
          suggestions={["What should I check before deciding?", "What did people decide on similar cases?"]}
        />
      </Page>
      <Drawer open={!!selected} onClose={() => go()}>
        {openCase ? <CasePanel key={openCase.caseId} c={openCase} onDecided={load} /> : <div className="m-8 h-64 animate-pulse rounded-[16px] bg-hh-honeydew" />}
      </Drawer>
    </>
  );
}
