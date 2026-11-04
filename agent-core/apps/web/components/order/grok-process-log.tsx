"use client";

/**
 * Side chatbot-style icon: a message bubble with the Grokbot mark. Opens a process log of
 * Order steps (parse fixes, qty gates, price, confirm) so the person can follow what code
 * and Grok did without leaving Orders / Sign-off Pending.
 */
import { useCallback, useEffect, useState } from "react";
import { BrandTile } from "@/components/kit/icons";
import { cn } from "@/lib/utils";

type LogEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  subjectRef: string | null;
  text: string;
};

export function GrokProcessLog() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    fetch("/api/orders/process-log?limit=40")
      .then((r) => r.json())
      .then((d: { entries?: LogEntry[] }) => {
        const next = d.entries ?? [];
        setEntries((prev) => {
          if (open) return next;
          if (prev.length && next[0]?.id !== prev[0]?.id) setUnread((u) => u + 1);
          return next;
        });
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Open Grokbot process log"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed right-5 bottom-5 z-40 flex size-12 items-center justify-center rounded-full bg-hh-dark text-hh-window shadow-[0_8px_24px_-8px_rgb(32_49_25/0.45)] transition hover:scale-[1.03]",
          open && "ring-2 ring-hh-asparagus ring-offset-2 ring-offset-hh-seasalt",
        )}
      >
        <span className="relative">
          <BrandTile size={22} />
          <span className="pointer-events-none absolute -top-1 -right-1.5 size-2.5 rounded-full bg-[#bfff80] shadow-[0_0_0_2px_rgb(32_49_25)]" />
        </span>
        {unread > 0 && !open ? (
          <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#e8a23a] px-1 font-bold text-[10px] text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <aside className="fixed right-5 bottom-20 z-40 flex h-[min(520px,70vh)] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-[16px] bg-hh-seasalt shadow-[0_16px_40px_-16px_rgb(32_49_25/0.45),inset_0_0_0_1px_rgb(32_49_25/0.08)]">
          <header className="flex items-center gap-2 border-hairline border-b px-3.5 py-3">
            <BrandTile size={22} />
            <div className="min-w-0 flex-1">
              <div className="font-bold text-[14px] tracking-[-0.02em]">Grokbot log</div>
              <div className="text-[11px] text-ink-68">Order process: code checks, Grok fixes, human gates</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-68 hover:text-ink">
              Close
            </button>
          </header>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
            {!entries.length ? (
              <p className="px-1 py-6 text-center text-[13px] text-ink-68">
                Nothing yet. Run the order simulation or receive an ORDERS message.
              </p>
            ) : (
              entries.map((e) => {
                const fromGrok = e.actor === "grok";
                const fromPerson = e.actor === "person" || e.actor.startsWith("person:");
                return (
                  <div
                    key={e.id}
                    className={cn(
                      "max-w-[92%] rounded-[14px] px-3 py-2 text-[12.5px] leading-snug",
                      fromGrok
                        ? "ml-auto bg-hh-dark text-hh-window"
                        : fromPerson
                          ? "bg-hh-honeydew text-ink"
                          : "bg-[rgb(32_49_25/0.06)] text-ink",
                    )}
                  >
                    <div className={cn("mb-0.5 text-[10.5px] uppercase tracking-[0.04em]", fromGrok ? "text-hh-window/70" : "text-ink-68")}>
                      {fromGrok ? "Grokbot" : fromPerson ? "Person" : "Code"}
                      {e.subjectRef ? ` · ${e.subjectRef}` : ""}
                      {" · "}
                      {e.at.slice(11, 19)}
                    </div>
                    <div>{e.text}</div>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      ) : null}
    </>
  );
}
