"use client";

/**
 * Customer dispute chat with microphone → transcript confirmation → existing chat workflow.
 * Text fallback always available. Permanent API keys never leave the server.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "@/components/kit";

type Session = { retailer_id: string; retailer_name: string; simulated: true; label: string };
type VoiceCaps = {
  key_configured: boolean;
  transcription: boolean;
  speech: boolean;
  realtime_ephemeral: boolean;
  browser_speech_fallback: boolean;
};
type Dispute = {
  dispute_id: string;
  order_id: string | null;
  category: string;
  status: string;
  customer_description: string;
};
type ChatMsg = { role: "customer" | "assistant"; content: string };

type RecState = "idle" | "requesting" | "recording" | "transcribing" | "error";

const EXAMPLES = [
  "We received fewer products than ordered.",
  "The invoice amount is incorrect.",
  "Some products arrived damaged.",
  "Our delivery hasn't arrived.",
  "We received the wrong products.",
];

export function SupportChat() {
  const [session, setSession] = useState<Session | null>(null);
  const [warning, setWarning] = useState("");
  const [voice, setVoice] = useState<VoiceCaps | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("");
  const [recState, setRecState] = useState<RecState>("idle");
  const [voiceError, setVoiceError] = useState<string>("");
  const [speakReplies, setSpeakReplies] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const loadSession = useCallback(async () => {
    await fetch("/api/support/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailer_gln: "BUYER001" }),
    });
    const s = await fetch("/api/support/session").then((r) => r.json());
    setSession(s.session);
    setWarning(s.warning ?? "");
    setVoice(s.voice ?? null);
    const d = await fetch("/api/support/disputes").then((r) => r.json());
    setDisputes(d.disputes ?? []);
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, draft]);

  const refreshDisputes = async () => {
    const d = await fetch("/api/support/disputes").then((r) => r.json());
    setDisputes(d.disputes ?? []);
  };

  const maybeSpeak = async (text: string) => {
    if (!speakReplies || !voice?.speech) return;
    try {
      const res = await fetch("/api/support/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
    } catch {
      /* TTS is optional */
    }
  };

  const sendConfirmed = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setDraft(null);
    setInput("");
    setVoiceError("");
    setMessages((m) => [...m, { role: "customer", content: message }]);
    const idempotency_key = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await fetch("/api/support/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversation_id: conversationId, idempotency_key }),
      });
      const data = await res.json();
      if (data.conversation_id) setConversationId(data.conversation_id);
      if (data.reply) {
        setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
        void maybeSpeak(data.reply);
      }
      if (data.grok_mode) setMode(data.grok_mode);
      if (data.error && !data.submitted) {
        /* backend already returned a safe customer reply when possible */
      }
      await refreshDisputes();
    } catch {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "Something went wrong sending your message. Please try again — no dispute was created.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    setVoiceError("");
    setRecState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunks.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        void finishRecording();
      };
      rec.start();
      setRecState("recording");
    } catch (err) {
      setRecState("error");
      const name = (err as Error).name;
      setVoiceError(
        name === "NotAllowedError"
          ? "Microphone permission denied. Allow the mic, or type your message."
          : `Could not open the microphone: ${(err as Error).message}. You can type instead.`,
      );
      stopTracks();
    }
  };

  const finishRecording = async () => {
    stopTracks();
    const blob = new Blob(chunks.current, { type: chunks.current[0]?.type || "audio/webm" });
    chunks.current = [];
    mediaRecorder.current = null;
    if (!blob.size) {
      setRecState("error");
      setVoiceError("No audio captured. Try again or type your message.");
      return;
    }

    if (voice?.transcription) {
      setRecState("transcribing");
      try {
        const form = new FormData();
        form.append("audio", blob, "complaint.webm");
        const res = await fetch("/api/support/voice/transcribe", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Transcription failed (${res.status})`);
        setDraft(data.draft_text);
        setRecState("idle");
      } catch (err) {
        setRecState("error");
        setVoiceError(`${(err as Error).message} — try browser speech or type your message.`);
        tryBrowserSpeechFallback();
      }
      return;
    }

    setRecState("idle");
    tryBrowserSpeechFallback();
  };

  const stopRecording = () => {
    if (mediaRecorder.current && mediaRecorder.current.state !== "inactive") {
      mediaRecorder.current.stop();
    } else {
      stopTracks();
      setRecState("idle");
    }
  };

  const tryBrowserSpeechFallback = () => {
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition; SpeechRecognition?: new () => SpeechRecognition })
      .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SR) {
      setVoiceError((e) => e || "No server transcription and no browser speech recognition. Please type.");
      return;
    }
    setVoiceError("Using browser speech recognition (offline / no xAI key). Confirm the text before sending.");
    const recog = new SR();
    recog.lang = "it-IT";
    recog.interimResults = false;
    recog.maxAlternatives = 1;
    recog.onresult = (ev: SpeechRecognitionEvent) => {
      const text = ev.results[0]?.[0]?.transcript ?? "";
      if (text) setDraft(text);
      setRecState("idle");
    };
    recog.onerror = () => {
      setRecState("error");
      setVoiceError("Browser speech recognition failed. Please type your message.");
    };
    setRecState("recording");
    recog.start();
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
                Speak or type a delivery or invoice problem. We show the transcript for you to confirm, then register it
                for the credit desk — never inventing a refund from this chat.
              </p>
            </div>
            <a href="/disputes" className="rounded-full bg-hh-flex/15 px-3 py-1.5 text-[12px] text-hh-flex underline-offset-2 hover:underline">
              Employee Actions →
            </a>
          </div>
          {session ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
              <Pill tone="attention">Simulated session</Pill>
              <span className="text-hh-mintcream">
                {session.retailer_name} · {session.retailer_id}
              </span>
              {mode ? <span className="text-hh-opal">Reply: {mode === "live" ? "Grok live" : "offline deterministic"}</span> : null}
              {voice ? (
                <span className="text-hh-opal">
                  Voice: {voice.transcription ? "xAI STT" : "browser/type fallback"}
                  {voice.realtime_ephemeral ? " · realtime token ready" : ""}
                </span>
              ) : null}
            </div>
          ) : null}
          {warning ? <p className="mt-2 text-[11.5px] text-hh-opal/90">{warning}</p> : null}
        </header>

        <div className="grid flex-1 gap-4 lg:grid-cols-[1fr_280px]">
          <section className="flex min-h-[520px] flex-col rounded-[18px] bg-hh-seasalt shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]">
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 && !draft ? (
                <div className="space-y-3">
                  <p className="text-[14px] text-ink-68">Try an example, tap the mic, or type (English or Italian):</p>
                  <div className="flex flex-wrap gap-2">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => void sendConfirmed(ex)}
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
              {draft != null ? (
                <div className="rounded-[14px] border border-st-attention bg-st-attention/40 p-3">
                  <p className="font-bold text-[13px] text-st-attention-ink">Confirm what we heard</p>
                  <p className="mt-1 text-[12px] text-ink-68">Edit if needed, then Send. Nothing is submitted until the backend confirms.</p>
                  <textarea
                    className="mt-2 w-full rounded-[10px] border bg-white p-2 text-[14px] outline-none focus:border-hh-asparagus"
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || !draft.trim()}
                      onClick={() => void sendConfirmed(draft)}
                      className="h-9 rounded-full bg-hh-dark px-4 font-bold text-[13px] text-hh-window disabled:opacity-40"
                    >
                      Send confirmed text
                    </button>
                    <button type="button" onClick={() => setDraft(null)} className="h-9 rounded-full border px-4 text-[13px]">
                      Discard
                    </button>
                  </div>
                </div>
              ) : null}
              {busy ? <p className="text-[12.5px] text-ink-50">Checking your records…</p> : null}
              {voiceError ? <p className="text-[12.5px] text-st-wrong">{voiceError}</p> : null}
              <div ref={bottom} />
            </div>

            <div className="flex flex-wrap items-center gap-2 border-[rgb(32_49_25/0.08)] border-t px-3 pt-2 text-[12px] text-ink-68">
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={speakReplies} onChange={(e) => setSpeakReplies(e.target.checked)} />
                Read replies aloud {voice?.speech ? "(xAI TTS)" : "(needs API key)"}
              </label>
              <span className="text-ink-50">
                Mic: {recState === "recording" ? "recording…" : recState === "transcribing" ? "transcribing…" : recState}
              </span>
            </div>

            <form
              className="flex gap-2 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void sendConfirmed(input);
              }}
            >
              <button
                type="button"
                aria-label={recState === "recording" ? "Stop recording" : "Start microphone"}
                disabled={busy || recState === "transcribing" || recState === "requesting"}
                onClick={() => (recState === "recording" ? stopRecording() : void startRecording())}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-bold text-[13px] disabled:opacity-40 ${
                  recState === "recording" ? "bg-st-wrong text-white" : "border border-[rgb(32_49_25/0.2)] bg-hh-honeydew text-ink"
                }`}
              >
                {recState === "recording" ? "■" : "mic"}
              </button>
              <input
                className="h-11 flex-1 rounded-[12px] border border-[rgb(32_49_25/0.12)] bg-white px-3 text-[14px] outline-none focus:border-hh-asparagus"
                placeholder="Describe the problem, or use the mic…"
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
              <p className="mt-1 text-[12px] text-ink-68">Only cases for this simulated retailer. Status comes from the backend.</p>
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

/** Minimal DOM typings for the Web Speech API fallback (not always in TS lib). */
type SpeechRecognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};
type SpeechRecognitionEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
