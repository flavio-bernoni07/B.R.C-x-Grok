"use client";

/**
 * Actions: the inbox of cases that need a person (every row's pending sign-offs), and the
 * decisions already taken. An opened case reads top to bottom: what happened, why it matters,
 * evidence, Grok's proposal, alternatives, checks, before/after, the decision, then what ran
 * and the audit history. The decision posts to the same routes as the sign-off card.
 */
import {
  type Autonomy,
  caseAmount,
  caseAutonomy,
  caseNextStep,
  caseOrderRef,
  caseProblem,
  caseRole,
  caseUrgency,
} from "@agent/lib/core/case-view";
import type { AuditEntry, Signoff } from "@agent/lib/core/erp";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { DataTable, Facts, PageHeader, Panel, Pill, type PillTone, Segmented, SourceTag, day, eur, qty } from "@/components/kit";
import { Page } from "@/components/shell/app-shell";
import { AuditList } from "./audit";

type Filter = "pending" | "decided" | "all";
type J = Record<string, unknown>;
const obj = (v: unknown): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown) => (v == null ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
const words = (k: string) => k.replace(/_/g, " ");

const AUTONOMY_TONE: Record<Autonomy, PillTone> = { "Approval required": "attention", Blocked: "wait", Done: "ok" };

export function AutonomyPill({ c }: { readonly c: Signoff }) {
  const a = caseAutonomy(c);
  return <Pill tone={AUTONOMY_TONE[a]}>{a}</Pill>;
}

const orderLink = (ref: string) => (
  <a href={`/orders?ref=${encodeURIComponent(ref)}`} className="font-bold underline underline-offset-2">
    {ref}
  </a>
);

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="font-bold text-[13px] text-ink-78">{title}</h4>
      <div className="text-[13px]">{children}</div>
    </section>
  );
}

/** Proposal facts for evidence: scalar fields, plus a sourced point list for dispute verdicts. */
function Evidence({ c }: { readonly c: Signoff }) {
  const p = obj(c.proposal) ?? {};
  const ref = caseOrderRef(c);
  const scalars = Object.entries(p).filter(([k, v]) => !/(_dir|_path|draft_ordrsp)$/.test(k) && (v == null || typeof v !== "object"));
  const verdict = obj(p.verdict);
  const points = arr(verdict?.points).map(obj).filter(Boolean) as J[];
  const evidence = obj(obj(p.evidence) ?? obj(obj(p.case)?.evidence));
  return (
    <div className="space-y-2">
      <Facts
        items={[
          ...(ref ? ([["Order", orderLink(ref)]] as [ReactNode, ReactNode][]) : []),
          ...(c.subjectRef && c.subjectRef !== ref ? ([["Subject", c.subjectRef]] as [ReactNode, ReactNode][]) : []),
          ...scalars.map(([k, v]) => [words(k), text(v)] as [ReactNode, ReactNode]),
        ]}
      />
      {points.length ? (
        <ul className="space-y-1">
          {points.map((pt, i) => {
            const src = obj(pt.source);
            return (
              <li key={i} className="flex items-start gap-2">
                <span className="min-w-0 flex-1">{text(pt.text)}</span>
                {src ? <SourceTag title={text(src.detail)}>{text(src.ref)}</SourceTag> : <SourceTag>no source</SourceTag>}
              </li>
            );
          })}
        </ul>
      ) : null}
      {evidence ? (
        <pre className="max-h-48 overflow-auto rounded-lg bg-hh-honeydew p-2 font-mono text-[11px]">{JSON.stringify(evidence, null, 2)}</pre>
      ) : null}
      <details className="text-[12px]">
        <summary className="cursor-pointer select-none text-ink-68">Full proposal</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] text-ink-78">
          {JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !/(_dir|_path)$/.test(k))), null, 2)}
        </pre>
      </details>
    </div>
  );
}

