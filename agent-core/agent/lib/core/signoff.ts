/**
 * One sign-off queue for every row (port of core/signoff.py).
 *
 * A row asks for a person with `requestSignoff`: what is proposed and why a person is needed.
 * The person answers with `decide` and must write one line on why: that line is what the
 * Playbook and Grok learn from. Deciding never runs the action; the row's service does that
 * after an approval.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type Erp, nowIso, type Signoff } from "./erp";

export const ROWS = ["order", "shipping", "dispute", "purchasing"] as const;
export type Row = (typeof ROWS)[number];

export class SignoffError extends Error {}

export function requestSignoff(
  erp: Erp,
  req: { row: string; kind: string; subjectRef: string; title: string; proposal: Record<string, unknown>; reasons: string[] },
): string {
  if (!(ROWS as readonly string[]).includes(req.row)) throw new SignoffError(`unknown row ${req.row}`);
  if (!req.reasons.length) throw new SignoffError("a sign-off needs at least one reason a person is asked");
  const caseId = erp.nextId("signoff", "SO-");
  erp.insertSignoff({ caseId, ...req, status: "pending" });
  erp.log("code", "signoff.requested", req.subjectRef, { sourceDoc: caseId, detail: { kind: req.kind, reasons: req.reasons } });
  return caseId;
}

/** Open gate: needs a person. Pending (mail/hold): status still pending but decidedAt is set. */
export function isOpenSignoff(c: { status: string; decidedAt?: string | null }): boolean {
  return c.status === "pending" && !c.decidedAt;
}

/** Mail sent / held — Actions → Pending scheda (not Decided). */
export function isPendingHold(c: { status: string; decidedAt?: string | null }): boolean {
  return (c.status === "pending" && !!c.decidedAt) || c.status === "parked";
}

export function pending(erp: Erp, row?: string): Signoff[] {
  return erp.signoffs({ status: "pending", row }).filter(isOpenSignoff);
}

export function decide(
  erp: Erp,
  caseId: string,
  d: { approve: boolean; by: string; reason: string; edits?: Record<string, unknown> | null },
): Signoff {
  const c = erp.signoff(caseId);
  if (!c) throw new SignoffError(`no sign-off ${caseId}`);
  if (!isOpenSignoff(c)) throw new SignoffError(`${caseId} is already ${c.status}`);
  if (!d.by?.trim()) throw new SignoffError("say who decides");
  if (!d.reason?.trim()) throw new SignoffError("write one line on why: it is what the Playbook learns from");
  const proposal = { ...(c.proposal ?? {}) } as Record<string, unknown>;
  if (d.edits) proposal.edits = d.edits;
  // Mail / hold as Pending: waits on the retailer — not a closed "approved" (Decided) case.
  const edits = (d.edits ?? {}) as Record<string, unknown>;
  const holdPending =
    d.approve &&
    (edits.pending === true ||
      edits.parked === true ||
      edits.qty_action === "mail" ||
      edits.send_mail === true ||
      edits.mail_sent === true);
  const status = !d.approve ? "rejected" : holdPending ? "pending" : "approved";
  const decidedAt = nowIso();
  erp.updateSignoff(caseId, { status, decidedBy: d.by.trim(), decisionReason: d.reason.trim(), decidedAt, proposal });
  const logKind = !d.approve ? "rejected" : holdPending ? "pending" : "approved";
  erp.log(`person:${d.by.trim()}`, `signoff.${logKind}`, c.subjectRef, {
    sourceDoc: caseId,
    detail: { reason: d.reason.trim(), edits: d.edits ?? null, hold_pending: holdPending || null },
  });
  return erp.signoff(caseId)!;
}

/** Append a decided case to the Playbook's past-cases table (replaces the placeholder row first). */
export function recordPastCase(
  playbookPath: string,
  c: { when: string; orderRef: string; caseType: string; decision: string; amount: number | null; notes: string },
) {
  let text = readFileSync(playbookPath, "utf8");
  const notes = c.notes.replace(/[|\n]+/g, " ").replace(/\s+/g, " ").trim();
  const amount = c.amount != null ? c.amount.toFixed(2) : "—";
  const row = `| ${c.when} | ${c.orderRef} | ${c.caseType} | ${c.decision} | ${amount} | ${notes} |`;
  const placeholder = /^\| — \| — \| — \| — \| — \| No past cases yet \|\s*$/m;
  text = placeholder.test(text) ? text.replace(placeholder, row) : `${text.replace(/\n+$/, "")}\n${row}\n`;
  writeFileSync(playbookPath, text, "utf8");
}
