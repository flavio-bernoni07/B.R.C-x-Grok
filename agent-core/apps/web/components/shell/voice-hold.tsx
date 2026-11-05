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

/**
 * A word Grok can point at on the page: an order or case ref, a decimal, or a number with a
 * thousands separator. Bare small numbers ("8 cases", "500 g") match too much to point at.
 */
function pointToken(word: string): string | null {
  const w = word.replace(/^[“"'(]+/, "").replace(/[”"'),.;:!?]+$/, "");
  if (/^[A-Z]{2,5}-[A-Z0-9-]*\d[A-Z0-9-]*$/.test(w)) return w;
  if (/^\d[\d,]*\.\d+$/.test(w) || /^\d{1,3}(?:,\d{3})+$/.test(w)) return w;
  return null;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The element on the sheet that shows this token: on screen first, then the biggest type. */
function findOnPage(token: string): HTMLElement | null {
  const sheet = document.querySelector(".voice-sheet");
  if (!sheet) return null;
  const box = sheet.getBoundingClientRect();
  const numeric = /^\d/.test(token);
  const forms = numeric ? [...new Set([token, token.replace(/,/g, "")])] : [token];
  const patterns = forms.map((form) =>
    numeric ? new RegExp(`(?<![\\d.,])${escapeRe(form)}(?![\\d]|[.,]\\d)`) : new RegExp(`(?<![\\w-])${escapeRe(form)}(?![\\w-])`),
  );
  const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (!patterns.some((re) => re.test(text))) continue;
    const el = node.parentElement;
    if (!el || el.closest(".voice-subs, .voice-dock, .sr-only, [hidden], [inert], [aria-hidden='true']")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    // Drawn for real: no hidden or see-through ancestor, and on screen nothing else covers it.
    const seen = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility?.({ opacityProperty: true, visibilityProperty: true });
    if (seen === false || style.visibility === "hidden" || Number(style.opacity) < 0.1) continue;
    const onScreen = rect.bottom > box.top + 8 && rect.top < box.bottom - 8 && rect.right > box.left && rect.left < box.right;
    if (onScreen) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) continue;
    }
    const score = (onScreen ? 1000 : 0) + (parseFloat(style.fontSize) || 14);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/** Where the cursor's tip lands on a target: toward the end of its text, low in the box. */
function aimAt(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + Math.min(rect.width - 4, Math.max(12, rect.width * 0.7)), y: rect.top + rect.height * 0.72 };
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
  // Grok's cursor and the outline around what it points at. Moved by hand: they follow the voice, not React.
  const cursorRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const marked = useRef<Element | null>(null);

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

  const moveCursor = (x: number, y: number, jump = false) => {
    const el = cursorRef.current;
    if (!el) return;
    if (jump) el.style.transition = "none";
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    el.classList.add("is-on");
    if (jump) {
      void el.offsetWidth;
      el.style.transition = "";
    }
  };

  const clickCursor = () => {
    const el = cursorRef.current;
    if (!el) return;
    el.classList.remove("is-click");
    void el.offsetWidth;
    el.classList.add("is-click");
  };

  const drawMark = () => {
    const mark = markRef.current;
    const target = marked.current;
    if (!mark) return;
    if (!target || !target.isConnected) {
      mark.classList.remove("is-on");
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    // A hidden outline appears on its target and fades in; only a visible one glides to the next.
    const appearing = !mark.classList.contains("is-on");
    if (appearing) mark.style.transition = "opacity 200ms ease";
    mark.style.transform = `translate3d(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px, 0)`;
    mark.style.width = `${Math.round(r.width + pad * 2)}px`;
    mark.style.height = `${Math.round(r.height + pad * 2)}px`;
    if (appearing) {
      void mark.offsetWidth;
      mark.style.transition = "";
    }
    mark.classList.add("is-on");
  };

  const markElement = (target: Element | null) => {
    marked.current = target;
    drawMark();
  };

  const hideCursor = () => {
    cursorRef.current?.classList.remove("is-on", "is-click");
    markElement(null);
  };

  /** The cursor starts on the voice button, the first time it shows in a turn. */
  const cursorFromButton = () => {
    const el = cursorRef.current;
    if (!el || el.classList.contains("is-on")) return;
    const orb = [...document.querySelectorAll(".voice-orb")].find((b) => b.getBoundingClientRect().width > 0);
    if (!orb) return;
    const r = orb.getBoundingClientRect();
    moveCursor(r.left + r.width * 0.5, r.top + r.height * 0.6, true);
  };

  /** Point at something on the page, scrolling it into view first when it is off screen. */
  const pointAt = (turn: number, target: HTMLElement) => {
    cursorFromButton();
    const sheet = document.querySelector(".voice-sheet")?.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const off = sheet && (r.top < sheet.top + 60 || r.bottom > sheet.bottom - 120);
    const go = () => {
      if (!alive(turn) || !target.isConnected) return;
      const at = aimAt(target.getBoundingClientRect());
      moveCursor(at.x, at.y);
      markElement(target);
    };
    if (off) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(go, 420);
    } else go();
  };

  /**
   * Before a page opens, the cursor goes to its link in the sidebar and clicks it.
   * Resolves with the click point, or null when the sidebar has no link for that page.
   */
  const walkTo = (turn: number, href: string) =>
    new Promise<{ x: number; y: number } | null>((resolve) => {
      const path = new URL(href, window.location.origin).pathname;
      const link = [...document.querySelectorAll<HTMLAnchorElement>("aside a[href]")].find(
        (a) => new URL(a.href).pathname === path && a.getBoundingClientRect().width > 0,
      );
      if (!link || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        resolve(null);
        return;
      }
      cursorFromButton();
      const r = link.getBoundingClientRect();
      const at = { x: r.left + Math.min(r.width * 0.42, 80), y: r.top + r.height * 0.62 };
      requestAnimationFrame(() => moveCursor(at.x, at.y));
      window.setTimeout(() => {
        if (!alive(turn)) return resolve(null);
        markElement(link);
        clickCursor();
        window.setTimeout(() => {
          markElement(null);
          resolve(alive(turn) ? at : null);
        }, 180);
      }, 640);
    });

  const rest = () => {
    clearHide();
    setPhase("idle");
    setCaption(null);
    setAnalyser(null);
    hideCursor();
  };

  /**
   * Open Grok's page: the new sheet grows out of the voice button in a circle while the old one
   * sinks back. Without the View Transitions API, or with reduced motion, the page just opens.
   */
  const openPage = (href: string, from: { x: number; y: number } | null = null) => {
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
    // The circle grows from where Grok clicked, else from the voice button. It may start outside the sheet.
    const box = sheet.getBoundingClientRect();
    const orb = button.getBoundingClientRect();
    const x = (from ? from.x : orb.left + orb.width / 2) - box.left;
    const y = (from ? from.y : orb.top + orb.height / 2) - box.top;
    const r = Math.ceil(
      Math.max(...[[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([cx, cy]) => Math.hypot(cx! - x, cy! - y))),
    );
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
    hideCursor();
    setCaption({ who, text: message });
    setPhase("error");
    clearHide();
    hideTimer.current = window.setTimeout(() => {
      if (alive(turn) && phaseRef.current === "error") rest();
    }, ms);
  };

  const speak = async (turn: number, text: string, href: string | null) => {
    if (!alive(turn)) return;
    setPhase("speaking");
    // Grok's voice is fetched while the cursor walks to the page's link and opens it.
    const voice = fetch("/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`speak ${res.status}`);
      return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") || "audio/mpeg" };
    });
    voice.catch(() => undefined);
    // The question stays up until Grok's audio starts; then her words take over, timed to the audio.
    const onStart = (seconds: number) => {
      if (!alive(turn)) return;
      setCaption({ who: "grok", text, start: performance.now(), duration: seconds > 0 ? seconds : text.length / 14 });
    };
    try {
      if (href) {
        const there = new URL(href, window.location.origin);
        if (there.pathname + there.search !== window.location.pathname + window.location.search) {
          const from = await walkTo(turn, href);
          if (!alive(turn)) return;
          openPage(href, from);
        }
      }
      const { bytes, type } = await voice;
      if (!alive(turn)) return;
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

  // While Grok talks, the cursor goes to each ref and figure as she says it.
  useEffect(() => {
    if (caption?.who !== "grok" || caption.start == null || caption.duration == null) return;
    const turn = turnRef.current;
    const { start, duration } = caption;
    const timers: number[] = [];
    let last: Element | null = null;
    for (const word of cuesFor(caption.text).flatMap((cue) => cue.words)) {
      const token = pointToken(word.text);
      if (!token) continue;
      const due = start + word.at * duration * 1000 - performance.now() - 120;
      timers.push(
        window.setTimeout(() => {
          if (!alive(turn)) return;
          const target = findOnPage(token);
          if (!target || target === last) return;
          last = target;
          pointAt(turn, target);
        }, Math.max(0, due)),
      );
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one schedule per spoken line
  }, [caption]);

  // Speak the demo answer once ahead of time, so "Should I buy Carnaroli?" plays at once.
  useEffect(() => {
    void fetch("/api/voice/warm", { method: "POST" }).catch(() => undefined);
  }, []);

  // The outline and the cursor stay on their target when the page scrolls.
  useEffect(() => {
    const follow = () => {
      const target = marked.current;
      if (!target || target.closest("aside")) return;
      drawMark();
      const at = aimAt(target.getBoundingClientRect());
      moveCursor(at.x, at.y, true);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, []);

  return (
    <VoiceContext.Provider value={{ phase, caption, analyser, toggle }}>
      {children}
      <div ref={markRef} className="grok-mark" aria-hidden="true" />
      <div ref={cursorRef} className="grok-cursor" aria-hidden="true">
        <svg viewBox="0 0 22 24" width="22" height="24">
          <defs>
            <linearGradient id="grok-cursor-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fa7e1e" />
              <stop offset="0.55" stopColor="#d62976" />
              <stop offset="1" stopColor="#962fbf" />
            </linearGradient>
          </defs>
          <path
            d="M2 2 L2 19.5 L6.6 15.4 L9.7 22.2 L13 20.8 L9.9 14.1 L16.2 14.1 Z"
            fill="url(#grok-cursor-fill)"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        <span className="grok-cursor-tag">Grok</span>
      </div>
    </VoiceContext.Provider>
  );
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
