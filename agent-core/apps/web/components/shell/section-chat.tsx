"use client";

/**
 * A chat at the end of a section (and in the order panel): the same Grok agent and the same cards
 * as Home, with the page's subject sent along as context. The thread stays on the page, above the
 * input; it starts empty each time the page opens.
 *
 * When docked via Page `ask`, the parent caps the height. The thread scrolls inside this section
 * so the page above (stock, orders, …) stays reachable.
 */
import { interaction, interactions } from "eve/events";
import { useEveAgent } from "eve/react";
import { ArrowUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentMessage } from "@/app/_components/agent-message";
import { WEB_CHAT_AGENT } from "@/app/eve-agent";
import { ChipRail } from "@/components/kit/chip-rail";
import { cn } from "@/lib/utils";

export function SectionChat({
  placeholder,
  context,
  suggestions = [],
  className,
}: {
  readonly placeholder: string;
  /** Sent with every question so Grok knows what the person is looking at (page, order ref…). */
  readonly context: Record<string, string>;
  readonly suggestions?: string[];
  readonly className?: string;
}) {
  const [text, setText] = useState("");
  const agent = useEveAgent({ agent: WEB_CHAT_AGENT, prewarm: text.trim().length > 0 });
  const busy = agent.status === "busy";
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const count = agent.messages.length;

  // Keep the latest turn in view inside the chat list — not the page behind it.
  useEffect(() => {
    if (!count) return;
    const list = listRef.current;
    const end = endRef.current;
    if (!list || !end) return;
    end.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [count]);

  const send = (q: string) => {
    const t = q.trim();
    if (!t || busy) return;
    setText("");
    void agent.send(t, { clientContext: context });
  };

  const canRespond = (id: string) => interaction(agent.view, id)?.status === "open";
  const questionsFor = (callId: string) =>
    interactions(agent.view).filter((i) => i.request.kind === "question" && i.call?.callId === callId);
  const last = agent.messages.at(-1);
  const thinking = busy && (last?.role !== "assistant" || last.parts.length === 0);
  const hasThread = count > 0;

  return (
    <section
      className={cn(
        "flex flex-col",
        hasThread ? "min-h-0 flex-1" : "border-hairline border-t pt-6",
        // Inline embeds (order panel, claim panel) have no Page dock: cap them too.
        hasThread && "max-h-[min(55vh,560px)]",
        className,
      )}
    >
      {hasThread ? (
        <div className="relative mb-3 min-h-0 flex-1">
          <div
            ref={listRef}
            className="h-full space-y-5 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
          >
            {agent.messages.map((m) =>
              m.role === "assistant" && m.parts.length === 0 ? null : (
                <div key={m.id} className="hh-rise">
                  <AgentMessage
                    message={m}
                    view={agent.view}
                    canRespond={canRespond}
                    questionsFor={questionsFor}
                    onAnswers={async (answers) => {
                      await agent.respond(answers).catch(() => {});
                    }}
                  />
                </div>
              ),
            )}
            {thinking ? (
              <p className="hh-rise shimmer w-fit text-[14px] text-ink-68">Grok is looking at the records…</p>
            ) : null}
            <div ref={endRef} />
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-9 bg-gradient-to-b from-hh-seasalt from-30% to-transparent backdrop-blur-[2px]"
          />
        </div>
      ) : suggestions.length ? (
        <div className="mb-3">
          <ChipRail items={suggestions} onPick={send} />
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        className="flex shrink-0 items-end gap-2 rounded-[18px] bg-white p-2 pl-4 shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1),0_10px_30px_-20px_rgb(32_49_25/0.35)]"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-ink-68"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="Ask Grok"
          className="flex size-[36px] shrink-0 items-center justify-center rounded-full bg-hh-dark text-hh-honeydew transition-opacity disabled:opacity-35"
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </form>
    </section>
  );
}