function proposedSolution(c: Signoff): string[] {
  const p = obj(c.proposal) ?? {};
  const v = obj(p.verdict);
  const out = [caseNextStep(c)];
  if (typeof p.rationale === "string") out.push(p.rationale);
  if (typeof v?.summary === "string") out.push(v.summary);
  if (typeof v?.confidence === "number") out.push(`Grok's confidence: ${Math.round(v.confidence * 100)}%`);
  return out;
}

function alternatives(c: Signoff): string[] {
  const p = obj(c.proposal) ?? {};
  const list = [...arr(p.options), ...arr(p.allowed_actions), ...arr(p.possible_actions), ...arr(p.alternatives)];
  return list.map((x) => {
    const o = obj(x);
    if (!o) return words(String(x));
    const name = o.action ?? o.label ?? o.option ?? o.name;
    return `${words(String(name ?? JSON.stringify(o)))}${o.selected ? " (proposed)" : ""}`;
  });
}

/** Results of the code checks found in the proposal (availability, contract price, validation). */
function checks(c: Signoff): { label: string; ok: boolean; detail?: string }[] {
  const p = obj(c.proposal) ?? {};
  const out: { label: string; ok: boolean; detail?: string }[] = [];
  for (const a of arr(p.availability).map(obj)) {
    if (!a) continue;
    out.push({ label: `Stock for ${text(a.gtin)}`, ok: !!a.ok, detail: `${qty(a.available_qty as number)} available of ${qty(a.ordered_qty as number)} ordered (${text(a.source)})` });
  }
  const price = obj(p.price_check);
  if (price) out.push({ label: "Contract price", ok: !!price.ok, detail: typeof price.contract_id === "string" ? price.contract_id : undefined });
  for (const key of ["validation", "checks", "check_results"]) {
    const v = p[key];
    if (Array.isArray(v)) for (const x of v.map(obj)) x && out.push({ label: text(x.name ?? x.check ?? x.label), ok: !!(x.ok ?? x.passed), detail: x.detail ? text(x.detail) : undefined });
    else if (obj(v)) for (const [k, x] of Object.entries(obj(v)!)) out.push({ label: words(k), ok: x === true || !!obj(x)?.ok });
  }
  return out;
}

