"use client";

import { useMemo, useState } from "react";
import { DeskModal } from "./desk-modal";

function splitDraft(draft: string): { subject: string; body: string } {
  const text = draft.replace(/\r\n/g, "\n").trim();
  const m = text.match(/^Subject:\s*(.+)\n\n?([\s\S]*)$/i);
  if (m) return { subject: m[1].trim(), body: m[2].replace(/\n?— Draft — review and send manually —\s*$/i, "").trim() };
  return { subject: "", body: text.replace(/\n?— Draft — review and send manually —\s*$/i, "").trim() };
}

/** Simulated outbound mail: edit To / Subject / Body, then Send moves the order to Pending. */
export function MailCompose({
  title,
  defaultTo,
  draft,
  busy,
  error,
  signer,
  onCancel,
  onSend,
  inline = false,
}: {
  readonly title: string;
  readonly defaultTo: string;
  readonly draft: string;
  readonly busy?: boolean;
  readonly error?: string;
  readonly signer?: string;
  readonly onCancel: () => void;
  readonly onSend: (mail: { to: string; subject: string; body: string; full: string; by: string }) => void;
  /** When true, render the form in place (no second overlay). */
  readonly inline?: boolean;
}) {
  const initial = useMemo(() => splitDraft(draft), [draft]);
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(initial.subject || title);
  const [body, setBody] = useState(initial.body);
  const [by, setBy] = useState(signer ?? "");

  const send = () => {
    const full = `Subject: ${subject.trim()}\n\n${body.trim()}\n`;
    onSend({ to: to.trim(), subject: subject.trim(), body: body.trim(), full, by: by.trim() });
  };

  const form = (
    <div className="space-y-3 text-[13px]">
      <p className="text-[12.5px] text-ink-68">
        Review Grok’s draft{title ? <> for <b className="text-ink">{title}</b></> : null}, then send. Delivery is
        simulated — the order goes to Pending with no ORDRSP.
      </p>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-68">Your name</span>
        <input
          className="h-9 w-full rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
          value={by}
          onChange={(e) => setBy(e.target.value)}
          placeholder="Who sends this mail"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-68">To</span>
        <input
          className="h-9 w-full rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="buyer@retailer.example"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-68">Subject</span>
        <input
          className="h-9 w-full rounded-lg border bg-hh-seasalt px-3 text-[13px] outline-none focus:border-hh-asparagus"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-68">Message</span>
        <textarea
          className="min-h-[240px] w-full rounded-lg border bg-hh-honeydew p-3 text-[13px] leading-relaxed outline-none focus:border-hh-asparagus"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          disabled={busy || !by.trim() || !to.trim() || !subject.trim() || !body.trim()}
          onClick={send}
          className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send mail"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="h-9 rounded-full bg-hh-seasalt px-4 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.15)] disabled:opacity-40"
        >
          Back
        </button>
        {error ? <span className="text-[12px] text-st-wrong">{error}</span> : null}
      </div>
    </div>
  );

  if (inline) return form;

  return (
    <DeskModal
      title={title}
      aside="Review Grok’s draft, then send. Delivery is simulated — the order goes to Pending with no ORDRSP."
      onClose={onCancel}
      wide
    >
      {form}
    </DeskModal>
  );
}
