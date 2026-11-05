"use client";

/**
 * Voice: one spoken question per click, from any page.
 *
 * The engine (VoiceProvider) lives in the shell, so Grok keeps talking when its answer opens
 * another page. The button (VoiceButton) sits in every page's toolbar, beside +, and in the
 * thread header, so it never covers the ask box or a table.
 *
 * Click: the mic opens and the story ring shows. Click again, or pause, and the clip goes to
 * Grok Voice. Grok's answer is spoken while its page opens (VoiceSubtitles shows it at the
 * bottom of the sheet, word by word). A click while Grok thinks or talks stops it.
 * The question is not typed into the chat.
 */
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const BARS = 5;
const REST = [0.42, 0.72, 1, 0.72, 0.42];
/** A click this long after the mic opens sends the clip, even if the meter missed the speech. */
const SEND_AFTER_MS = 900;

type Phase = "idle" | "listening" | "sending" | "speaking" | "error";

type Take = {
  turn: number;
  started: number;
  heard: boolean;
  ending: boolean;
  finishing: boolean;
  chunks: Blob[];
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  source: MediaStreamAudioSourceNode | null;
};

/**
 * The subtitle line: the question heard ("you"), Grok's answer ("grok") or a problem ("note").
 * Grok's line carries when its audio started and how long it lasts, so words light up as said.
 */
export type Caption = {
  readonly who: "you" | "grok" | "note";
  readonly text: string;
  readonly start?: number;
  readonly duration?: number;
};

type Voice = {
  readonly phase: Phase;
  readonly caption: Caption | null;
  readonly analyser: AnalyserNode | null;
  readonly toggle: () => void;
};

const VoiceContext = createContext<Voice | null>(null);

function silentWav(): string {
  const rate = 8000;
  const n = 2000;
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, n * 2, true);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const SILENT_WAV = silentWav();

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

/** Free the mic. The blob is whatever was recorded. */
async function releaseTake(take: Take): Promise<Blob> {
  const blob = await stopRecorder(take).catch(() => new Blob());
  try {
    take.source?.disconnect();
  } catch {
    /* already disconnected */
  }
  take.source = null;
  stopStream(take.stream);
  take.stream = null;
  return blob;
}

