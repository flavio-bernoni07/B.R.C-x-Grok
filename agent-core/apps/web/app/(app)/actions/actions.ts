"use server";

/**
 * Actions desk server actions: decide a case / Send-off all.
 * Works without client JS (form POST + redirect), same paths as the JSON APIs.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getReadyErp } from "@agent/lib/db/app";
import { deskTabForSignoff } from "@agent/lib/core/actions-desk";
import { decideSignoff as decideDispute } from "@agent/lib/dispute/decide";
import { decideSignoff as decideOrder } from "@agent/lib/order/decide";
import type { ConfirmedOrderHandoff } from "@agent/lib/order/service";
import { sendOffConfirmBatch } from "@agent/lib/order/service";
import { decideSignoff as decidePurchasing } from "@agent/lib/purchasing/decide";
import { decideSignoff as decideShipping } from "@agent/lib/shipping/decide";
import { ingestConfirmedOrder } from "@agent/lib/shipping/service";

const BY_ROW = {
  order: decideOrder,
  shipping: decideShipping,
  dispute: decideDispute,
  purchasing: decidePurchasing,
} as const;

const DESK_TABS = new Set(["board", "sendoff", "price", "quantity", "pending", "other", "decided"]);

function deskHref(tab: string, opts?: { caseId?: string; err?: string; mail?: boolean }) {
  const q = new URLSearchParams();
  const t = DESK_TABS.has(tab) ? tab : "board";
  if (t !== "board") q.set("tab", t);
  if (opts?.caseId) q.set("case", opts.caseId);
  if (opts?.mail) q.set("mail", "1");
  if (opts?.err) q.set("err", opts.err);
  const s = q.toString();
  return s ? `/actions?${s}` : "/actions";
}

function str(fd: FormData, key: string) {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

/**
 * Approve / reject / split / mail→Pending / open compose from the decide card.
 * Accepts either `intent=` (approve|reject|split|mail) or legacy `approve=` / `compose=` / `qty_action=`.
 */
export async function decideSignoffAction(formData: FormData) {
  const caseId = str(formData, "caseId").trim();
  let tab = str(formData, "tab").trim();
  const by = str(formData, "by").trim();
  let reason = str(formData, "reason").trim();
  const manualEdi = str(formData, "manual_edi").trim();
  const mailTo = str(formData, "mail_to").trim() || str(formData, "to").trim();
  const mailSubject = str(formData, "mail_subject").trim() || str(formData, "subject").trim();
  const mailBody = str(formData, "mail_body").trim() || str(formData, "body").trim();
  const draftMail = str(formData, "draft_mail").trim();

  // Open mail compose without deciding (progressive enhancement for Email & Pending).
  if (str(formData, "compose") === "1") {
    if (!caseId) redirect(deskHref(tab || "board", { err: "Missing case id." }));
    redirect(deskHref(tab || "board", { caseId, mail: true }));
  }

  let intent = str(formData, "intent").trim();
  if (!intent) {
    const approveRaw = str(formData, "approve");
    const qtyAction = str(formData, "qty_action");
    const sendMail = str(formData, "send_mail") === "1" || qtyAction === "mail";
    if (approveRaw === "0") intent = "reject";
    else if (qtyAction === "split") intent = "split";
    else if (sendMail || mailTo || draftMail) intent = "mail";
    else intent = "approve";
  }

  if (!caseId) redirect(deskHref(tab || "board", { err: "Missing case id." }));
  if (!by) redirect(deskHref(tab || "board", { caseId, err: "Enter your name.", mail: intent === "mail" }));

  if (intent === "mail") {
    if (!mailTo && !draftMail) {
      redirect(deskHref(tab || "board", { caseId, err: "Fill To, Subject and Message before sending.", mail: true }));
    }
    if (!reason) reason = `Sent availability mail to ${mailTo || "retailer"}`;
  } else if (!reason) {
    redirect(deskHref(tab || "board", { caseId, err: "Write one line on why." }));
  }

  const erp = await getReadyErp();
  const c = erp.signoff(caseId);
  if (!c) redirect(deskHref(tab || "board", { err: `No sign-off case ${caseId}` }));
  if (!tab) tab = deskTabForSignoff(c);
  const decide = BY_ROW[c.row as keyof typeof BY_ROW];
  if (!decide) redirect(deskHref(tab, { caseId, err: `No decision path for row ${c.row}` }));

  const approve = intent !== "reject";
  const edits: Record<string, unknown> = {};
  if (intent === "split") edits.qty_action = "split";
  if (intent === "mail") {
    if (c.kind === "qty_choice") edits.qty_action = "mail";
    if (c.kind === "price_fix" || c.kind === "manual_edi") edits.send_mail = true;
    edits.draft_mail = draftMail || `Subject: ${mailSubject}\n\n${mailBody}\n`;
    edits.mail_to = mailTo;
  }
  if (manualEdi) edits.manual_edi = manualEdi;

  try {
    const result = await decide(erp, caseId, { approve, by, reason, edits: Object.keys(edits).length ? edits : null });
    const handoff = (result as { handoff?: ConfirmedOrderHandoff }).handoff;
    if (c.row === "order" && handoff) ingestConfirmedOrder(erp, handoff);
  } catch (err) {
    redirect(deskHref(tab, { caseId, err: (err as Error).message, mail: intent === "mail" }));
  }

  revalidatePath("/actions");
  revalidatePath("/orders");
  revalidatePath("/");

  if (intent === "mail") redirect(deskHref("pending"));
  if (intent === "reject") redirect(deskHref("decided"));
  if (intent === "approve" && c.kind === "confirm") redirect(deskHref("decided"));
  redirect(deskHref(tab));
}

/** Alias used by older form wiring. */
export const decideSignoffForm = decideSignoffAction;

/** Batch Send-off all from the Send-off scheda (form action; no client JS). */
export async function sendOffAllAction(formData: FormData) {
  const by = str(formData, "by").trim();
  const reason = str(formData, "reason").trim() || "Send-off all: checks already passed; release ORDRSP batch";
  const caseIdsRaw = str(formData, "caseIds").trim();
  const caseIds = caseIdsRaw
    ? caseIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  if (!by) redirect(deskHref("sendoff", { err: "Enter your name before Send-off all." }));

  const erp = await getReadyErp();
  try {
    sendOffConfirmBatch(erp, { by, reason, caseIds });
  } catch (err) {
    redirect(deskHref("sendoff", { err: (err as Error).message }));
  }

  revalidatePath("/actions");
  revalidatePath("/orders");
  redirect(deskHref("decided"));
}
