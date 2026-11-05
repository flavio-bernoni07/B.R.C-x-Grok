"use client";

/**
 * Wispr-style voice bar, bottom right of every page. Click opens the mic;
 * click again sends the Grok Voice transcript into the open thread.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { dispatchVoiceAsk } from "@/lib/voice-ask";

const BARS = 27;

type Phase = "idle" | "listening" | "sending" | "error";

type SpeechResultList = ArrayLike<{ readonly 0?: { readonly transcript?: string } }>;
type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { results: SpeechResultList }) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type Take = {
  started: number;
  cancelled: boolean;
  ending: boolean;
  finishing: boolean;
  chunks: Blob[];
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  ctx: AudioContext | null;
  recog: SpeechRec | null;
  browserText: string;
};

function micError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Allow the microphone to talk to Grok.";
  if (name === "NotFoundError") return "No microphone found.";
  return "Could not open the microphone.";
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function recorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
}

function speechRecognition(): (new () => SpeechRec) | null {
  const host = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

async function stopRecorder(take: Take): Promise<Blob> {
  const rec = take.recorder;
  const type = rec?.mimeType || take.chunks[0]?.type || "audio/webm";
  if (!rec || rec.state === "inactive") return new Blob(take.chunks, { type });
  return new Promise((resolve) => {
    rec.addEventListener(
      "stop",
      () => resolve(new Blob(take.chunks, { type: rec.mimeType || type })),
      { once: true },
    );
    rec.stop();
  });
}

function WisprWave({ analyser, live }: { readonly analyser: AnalyserNode | null; readonly live: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const smooth = useRef(new Array<number>(BARS).fill(0.16));
  const energy = useRef(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      for (let i = 0; i < BARS; i++) {
        const center = Math.sin((i / (BARS - 1)) * Math.PI);
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${(0.28 + center * 0.4).toFixed(3)})`;
      }
      return;
    }
    let frame = 0;
    let t = 0;
    const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
    const tick = () => {
      t += live ? 0.2 : 0.11;
      let raw = 0;
      if (analyser && samples && live) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = (samples[i]! - 128) / 128;
          sum += v * v;
        }
        raw = Math.min(1, Math.max(0, (Math.sqrt(sum / samples.length) - 0.015) * 9));
      }
      energy.current += (raw - energy.current) * (raw > energy.current ? 0.55 : 0.18);
      for (let i = 0; i < BARS; i++) {
        const n = i / (BARS - 1);
        const center = Math.sin(n * Math.PI);
        const idle = 0.2 + 0.26 * Math.sin(t * 1.45 + i * 0.55);
        const flutter = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(t * 2.6 + i * 0.83));
        const target = Math.min(1, idle * (0.45 + 0.55 * center) + energy.current * (0.25 + 0.75 * center) * flutter * 1.45);
        smooth.current[i] = (smooth.current[i] ?? 0) + (target - (smooth.current[i] ?? 0)) * 0.34;
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${(0.16 + (smooth.current[i] ?? 0) * 0.84).toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser, live]);

  return (
    <span className="voice-wave" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => {
        const center = Math.sin((i / (BARS - 1)) * Math.PI);
        return (
          <span
            key={i}
            ref={(el) => {
              bars.current[i] = el;
            }}
            className="voice-bar"
            style={{ opacity: 0.38 + center * 0.62 }}
          />
        );
      })}
    </span>
  );
}

export function VoiceHold() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const takeRef = useRef<Take | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const hideTimer = useRef<number | null>(null);
  const routerRef = useRef(router);
  routerRef.current = router;
  phaseRef.current = phase;

  const clearHide = () => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const rest = () => {
    phaseRef.current = "idle";
    setPhase("idle");
    setHeard("");
    setError("");
    setAnalyser(null);
  };

  const fail = (message: string) => {
    takeRef.current = null;
    setAnalyser(null);
    setHeard("");
    setError(message);
    setPhase("error");
    phaseRef.current = "error";
    clearHide();
    hideTimer.current = window.setTimeout(rest, 2400);
  };

  const releaseHardware = async (take: Take) => {
    try {
      take.recog?.abort();
    } catch {
      /* already stopped */
    }
    const blob = await stopRecorder(take);
    setAnalyser(null);
    await take.ctx?.close().catch(() => undefined);
    take.ctx = null;
    stopStream(take.stream);
    take.stream = null;
    return blob;
  };

  const sendText = (text: string) => {
    const words = text.trim();
    if (!words) {
      fail("Didn't catch that. Tap the voice bar and speak.");
      return;
    }
    const handled = dispatchVoiceAsk(words);
    if (!handled) routerRef.current.push(`/s?ask=${encodeURIComponent(words)}`);
    takeRef.current = null;
    clearHide();
    rest();
  };

  const finish = async (take: Take) => {
    if (take.finishing || take.cancelled) return;
    take.finishing = true;
    let blob = new Blob();
    try {
      blob = await releaseHardware(take);
    } catch {
      /* a failed stop still tries the browser transcript */
    }
    if (take.cancelled || takeRef.current !== take) return;
    const fallback = take.browserText.trim();
    if (!blob.size) {
      sendText(fallback);
      return;
    }
    try {
      const form = new FormData();
      form.append("audio", blob, blob.type.includes("mp4") ? "take.m4a" : "take.webm");
      const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
      const data = (await res.json()) as { text?: string; error?: string };
      if (take.cancelled || takeRef.current !== take) return;
      if (!res.ok || !data.text?.trim()) {
        if (fallback) sendText(fallback);
        else fail(data.error || "Grok Voice didn't answer. Try again.");
        return;
      }
      sendText(data.text);
    } catch {
      if (takeRef.current !== take) return;
      if (fallback) sendText(fallback);
      else fail("Grok Voice didn't answer. Try again.");
    }
  };

  const arm = async (take: Take) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (take.cancelled || takeRef.current !== take) {
        stopStream(stream);
        return;
      }
      take.stream = stream;
      const ctx = new AudioContext();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      node.smoothingTimeConstant = 0.62;
      source.connect(node);
      take.ctx = ctx;
      if (take.cancelled || takeRef.current !== take) {
        await ctx.close().catch(() => undefined);
        stopStream(stream);
        return;
      }
      setAnalyser(node);

      const mime = recorderMime();
      if (typeof MediaRecorder !== "undefined") {
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        take.recorder = rec;
        rec.ondataavailable = (event) => {
          if (event.data.size) take.chunks.push(event.data);
        };
        rec.start();
      }

      const Ctor = speechRecognition();
      if (Ctor) {
        const recog = new Ctor();
        recog.continuous = true;
        recog.interimResults = true;
        recog.onerror = () => {};
        recog.onresult = (event) => {
          let text = "";
          for (let i = 0; i < event.results.length; i++) text += event.results[i]?.[0]?.transcript ?? "";
          take.browserText = text.trim();
          if (takeRef.current === take && phaseRef.current === "listening") setHeard(take.browserText);
        };
        try {
          recog.start();
          take.recog = recog;
        } catch {
          /* the meter still runs when the browser speech engine is busy */
        }
      }

      if (take.ending && !take.cancelled) void finish(take);
    } catch (err) {
      if (take.cancelled || takeRef.current !== take) return;
      fail(micError(err));
    }
  };

  const begin = () => {
    if (phaseRef.current === "sending") return;
    if (takeRef.current && !takeRef.current.ending) return;
    clearHide();
    const take: Take = {
      started: performance.now(),
      cancelled: false,
      ending: false,
      finishing: false,
      chunks: [],
      stream: null,
      recorder: null,
      ctx: null,
      recog: null,
      browserText: "",
    };
    takeRef.current = take;
    phaseRef.current = "listening";
    setError("");
    setHeard("");
    setPhase("listening");
    void arm(take);
  };

  const end = () => {
    const take = takeRef.current;
    if (!take || take.ending) return;
    take.ending = true;
    phaseRef.current = "sending";
    setPhase("sending");
    if (take.stream || take.recorder) void finish(take);
  };

  const toggle = () => {
    if (phaseRef.current === "sending") return;
    if (phaseRef.current === "listening") end();
    else begin();
  };

  useEffect(() => {
    return () => {
      const take = takeRef.current;
      if (!take) return;
      take.cancelled = true;
      stopStream(take.stream);
      void take.ctx?.close().catch(() => undefined);
      try {
        take.recog?.abort();
      } catch {
        /* already stopped */
      }
    };
  }, []);

  const caption = phase === "error" ? error : heard;
  const status = phase === "listening" ? "Listening" : phase === "sending" ? "Sending to Grok" : "";
  const label = phase === "listening" ? "Stop and send to Grok" : phase === "sending" ? "Sending to Grok" : "Talk to Grok";

  return (
    <div className="voice-dock">
      <button
        type="button"
        className={phase === "listening" ? "voice-pill voice-pill-live" : "voice-pill"}
        aria-pressed={phase === "listening"}
        aria-label={label}
        title={label}
        disabled={phase === "sending"}
        onClick={toggle}
      >
        <span className="sr-only">{status}</span>
        <span className="voice-glow" aria-hidden="true" />
        <WisprWave analyser={analyser} live={phase === "listening"} />
        {caption ? <span className="voice-words">{caption}</span> : null}
      </button>
    </div>
  );
}