function OrbBars({ analyser, live }: { readonly analyser: AnalyserNode | null; readonly live: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const smooth = useRef(REST.slice());
  const energy = useRef(0);

  useEffect(() => {
    const paint = (scale: number[]) => {
      for (let i = 0; i < BARS; i++) {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${(scale[i] ?? REST[i] ?? 0.5).toFixed(3)})`;
      }
    };
    if (!live || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(REST);
      return;
    }
    let frame = 0;
    let t = 0;
    const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
    const tick = () => {
      t += 0.2;
      let raw = 0;
      if (analyser && samples) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = (samples[i]! - 128) / 128;
          sum += v * v;
        }
        raw = Math.min(1, Math.max(0, (Math.sqrt(sum / samples.length) - 0.015) * 9));
      }
      energy.current += (raw - energy.current) * (raw > energy.current ? 0.55 : 0.18);
      const next: number[] = [];
      for (let i = 0; i < BARS; i++) {
        const center = Math.sin((i / (BARS - 1)) * Math.PI);
        const flutter = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.6 + i * 0.9));
        const target = Math.min(1, 0.28 + center * 0.2 + energy.current * (0.35 + 0.65 * center) * flutter);
        const value = (smooth.current[i] ?? 0) + (target - (smooth.current[i] ?? 0)) * 0.34;
        smooth.current[i] = value;
        next.push(value);
      }
      paint(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser, live]);

  return (
    <span className="voice-orb-wave" aria-hidden="true">
      {REST.map((scale, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="voice-orb-bar"
          style={{ transform: `scaleY(${scale})` }}
        />
      ))}
    </span>
  );
}

/** The voice engine. Mount once in the shell, around the pages. */
export function VoiceProvider({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [caption, setCaption] = useState<Caption | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const phaseRef = useRef<Phase>("idle");
  // Every click that starts or stops something moves the turn on. Late replies for an old turn are dropped.
  const turnRef = useRef(0);
  const takeRef = useRef<Take | null>(null);
  const hideTimer = useRef<number | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const speechCtx = useRef<AudioContext | null>(null);
  const speechSrc = useRef<AudioBufferSourceNode | null>(null);
  const endRef = useRef<() => void>(() => {});

  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };
  const alive = (turn: number) => turnRef.current === turn;

  const clearHide = () => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  // The opening click has to start the context and a real play() call.
  // Pausing that play before it resolves makes every later answer silent.
  const unlockAudio = () => {
    const current = speechCtx.current;
    const ctx = !current || current.state === "closed" ? new AudioContext() : current;
    speechCtx.current = ctx;
    const kick = () => {
      try {
        const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.2));
        const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.start();
      } catch (err) {
        console.error("voice unlock", err);
      }
    };
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === "running") kick();
      })
      .catch((err) => console.error("voice resume", err));
    kick();
    const audio = player.current ?? new Audio();
    player.current = audio;
    audio.setAttribute("playsinline", "");
    if (audio.paused) {
      audio.src = SILENT_WAV;
      const pending = audio.play();
      if (pending) void pending.catch((err) => console.error("voice unlock element", err));
    }
  };

  const stopSpoken = () => {
    const node = speechSrc.current;
    speechSrc.current = null;
    if (node) {
      try {
        node.stop();
      } catch {
        /* already ended */
      }
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    const audio = player.current;
    if (audio && !(audio.currentSrc || audio.src || "").startsWith("data:audio/wav")) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
  };

  const playOnContext = async (turn: number, bytes: ArrayBuffer, onStart: (seconds: number) => void): Promise<boolean> => {
    const ctx = speechCtx.current;
    if (!ctx || ctx.state === "closed") return false;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch (err) {
        console.error("voice resume", err);
        return false;
      }
    }
    if (ctx.state !== "running") return false;
    let buffer: AudioBuffer;
    try {
      buffer = await Promise.race([
        ctx.decodeAudioData(bytes.slice(0)),
        new Promise<AudioBuffer>((_, reject) => {
          window.setTimeout(() => reject(new Error("decode")), 4000);
        }),
      ]);
    } catch (err) {
      console.error("voice decode", err);
      return false;
    }
    if (!alive(turn)) return true;
    stopSpoken();
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    speechSrc.current = node;
    await new Promise<void>((resolve, reject) => {
      let cap = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(cap);
        resolve();
      };
      node.onended = finish;
      try {
        node.start();
        onStart(buffer.duration);
        cap = window.setTimeout(() => {
          try {
            node.stop();
          } catch {
            /* already ended */
          }
          finish();
        }, Math.ceil(buffer.duration * 1000) + 800);
      } catch (err) {
        reject(err);
      }
    });
    return true;
  };

  const playOnElement = async (bytes: ArrayBuffer, type: string, onStart: (seconds: number) => void) => {
    const audio = player.current ?? new Audio();
    player.current = audio;
    audio.setAttribute("playsinline", "");
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    audio.onended = null;
    audio.onerror = null;
    audio.src = url;
    audio.currentTime = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        let cap = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(cap);
          resolve();
        };
        const armCap = () => {
          window.clearTimeout(cap);
          const ms = Number.isFinite(audio.duration) && audio.duration > 0.2 ? Math.ceil(audio.duration * 1000) + 800 : 20_000;
          cap = window.setTimeout(() => {
            audio.pause();
            finish();
          }, ms);
        };
        audio.onended = finish;
        audio.onerror = () => reject(new Error("speak"));
        audio.onloadedmetadata = armCap;
        void audio
          .play()
          .then(() => {
            armCap();
            onStart(Number.isFinite(audio.duration) && audio.duration > 0.2 ? audio.duration : 0);
          })
          .catch(reject);
      });
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    }
  };

  const rest = () => {
    clearHide();
    setPhase("idle");
    setCaption(null);
    setAnalyser(null);
  };

  /**
   * Open Grok's page: the new sheet grows out of the voice button in a circle while the old one
   * sinks back. Without the View Transitions API, or with reduced motion, the page just opens.
   */
  const openPage = (href: string) => {
    const target = new URL(href, window.location.origin);
    const wanted = target.pathname + target.search;
    if (wanted === window.location.pathname + window.location.search) return;
    const go = () => routerRef.current.push(href);
    const doc = document as Document & {
      startViewTransition?: (update: () => Promise<void>) => { ready: Promise<void>; finished: Promise<void> };
    };
    const sheet = document.querySelector(".voice-sheet");
    const button = [...document.querySelectorAll(".voice-orb")].find((el) => el.getBoundingClientRect().width > 0);
    if (!doc.startViewTransition || !sheet || !button || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      go();
      return;
    }
    const box = sheet.getBoundingClientRect();
    const orb = button.getBoundingClientRect();
    const x = orb.left + orb.width / 2 - box.left;
    const y = orb.top + orb.height / 2 - box.top;
    const r = Math.ceil(Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y)));
    const root = document.documentElement;
    root.classList.add("voice-nav");
    const done = () => root.classList.remove("voice-nav");
    // Another page has to show its own title before the circle opens on it, or the circle opens on a blank sheet.
    const oldTitle = sheet.querySelector("h1");
    const samePage = target.pathname === window.location.pathname;
    try {
      const transition = doc.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            const began = Date.now();
            go();
            // Rendering is paused until this resolves, so poll with timers, not rAF.
            const check = () => {
              const arrived = window.location.pathname + window.location.search === wanted;
              const title = sheet.querySelector("h1");
              const drawn = samePage || (title !== null && title !== oldTitle);
              if ((arrived && drawn) || Date.now() - began > 2500) {
                window.setTimeout(resolve, 60);
                return;
              }
              window.setTimeout(check, 30);
            };
            check();
          }),
      );
      void transition.ready
        .then(() => {
          const timing = { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" as const };
          root.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
            { ...timing, pseudoElement: "::view-transition-new(voice-sheet)" },
          );
          root.animate(
            { opacity: [1, 0.4], transform: ["scale(1)", "scale(0.97)"] },
            { ...timing, pseudoElement: "::view-transition-old(voice-sheet)" },
          );
        })
        .catch(() => undefined);
      void transition.finished.then(done, done);
    } catch {
      done();
      go();
    }
  };

  /** Stop whatever this turn is doing: the mic, the request, the voice. */
  const cancel = () => {
    turnRef.current += 1;
    const take = takeRef.current;
    takeRef.current = null;
    if (take) void releaseTake(take);
    stopSpoken();
    rest();
  };

  const fail = (turn: number, message: string, ms = 2400, who: Caption["who"] = "note") => {
    if (!alive(turn)) return;
    const take = takeRef.current;
    takeRef.current = null;
    if (take) void releaseTake(take);
    setAnalyser(null);
    setCaption({ who, text: message });
    setPhase("error");
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      if (alive(turn) && phaseRef.current === "error") rest();
    }, ms);
  };

  const speak = async (turn: number, text: string, href: string | null) => {
    if (!alive(turn)) return;
    if (href) openPage(href);
    setPhase("speaking");
    // The question stays up until Grok's audio starts; then her words take over, timed to the audio.
    const onStart = (seconds: number) => {
      if (!alive(turn)) return;
      setCaption({ who: "grok", text, start: performance.now(), duration: seconds > 0 ? seconds : text.length / 14 });
    };
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`speak ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (!alive(turn)) return;
      const type = res.headers.get("content-type") || "audio/mpeg";
      const played = await playOnContext(turn, bytes, onStart).catch((err) => {
        console.error("voice context", err);
        return false;
      });
      if (!alive(turn)) return;
      if (!played) await playOnElement(bytes, type, onStart);
    } catch (err) {
      console.error("voice speak", err);
      // The answer stays on screen when the voice doesn't come through.
      fail(turn, text, 7000, "grok");
      return;
    }
    if (alive(turn)) rest();
  };

  const ask = async (turn: number, question: string) => {
    setCaption({ who: "you", text: question });
    try {
      const res = await fetch("/api/voice/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: question }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json()) as { text?: string; href?: string | null; error?: string };
      if (!alive(turn)) return;
      const text = data.text?.trim() ?? "";
      if (!res.ok || !text) {
        fail(turn, data.error || "Grok didn't answer. Try again.");
        return;
      }
      await speak(turn, text, data.href ?? null);
    } catch {
      fail(turn, "Grok didn't answer. Try again.");
    }
  };

  const finish = async (take: Take) => {
    if (take.finishing) return;
    take.finishing = true;
    const blob = await releaseTake(take);
    if (!alive(take.turn)) return;
    takeRef.current = null;
    setAnalyser(null);
    if (!blob.size) {
      fail(take.turn, "Didn't catch that. Click the voice button and speak.");
      return;
    }
    try {
      const form = new FormData();
      form.append("audio", blob, blob.type.includes("mp4") ? "take.m4a" : "take.webm");
      const res = await fetch("/api/voice/transcribe", { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!alive(take.turn)) return;
      const text = data.text?.trim() ?? "";
      if (!res.ok || !text) {
        fail(take.turn, data.error || "Grok Voice didn't catch that. Try again.");
        return;
      }
      await ask(take.turn, text);
    } catch {
      fail(take.turn, "Grok Voice didn't catch that. Try again.");
    }
  };

  const arm = async (take: Take) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (!alive(take.turn) || takeRef.current !== take) {
        stopStream(stream);
        return;
      }
      take.stream = stream;
      const current = speechCtx.current;
      const ctx = !current || current.state === "closed" ? new AudioContext() : current;
      speechCtx.current = ctx;
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      take.source = source;
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      node.smoothingTimeConstant = 0.62;
      source.connect(node);
      if (!alive(take.turn) || takeRef.current !== take) {
        void releaseTake(take);
        return;
      }
      setAnalyser(node);
      if (typeof MediaRecorder !== "undefined") {
        const mime = recorderMime();
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        take.recorder = rec;
        rec.ondataavailable = (event) => {
          if (event.data.size) take.chunks.push(event.data);
        };
        rec.start();
      }
      if (take.ending) void finish(take);
    } catch (err) {
      fail(take.turn, micError(err));
    }
  };

  const begin = () => {
    clearHide();
    stopSpoken();
    const turn = ++turnRef.current;
    const take: Take = {
      turn,
      started: performance.now(),
      heard: false,
      ending: false,
      finishing: false,
      chunks: [],
      stream: null,
      recorder: null,
      source: null,
    };
    takeRef.current = take;
    setCaption(null);
    setPhase("listening");
    void arm(take);
  };

  /** Send the clip now. */
  const end = () => {
    const take = takeRef.current;
    if (!take || take.ending) return;
    take.ending = true;
    setPhase("sending");
    if (take.recorder) void finish(take);
  };
  endRef.current = end;

  const toggle = () => {
    const now = phaseRef.current;
    if (now === "idle" || now === "error") {
      unlockAudio();
      begin();
      return;
    }
    if (now === "listening") {
      // A click after you speak sends the question. A click straight after opening closes the mic.
      const take = takeRef.current;
      if (take?.recorder && (take.heard || performance.now() - take.started > SEND_AFTER_MS)) end();
      else cancel();
      return;
    }
    cancel();
  };

  useEffect(() => {
    return () => {
      turnRef.current += 1;
      const take = takeRef.current;
      takeRef.current = null;
      if (take) void releaseTake(take);
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
      const ctx = speechCtx.current;
      speechCtx.current = null;
      void ctx?.close().catch(() => undefined);
    };
  }, []);

  // A pause after speech sends the clip. Opening silence does not.
  useEffect(() => {
    if (phase !== "listening" || !analyser) return;
    const samples = new Uint8Array(analyser.fftSize);
    const started = takeRef.current?.started ?? performance.now();
    let floor = 0.012;
    let speechMs = 0;
    let silenceMs = 0;
    let heard = false;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      if (now - started < 450) {
        if (rms < 0.05) floor = floor * 0.9 + rms * 0.1;
        frame = requestAnimationFrame(tick);
        return;
      }
      const speechAt = Math.min(0.08, Math.max(0.018, floor * 2.6));
      const quietAt = Math.min(speechAt * 0.72, Math.max(0.016, floor * 2.1));
      if (rms >= speechAt) {
        speechMs += dt;
        silenceMs = 0;
        if (speechMs >= 280 && !heard) {
          heard = true;
          if (takeRef.current) takeRef.current.heard = true;
        }
      } else if (rms <= quietAt) {
        if (heard) silenceMs += dt;
        else speechMs = Math.max(0, speechMs - dt);
      }
      if (heard && (silenceMs >= 1050 || now - started > 28_000)) {
        endRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, analyser]);

  return <VoiceContext.Provider value={{ phase, caption, analyser, toggle }}>{children}</VoiceContext.Provider>;
}

type Cue = { readonly words: { readonly text: string; readonly at: number }[]; readonly from: number };

/**
 * Grok's answer as subtitle cues: a sentence, or up to about 80 characters, per cue.
 * Each word gets the moment it is said, as a share of the audio: its letters, plus a beat
 * after a comma and a longer one after a full stop.
 */
function cuesFor(text: string): Cue[] {
  const words = text.split(/\s+/).filter(Boolean);
  const weight = (w: string) => w.length + 1 + (/[.!?]$/.test(w) ? 6 : /[,;:]$/.test(w) ? 3 : 0);
  const total = words.reduce((sum, w) => sum + weight(w), 0) || 1;
  const cues: Cue[] = [];
  let line: { text: string; at: number }[] = [];
  let chars = 0;
  let said = 0;
  words.forEach((w, i) => {
    line.push({ text: w, at: said / total });
    said += weight(w);
    chars += w.length + 1;
    const next = words[i + 1];
    if (!next || /[.!?]$/.test(w) ||(/[,;:]$/.test(w) && chars > 40) || chars + next.length > 80) {
      cues.push({ words: line, from: line[0]?.at ?? 0 });
      line = [];
      chars = 0;
    }
  });
  return cues;
}

/** Ticks while Grok talks, so her words light up as they are said. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(performance.now()), 50);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/** Subtitles at the bottom centre of the sheet: what you asked, then Grok's answer as she says it. */
export function VoiceSubtitles() {
  const voice = useContext(VoiceContext);
  const path = usePathname();
  const caption = voice?.caption ?? null;
  const [shown, setShown] = useState<Caption | null>(caption);
  const [leaving, setLeaving] = useState(false);

  // Keep the last line on screen long enough to fade out.
  useEffect(() => {
    if (caption) {
      setShown(caption);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [caption]);

  const timed = shown?.who === "grok" && shown.start != null && shown.duration != null;
  const now = useNow(timed && !leaving);
  const cues = useMemo(() => (shown?.who === "grok" ? cuesFor(shown.text) : []), [shown]);

  if (!shown) return null;

  // Home keeps its ask box at the bottom; the line sits above it there.
  const raised = path === "/" || path === "/s" || path.startsWith("/s/");
  const progress = timed ? Math.min(1, Math.max(0, (now - (shown.start ?? now)) / ((shown.duration ?? 1) * 1000))) : 1;
  let index = 0;
  cues.forEach((cue, i) => {
    if (cue.from <= progress) index = i;
  });
  const cue = cues[index];

  return (
    <div className={cn("voice-subs", raised && "is-raised", leaving && "is-leaving")} data-who={shown.who}>
      <span className="sr-only" role="status">
        {shown.who === "you" ? `You asked: ${shown.text}` : shown.text}
      </span>
      <div className="voice-subs-box" aria-hidden="true">
        {shown.who === "note" ? null : <span className="voice-subs-who">{shown.who === "you" ? "You" : "Grok"}</span>}
        {shown.who === "grok" && cue ? (
          <span key={index} className="voice-subs-text voice-subs-cue">
            {cue.words.map((word, i) => (
              <span key={i} className={cn("voice-subs-word", (!timed || word.at <= progress) && "is-said")}>
                {word.text}
                {i < cue.words.length - 1 ? " " : ""}
              </span>
            ))}
          </span>
        ) : (
          <span className="voice-subs-text">{shown.who === "you" ? `“${shown.text}”` : shown.text}</span>
        )}
      </div>
    </div>
  );
}

/** The voice button. Renders nothing outside the shell. */
export function VoiceButton({ className }: { readonly className?: string }) {
  const voice = useContext(VoiceContext);
  if (!voice) return null;
  const { phase, analyser, toggle } = voice;
  const on = phase === "listening" || phase === "sending" || phase === "speaking";
  const label =
    phase === "listening"
      ? "Listening. Click to send your question"
      : phase === "sending"
        ? "Grok is thinking. Click to stop"
        : phase === "speaking"
          ? "Grok is speaking. Click to stop"
          : "Ask Grok out loud";

  return (
    <div className={cn("voice-dock", className)}>
      <button
        type="button"
        className="voice-orb"
        data-phase={phase}
        aria-pressed={on}
        aria-busy={phase === "sending"}
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        {on ? <span className="voice-orb-ring" aria-hidden="true" /> : null}
        <span className="voice-orb-face">
          <OrbBars analyser={analyser} live={phase === "listening"} />
        </span>
      </button>
    </div>
  );
}
