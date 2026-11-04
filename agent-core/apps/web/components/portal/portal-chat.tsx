"use client";

/**
 * Customer support chat for retailers. Uses a clearly labeled simulated session.
 * Does not expose the employee dashboard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "@/components/kit";

type Session = { retailer_id: string; retailer_name: string; simulated: true; label: string };
type Dispute = {
  dispute_id: string;
  order_id: string | null;
  category: string;
  status: string;
  customer_description: string;
  claimed_quantity: number | null;
  claimed_amount: number | null;
};
type ChatMsg = { role: "customer" | "assistant"; content: string };

const EXAMPLES = [
  "We received fewer products than ordered.",
  "The invoice amount is incorrect.",
  "Some products arrived damaged.",
  "Our delivery hasn't arrived.",
  "We received the wrong products.",
];

export function PortalChat() {
  const [session, setSession] = useState<Session | null>(null);
  const [warning, setWarning] = useState<string>("");
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<string>("");
  const bottom = useRef<HTMLDivElement>(null);

  const loadSession = useCallback(async () => {
    await fetch("/api/portal/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailer_gln: "BUYER001" }),
    });
    const s = await fetch("/api/portal/session").then((r) => r.json());
    setSession(s.session);
    setWarning(s.warning ?? "");
    const d = await fetch("/api/portal/disputes").then((r) => r.json());
    setDisputes(d.disputes ?? []);
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "customer", content: message }]);
    const idempotency_key = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await fetch("/api/portal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversation_id: conversationId, idempotency_key }),
      });
      const data = await res.json();
      if (data.conversation_id) setConversationId(data.conversation_id);
      if (data.reply) setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      if (data.grok_mode) setMode(data.grok_mode);
      const d = await fetch("/api/portal/disputes").then((r) => r.json());
      setDisputes(d.disputes ?? []);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Something went wrong sending your message. Please try again — no dispute was created." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[linear-gradient(165deg,#e8f0e2_0%,#f4f7f1_42%,#dfe9e4_100%)] text-ink">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 p-4 md:p-6">
        <header className="rounded-[18px] bg-hh-dark px-5 py-4 text-hh-window shadow-[0_12px_40px_-20px_rgb(32_49_25/0.55)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[12px] tracking-[0.04em] text-hh-flex/90 uppercase">Riso Scotti · Retailer support</p>
              <h1 className="mt-1 font-bold text-[28px] tracking-[-0.03em] md:text-[32px]">How can we help with your order?</h1>
              <p className="mt-1 max-w-xl text-[14px] text-hh-mintcream/90">
                Describe a delivery or invoice problem in plain language. We register it for the credit desk — we never
                invent a refund from this chat.
              </p>
            </div>
            <a href="/actions" className="rounded-full bg-hh-flex/15 px-3 py-1.5 text-[12px] text-hh-flex underline-offset-2 hover:underline">
              Employee Actions →
            </a>
          </div>
          {session ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
              <Pill tone="attention">Simulated session</Pill>
              <span className="text-hh-mintcream">
                {session.retailer_name} · {session.retailer_id}
              </span>
              {mode ? <span className="text-hh-opal">Reply mode: {mode === "live" ? "Grok live" : "offline deterministic"}</span> : null}
            </div>
          ) : null}
          {warning ? <p className="mt-2 text-[11.5px] text-hh-opal/90">{warning}</p> : null}
        </header>

        <div className="grid flex-1 gap-4 lg:grid-cols-[1fr_280px]">
          <section className="flex min-h-[520px] flex-col rounded-[18px] bg-hh-seasalt shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-[14px] text-ink-68">Try an example, or type your own message (English or Italian):</p>
                  <div className="flex flex-wrap gap-2">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => void send(ex)}
                        className="rounded-full border border-[rgb(32_49_25/0.12)] bg-hh-honeydew px-3 py-1.5 text-left text-[13px] text-ink-78 transition hover:border-hh-asparagus hover:bg-hh-mint"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                  <p className="text-[12.5px] text-ink-50">Demo tip: after naming the problem, send “ORD-3001” (shortage) or “ORD-3002” (invoice price).</p>
                </div>
              ) : null}
              {messages.map((m, i) => (
                <div key={`${i}-${m.role}`} className={`flex ${m.role === "customer" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-[16px] px-3.5 py-2.5 text-[14px] leading-relaxed ${
                      m.role === "customer" ? "bg-hh-dark text-hh-window" : "bg-hh-honeydew text-ink shadow-[inset_0_0_0_1px_rgb(32_49_25/0.06)]"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {busy ? <p className="text-[12.5px] text-ink-50">Checking your records…</p> : null}
              <div ref={bottom} />
            </div>
            <form
              className="flex gap-2 border-[rgb(32_49_25/0.08)] border-t p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <input
                className="h-11 flex-1 rounded-[12px] border border-[rgb(32_49_25/0.12)] bg-white px-3 text-[14px] outline-none focus:border-hh-asparagus"
                placeholder="Describe the problem with your order…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="h-11 rounded-full bg-hh-dark px-5 font-bold text-[13px] text-hh-window disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </section>

          <aside className="space-y-3">
            <div className="rounded-[18px] bg-hh-seasalt p-4 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
              <h2 className="font-bold text-[15px]">Your disputes</h2>
              <p className="mt-1 text-[12px] text-ink-68">Only cases for this simulated retailer.</p>
              <ul className="mt-3 space-y-2">
                {disputes.length === 0 ? <li className="text-[13px] text-ink-50">None yet.</li> : null}
                {disputes.map((d) => (
                  <li key={d.dispute_id} className="rounded-[12px] bg-hh-honeydew px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[13px]">{d.dispute_id}</span>
                      <Pill tone={d.status === "CLOSED" || d.status === "RESOLVED" ? "ok" : "attention"}>{d.status}</Pill>
                    </div>
                    <p className="mt-1 text-[12px] text-ink-68">
                      {d.order_id ?? "—"} · {d.category}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-78">{d.customer_description}</p>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
