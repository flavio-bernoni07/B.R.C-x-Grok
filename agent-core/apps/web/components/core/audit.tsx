"use client";

/** The audit trail: every action, who did it (code, Grok, retailer or a person) and its source document. */
import type { AuditEntry } from "@agent/lib/core/erp";
import { Panel, Pill, type PillTone, SourceTag } from "@/components/kit";
import { GrokbotIcon } from "@/components/kit/icons";

export function actorTone(actor: string): PillTone {
  if (actor === "grok") return "grok";
  if (actor.startsWith("person")) return "attention";
  if (actor === "retailer") return "quiet";
  return "wait";
}

export const actorLabel = (actor: string) =>
  actor === "grok" ? "Grok" : actor === "code" ? "Code" : actor === "retailer" ? "Retailer" : actor.replace(/^person:/, "");

/** "production.batch_finished" → "Batch finished"; "signoff.requested" → "Sign-off requested". */
export const actionLabel = (action: string) => {
  const [area, ...rest] = action.split(".");
  const what = (rest.length ? rest.join(" ") : area).replace(/_/g, " ");
  const text = area === "signoff" && rest.length ? `sign-off ${what}` : what;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function AuditList({ entries, max }: { readonly entries: AuditEntry[]; readonly max?: number }) {
  const rows = max ? entries.slice(0, max) : entries;
  if (!rows.length) return <p className="py-3 text-[13px] text-ink-68">No actions recorded yet.</p>;
  return (
    <ol className="divide-y divide-[var(--color-hairline)]">
      {rows.map((e) => (
        <li key={e.id} className="flex items-center gap-3 py-1.5 text-[13px]">
          <span className="w-[84px] shrink-0 text-[12px] text-ink-68 tabular-nums">{time(e.at)}</span>
          <Pill tone={actorTone(e.actor)} className="max-w-[140px] shrink-0 truncate">
            {e.actor === "grok" ? <GrokbotIcon size={12} /> : null}
            {actorLabel(e.actor)}
          </Pill>
          <span className="min-w-0 flex-1 truncate">
            {actionLabel(e.action)}
            {e.subjectRef ? <b className="ml-1.5">{e.subjectRef}</b> : null}
          </span>
          {e.sourceDoc ? <SourceTag>{e.sourceDoc}</SourceTag> : null}
        </li>
      ))}
    </ol>
  );
}

/** Chat card for `audit_trail`. */
export function AuditCard({ output }: { readonly output: unknown }) {
  const o = output as { ref: string | null; entries: AuditEntry[] };
  return (
    <Panel title={o.ref ? `Audit trail of ${o.ref}` : "Latest actions"} aside={`${o.entries.length} actions`}>
      <AuditList entries={o.ref ? o.entries : [...o.entries].reverse()} />
    </Panel>
  );
}
