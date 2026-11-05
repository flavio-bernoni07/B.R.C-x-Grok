"use client";

/** Employee workspace for a customer phone/chat dispute (Disputes + Sign-off). */
import { useEffect, useState } from "react";
import { Panel, Pill, day } from "@/components/kit";

type Workspace = {
  case: { caseId: string; status: string; title?: string | null; kind?: string };
  dispute: {
    dispute_id: string;
    order_id: string | null;
    status: string;
    assigned_role: string;
    claimed_quantity: number | null;
    claimed_amount: number | null;
    category: string;
  } | null;
  customer_reported: {
    message: string | null;
    claimed_quantity: number | null;
    claimed_amount: number | null;
    category: string | null;
    channel?: string | null;
  };
  our_records: Record<string, unknown> | null;
  matches: string[];
  mismatches: string[];
  grok_analysis: Record<string, unknown> | null;
  verdict?: { decision?: string; summary?: string; amount?: number | null; confidence?: number } | null;
  next_action: {
    assigned_role: string;
    recommended?: unknown;
    requires_approval: boolean;
    path?: "verdict" | "customer_dispute";
  };
  conversation: { role: string; content: string; at: string }[];
};

export function DisputeWorkspace({
  caseId,
  onDecided,
}: {
  readonly caseId: string;
  readonly onDecided?: () => void;
}) {
  const [data, setData] = useState<Workspace | null>(null);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    fetch(`/api/actions/disputes/${encodeURIComponent(caseId)}`)
      .then((r) => r.json())
      .then((d) => setData(d.error ? null : d))
      .catch(() => setData(null));
    try {
      setBy(localStorage.getItem("brc:signer") ?? "");
    } catch {
      /* ignore */
    }
  }, [caseId]);

  if (!data) return <p className="text-[13px] text-ink-68">Loading dispute…</p>;

  const records = data.our_records ?? {};
  const verdictPath = data.next_action.path === "verdict" || data.case.kind === "verdict";
  const decide = async (approve: boolean, resolution?: string) => {
    if (!by.trim() || !reason.trim()) {
      setErr("Enter your name and one line on why.");
      return;
    }
    setBusy(true);
    setErr(undefined);
    try {
      localStorage.setItem("brc:signer", by.trim());
    } catch {
      /* ignore */
    }
    const res = await fetch(`/api/signoffs/${encodeURIComponent(caseId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approve,
        by: by.trim(),
        reason: reason.trim(),
        edits: resolution ? { resolution } : null,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(body.error ?? `Failed (${res.status})`);
      return;
    }
    try {
      window.dispatchEvent(new Event("brc:changed"));
    } catch {
      /* ignore */
    }
    onDecided?.();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="attention">{data.dispute?.status ?? data.case.status}</Pill>
        {data.customer_reported.channel === "phone" ? <Pill tone="live">Phone</Pill> : <Pill tone="quiet">Chat</Pill>}
        <span className="text-[13px] text-ink-68">
          {data.dispute?.dispute_id} · {data.dispute?.order_id} · {data.dispute?.assigned_role}
        </span>
      </div>

      <Panel title="What the customer reported">
        <p className="text-[14px] text-ink-78">{data.customer_reported.message}</p>
        <p className="mt-2 text-[13px] text-ink-68">
          Via {data.customer_reported.channel === "phone" ? "phone" : "chat"} · category{" "}
          {data.customer_reported.category ?? "—"} · claimed qty {data.customer_reported.claimed_quantity ?? "—"} · claimed
          amount {data.customer_reported.claimed_amount ?? "—"}
        </p>
        <p className="mt-1 text-[12px] text-ink-50">Claimed figures are not treated as verified receipt evidence.</p>
      </Panel>

      <Panel title="What our records show">
        <ul className="space-y-1 text-[13px] text-ink-78">
          <li>Ordered: {String(records.ordered_qty ?? "—")}</li>
          <li>Dispatched (DESADV/DDT): {String(records.dispatched_qty ?? "—")}</li>
          <li>Invoiced: {String(records.invoiced_qty ?? "—")}</li>
          <li>DDT: {Array.isArray(records.ddt_refs) ? (records.ddt_refs as string[]).join(", ") || "—" : "—"}</li>
          <li>Invoices: {Array.isArray(records.invoice_refs) ? (records.invoice_refs as string[]).join(", ") || "—" : "—"}</li>
          <li>Retailer receipt verified: {records.retailer_receipt_verified ? "yes" : "no"}</li>
        </ul>
      </Panel>

      <Panel title="What matches / doesn't match">
        <ul className="space-y-1 text-[13px]">
          {data.matches.map((m) => (
            <li key={m} className="text-st-ok-ink">
              ✓ {m}
            </li>
          ))}
          {data.mismatches.map((m) => (
            <li key={m} className="text-st-attention-ink">
              ! {m}
            </li>
          ))}
          {!data.matches.length && !data.mismatches.length ? <li className="text-ink-68">No reconciliation summary yet.</li> : null}
        </ul>
      </Panel>

      <Panel title="Grok's analysis">
        {data.verdict?.decision ? (
          <p className="mb-2 text-[14px] text-ink-78">
            Proposes <b>{data.verdict.decision}</b>
            {data.verdict.amount != null ? ` · ${data.verdict.amount}` : ""}
            {data.verdict.summary ? <span className="mt-1 block text-[13px] text-ink-68">{data.verdict.summary}</span> : null}
          </p>
        ) : null}
        <pre className="whitespace-pre-wrap text-[12.5px] text-ink-78 leading-relaxed">
          {JSON.stringify(data.grok_analysis ?? {}, null, 2)}
        </pre>
      </Panel>

      <Panel title="Next action">
        <p className="text-[13px] text-ink-78">
          Assigned: <b>{data.next_action.assigned_role}</b>
        </p>
        <p className="mt-1 text-[13px] text-ink-78">{String(data.next_action.recommended ?? "Review evidence before any credit note.")}</p>
        {data.case.status === "pending" ? (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              <input
                className="h-9 w-[140px] rounded-lg border bg-hh-seasalt px-3 text-[13px]"
                placeholder="Your name"
                value={by}
                onChange={(e) => setBy(e.target.value)}
              />
              <input
                className="h-9 min-w-[220px] flex-1 rounded-lg border bg-hh-seasalt px-3 text-[13px]"
                placeholder="One line on why"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {verdictPath ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(true)}
                  className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
                >
                  Approve Grok&apos;s proposal
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(false)}
                  className="h-9 rounded-full border border-st-wrong/40 px-4 font-bold text-[13px] text-st-wrong disabled:opacity-40"
                >
                  Reject &amp; reopen
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(true, "investigate")}
                  className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
                >
                  Investigate
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(true, "await_customer")}
                  className="h-9 rounded-full border border-[rgb(32_49_25/0.2)] bg-hh-honeydew px-4 font-bold text-[13px] disabled:opacity-40"
                >
                  Ask customer for evidence
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(false, "close_no_liability")}
                  className="h-9 rounded-full border border-st-wrong/40 px-4 font-bold text-[13px] text-st-wrong disabled:opacity-40"
                >
                  Close without credit
                </button>
              </div>
            )}
            {err ? <p className="text-[12.5px] text-st-wrong">{err}</p> : null}
            <p className="text-[11.5px] text-ink-50">
              {verdictPath
                ? "Approve runs the normal dispute outcome (credit note or evidence reply). Reject reopens the claim."
                : "No credit note or refund is issued from these buttons."}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-ink-68">Already decided.</p>
        )}
      </Panel>

      <Panel title="Conversation">
        <ul className="space-y-2">
          {data.conversation.map((m, i) => (
            <li key={`${m.at}-${i}`} className="rounded-[10px] bg-hh-honeydew px-3 py-2 text-[13px]">
              <span className="font-bold text-ink-68">{m.role}</span>
              <span className="ml-2 text-[11px] text-ink-50">{day(m.at)}</span>
              <p className="mt-0.5 text-ink-78">{m.content}</p>
            </li>
          ))}
          {!data.conversation.length ? <li className="text-[13px] text-ink-68">No portal transcript.</li> : null}
        </ul>
      </Panel>
    </div>
  );
}
