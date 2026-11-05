"use client";

/**
 * What happened to an order, one line per step (agent/lib/order/story.ts): the Grok bot for what
 * Grok did, the person's face for what a person decided (with their words), the retailer's logo
 * for what the retailer sent, a small dot for what code did on its own.
 */
import type { StoryStep } from "@agent/lib/order/story";
import { personFor } from "@/components/kit";
import { GrokMark } from "@/components/kit/icons";
import { RetailerLogo } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";

function Who({ s }: { readonly s: StoryStep }) {
  if (s.who === "grok") return <GrokMark size={26} title="Grok" />;
  if (s.who === "retailer") return <RetailerLogo name={s.name} size={26} />;
  if (s.who === "person") {
    const p = personFor(s.role ? `${s.name}, ${s.role}` : s.name);
    return p ? (
      // biome-ignore lint/performance/noImgElement: tiny local portrait
      <img src={p.photo} alt={p.name} className="size-[26px] shrink-0 rounded-full object-cover ring-1 ring-hairline" />
    ) : (
      <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-hh-honeydew font-bold text-[11px]">{s.name.slice(0, 1)}</span>
    );
  }
  return <span className="flex size-[26px] shrink-0 items-center justify-center"><i className="block size-[7px] rounded-full bg-hh-dark/35" /></span>;
}

export function StoryList({ steps, onlyKey }: { readonly steps: readonly StoryStep[]; readonly onlyKey?: boolean }) {
  const shown = onlyKey ? steps.filter((s) => s.key || s.who === "retailer") : steps;
  return (
    <ol className="relative">
      {shown.map((s, i) => (
        <li key={`${i}-${s.text}`} className="relative flex gap-3 pb-3.5 last:pb-0">
          {i < shown.length - 1 ? <span aria-hidden className="absolute top-[30px] bottom-[2px] left-[12.5px] w-px bg-hh-dark/[0.12]" /> : null}
          <span className="relative z-[1] mt-[-2px] shrink-0 rounded-full bg-hh-seasalt">
            <Who s={s} />
          </span>
          <span className="min-w-0 flex-1 text-[14px] leading-snug">
            <span className={cn(s.who === "code" ? "text-ink-68" : "text-ink", s.key && "font-bold")}>{s.text}</span>
            {s.quote ? <span className="mt-0.5 block text-[13px] text-ink-68 italic">“{s.quote}”</span> : null}
            {s.options?.length ? (
              <span className="mt-1 block space-y-0.5 text-[13px] text-ink-68">
                {s.options.map((o, j) => (
                  <span key={o} className="flex gap-1.5">
                    <b className="shrink-0 font-bold text-ink">{String.fromCharCode(65 + j)}.</b>
                    <span>{o}</span>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