function CheckList({ items }: { readonly items: ReturnType<typeof checks> }) {
  return (
    <ul className="space-y-1">
      {items.map((ck, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className={ck.ok ? "font-bold text-st-ok-ink" : "font-bold text-st-wrong"}>{ck.ok ? "Passed" : "Failed"}</span>
          <span>{ck.label}</span>
          {ck.detail ? <span className="text-[12px] text-ink-68">{ck.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Pull a number from the first key present. */
const pick = (o: unknown, ...keys: string[]) => {
  const r = obj(o) ?? {};
  for (const k of keys) if (typeof r[k] === "number") return r[k] as number;
  return undefined;
};

/** The truck carrying this order in Operations' plan, if the plan route answers and names it. */
function TruckForOrder({ orderRef }: { readonly orderRef: string }) {
  const [plan, setPlan] = useState<unknown>();
  const [state, setState] = useState<"loading" | "none" | "ok">("loading");
  useEffect(() => {
    fetch("/api/logistics/plan")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setPlan(d);
        setState("ok");
      })
      .catch(() => setState("none"));
  }, []);
  if (state === "loading") return null;
  const root = obj(plan) ?? {};
  const trucks = [...arr(root.trucks), ...arr(obj(root.plan)?.trucks), ...arr(root.loads)].map(obj).filter(Boolean) as J[];
  const truck = trucks.find((t) => JSON.stringify(t).includes(orderRef));
  if (state === "none" || !truck) return <p className="text-ink-68">No truck plan for this order yet.</p>;
  const stops = arr(truck.stops).map((s) => (typeof s === "string" ? s : text(obj(s)?.name ?? obj(s)?.destination ?? obj(s)?.order_ref ?? s)));
  const base = obj(truck.baseline) ?? obj(root.baseline);
  const km = pick(truck, "km", "distance_km");
  const fuel = pick(truck, "eur", "fuel_eur", "fuelEur");
  const co2 = pick(truck, "co2_kg", "co2Kg");
  return (
    <div className="space-y-1.5">
      <Facts
        items={[
          ["Truck", text(truck.truck_id ?? truck.truckId ?? truck.id)],
          ["Stops", stops.join(" → ") || "–"],
          ["Distance", km != null ? `${qty(km)} km` : "–"],
          ["Fuel", fuel != null ? `${eur(fuel)} (estimate)` : "–"],
          ["CO2", co2 != null ? `${qty(co2)} kg (estimate)` : "–"],
          ...(base
            ? ([
                [
                  "One truck per order",
                  `${qty(pick(base, "km", "distance_km"))} km, ${eur(pick(base, "eur", "fuel_eur", "fuelEur"))}, ${qty(pick(base, "co2_kg", "co2Kg"))} kg CO2`,
                ],
              ] as [ReactNode, ReactNode][])
            : []),
        ]}
      />
    </div>
  );
}

/** Stock for the order's lines, checked again when the case is opened (not only when the order arrived). */
function useStockNow(orderRef: string, status: string) {
  const [items, setItems] = useState<ReturnType<typeof checks>>();
  useEffect(() => {
    if (!orderRef || status !== "pending") return;
    fetch(`/api/orders/${encodeURIComponent(orderRef)}/stock-now`)
      .then((r) => r.json())
      .then((d: { checks?: { label: string; ok: boolean; detail: string; source: string }[] }) =>
        setItems((d.checks ?? []).map((x) => ({ label: x.label, ok: x.ok, detail: `${x.detail} (${x.source})` }))),
      )
      .catch(() => setItems([{ label: "Stock right now", ok: false, detail: "could not be checked: the server did not answer" }]));
  }, [orderRef, status]);
  return items;
}

function ReadyToShip({ c }: { readonly c: Signoff }) {
  const p = obj(c.proposal) ?? {};
  const changes = arr(p.grokbot);
  const ref = c.subjectRef ?? "";
  const now = useStockNow(ref, c.status);
  const stored = checks(c);
  const failing = (now ?? []).filter((x) => !x.ok);
  return (
    <Panel title="Ready to ship" aside={ref}>
      <div className="space-y-3 text-[13px]">
        {failing.length ? (
          <p className="rounded-[10px] bg-st-attention/50 px-3 py-2">
            <b>Stock changed since the order arrived.</b> Approving now would promise stock that is not free: {failing.map((x) => x.detail).join("; ")}.
          </p>
        ) : null}
        <Section title={stored.every((x) => x.ok) && !failing.length ? "Checks passed" : "Checks"}>
          <CheckList items={[...(now ?? []), ...stored.map((x) => (x.label.startsWith("Stock for") ? { ...x, label: `${x.label}, when the order arrived` } : x))]} />
        </Section>
        <Section title="What Grok changed">
          {changes.length ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {changes.map((ch, i) => (
                <li key={i}>{typeof ch === "string" ? ch : JSON.stringify(ch)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-68">Nothing: the order went through as received.</p>
          )}
        </Section>
        <Section title="Draft ORDRSP">
          {typeof p.draft_ordrsp === "string" ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-hh-honeydew p-2 font-mono text-[11px]">
              {p.draft_ordrsp.replace(/'/g, "'\n")}
            </pre>
          ) : (
            <p className="text-ink-68">No draft in this case.</p>
          )}
        </Section>
        {ref ? (
          <Section title="Truck and route">
            <TruckForOrder orderRef={ref} />
          </Section>
        ) : null}
      </div>
    </Panel>
  );
}

type Outcome = { ok: boolean; message: string; result?: unknown };

function Decision({ c, onDone }: { readonly c: Signoff; readonly onDone: (o: Outcome, fresh?: Signoff) => void }) {
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [manualEdi, setManualEdi] = useState("");
  const [busy, setBusy] = useState(false);
  const takesEdi = c.row === "order" && (c.kind === "price_fix" || c.kind === "manual_edi");

  useEffect(() => {
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* private mode */
    }
  }, []);

  const post = async (kind: "approve" | "reject" | "clarify") => {
    setBusy(true);
    try {
      localStorage.setItem("brc:signer", by);
    } catch {
      /* ignore */
    }
    const url = `/api/signoffs/${encodeURIComponent(c.caseId)}/${kind === "clarify" ? "clarify" : "decide"}`;
    const body =
      kind === "clarify"
        ? { by, reason }
        : { approve: kind === "approve", by, reason, edits: takesEdi && manualEdi.trim() ? { manual_edi: manualEdi } : undefined };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    const data = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string; case?: Signoff; result?: unknown };
    setBusy(false);
    if (!res || !res.ok) return onDone({ ok: false, message: data.error ?? "The decision did not go through. Nothing was changed." });
    window.dispatchEvent(new Event("brc:changed"));
    const message =
      kind === "clarify"
        ? "Clarification requested. The case stays open and the request is in the audit trail."
        : `Recorded: ${data.case?.status ?? "decided"}. See below what ran after the decision.`;
    onDone({ ok: true, message, result: data.result }, data.case);
    if (kind === "clarify") setReason("");
  };

  const ready = !busy && by.trim() && reason.trim();
  return (
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
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!ready} onClick={() => void post("approve")} className="h-8 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40">
          Approve
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void post("reject")}
          className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void post("clarify")}
          className="h-8 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
        >
          Request clarification
        </button>
        {busy ? <span className="text-[12px] text-ink-68">Running the decision...</span> : null}
      </div>
    </div>
  );
}

function CaseDetail({ signoff, onChanged }: { readonly signoff: Signoff; readonly onChanged: () => void }) {
  const [c, setC] = useState(signoff);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [outcome, setOutcome] = useState<Outcome>();

  const loadAudit = useCallback(() => {
    fetch(`/api/signoffs/${encodeURIComponent(signoff.caseId)}`)
      .then((r) => r.json())
      .then((d: { case?: Signoff; audit?: AuditEntry[] }) => {
        if (d.case) setC(d.case);
        setAudit([...(d.audit ?? [])].reverse());
      })
      .catch(() => {});
  }, [signoff.caseId]);
  useEffect(loadAudit, [loadAudit]);

  const p = obj(c.proposal) ?? {};
  const amount = caseAmount(c);
  const alts = alternatives(c);
  const cks = checks(c);
  const before = p.before ?? obj(p.preview)?.before;
  const after = p.after ?? obj(p.preview)?.after;
  const isConfirm = c.row === "order" && c.kind === "confirm";

  return (
    <div className="space-y-4">
      <Panel
        title={caseProblem(c)}
        aside={
          <span className="flex items-center gap-2">
            <SourceTag>{c.caseId}</SourceTag>
            <AutonomyPill c={c} />
          </span>
        }
      >
        <div className="space-y-4">
          <Section title="What happened">
            <p>
              {c.subjectRef ? <b>{c.subjectRef}</b> : null} needs a decision from the {caseRole(c).toLowerCase()}. Asked {day(c.createdAt)}.
              {amount ? ` ${eur(amount.eur)} ${amount.label}.` : ""}
            </p>
          </Section>
          {c.reasons?.length ? (
            <Section title="Why it matters">
              <ul className="list-disc space-y-0.5 pl-5">
                {c.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title="Supporting evidence">
            <Evidence c={c} />
          </Section>
          <Section title="Grok's proposed solution">
            <ul className="space-y-0.5">
              {proposedSolution(c).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </Section>
          {alts.length ? (
            <Section title="Alternatives">
              <ul className="list-disc space-y-0.5 pl-5">
                {alts.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Section>
          ) : null}
          {cks.length ? (
            <Section title="Feasibility check">
              <CheckList items={cks} />
            </Section>
          ) : null}
          {before != null || after != null ? (
            <Section title="Before and after">
              <Facts items={[["Before", text(before)], ["After", text(after)]]} />
            </Section>
          ) : null}
        </div>
      </Panel>

      {isConfirm ? <ReadyToShip c={c} /> : null}

      <Panel title="Decision">
        <div className="space-y-3 text-[13px]">
          {c.status === "pending" ? (
            <Decision
              c={c}
              onDone={(o, fresh) => {
                setOutcome(o);
                if (fresh) setC(fresh);
                loadAudit();
                if (o.ok) onChanged();
              }}
            />
          ) : (
            <p className="text-ink-78">
              {c.status === "approved" ? "Approved" : "Rejected"} by <b>{c.decidedBy}</b>
              {c.decisionReason ? `: "${c.decisionReason}"` : ""} {c.decidedAt ? `· ${day(c.decidedAt)}` : ""}
            </p>
          )}
          {outcome ? <p className={outcome.ok ? "text-ink" : "text-st-wrong"}>{outcome.message}</p> : null}
          {outcome?.result != null ? (
            <details open className="text-[12px]">
              <summary className="cursor-pointer select-none text-ink-68">Execution result</summary>
              <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-hh-honeydew p-3 font-mono text-[11px] text-ink-78">
                {JSON.stringify(outcome.result, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </Panel>

      <Panel title="Audit history" aside={c.subjectRef ?? undefined}>
        <AuditList entries={audit} max={20} />
      </Panel>
    </div>
  );
}

/** The Actions inbox. */
export function ActionsView({ policy }: { readonly policy: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const [cases, setCases] = useState<Signoff[]>([]);
  const selected = params.get("case") ?? undefined;
  const [filter, setFilter] = useState<Filter>("pending");

  const load = useCallback(() => {
    fetch("/api/signoffs?all=1")
      .then((r) => r.json())
      .then((d) => setCases(d.all ?? d.pending ?? []))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  // A link to a decided case opens the matching filter.
  useEffect(() => {
    const c = cases.find((x) => x.caseId === selected);
    if (c && c.status !== "pending" && filter === "pending") setFilter("decided");
  }, [cases, selected, filter]);

  const rows = cases.filter((c) => filter === "all" || (filter === "pending" ? c.status === "pending" : c.status !== "pending"));
  const current = cases.find((c) => c.caseId === selected) ?? rows[0];

  return (
    <Page>
      <PageHeader title="Actions" sub={`Cases that need a person. Grok proposes, code checks, a person decides. ${policy}.`}>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "pending", label: "Waiting" },
            { value: "decided", label: "Decided" },
            { value: "all", label: "All" },
          ]}
        />
      </PageHeader>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <Panel>
          <DataTable
            rows={rows}
            rowKey={(c) => c.caseId}
            selectedKey={current?.caseId}
            onRowClick={(c) => router.replace(`/actions?case=${encodeURIComponent(c.caseId)}`, { scroll: false })}
            empty={filter === "pending" ? "Nothing needs a person right now." : "No decisions yet."}
            columns={[
              {
                key: "problem",
                header: "Problem",
                main: true,
                cell: (c) => {
                  const ref = caseOrderRef(c) ?? c.subjectRef;
                  return (
                    <span className="inline-flex max-w-[200px] flex-col align-middle leading-tight">
                      <span className="truncate">{caseProblem(c)}</span>
                      <span className="text-[11px] text-ink-68">
                        {ref ?? c.caseId} · {caseRole(c)} · {caseUrgency(c)}
                      </span>
                    </span>
                  );
                },
              },
              {
                key: "money",
                header: "At stake",
                cell: (c) => {
                  const a = caseAmount(c);
                  return a ? eur(a.eur, 0) : "–";
                },
              },
              { key: "status", header: "Status", cell: (c) => <AutonomyPill c={c} /> },
            ]}
          />
        </Panel>
        {current ? <CaseDetail key={current.caseId} signoff={current} onChanged={load} /> : null}
      </div>
    </Page>
  );
}
