"use client";

/**
 * The question chips above a Grok input. One line that never wraps or gets cut: when the chips
 * fit they sit still; when they don't, they glide slowly to the left in a loop (paused on hover
 * or focus) and fade out at both edges, so nothing ends in a hard cut.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const CHIP =
  "shrink-0 whitespace-nowrap rounded-full bg-white px-3.5 py-1.5 text-[14px] text-ink-78 shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1),0_4px_10px_-7px_rgb(32_49_25/0.4)] transition-colors hover:bg-hh-honeydew hover:text-ink";

const FADE = "linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 56px), transparent)";

export function ChipRail({ items, onPick, className }: { readonly items: readonly string[]; readonly onPick: (q: string) => void; readonly className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const set = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const w = set.current?.scrollWidth ?? 0;
      const room = box.current?.clientWidth ?? 0;
      setOverflow(w > room + 1 ? w : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    if (set.current) ro.observe(set.current);
    return () => ro.disconnect();
  }, [items]);

  if (!items.length) return null;
  const moving = overflow > 0;
  const chips = (hidden: boolean) =>
    items.map((t) => (
      <button key={t} type="button" tabIndex={hidden ? -1 : undefined} aria-hidden={hidden || undefined} onClick={() => onPick(t)} className={CHIP}>
        {t}
      </button>
    ));

  return (
    <div
      ref={box}
      className={cn("group/rail relative overflow-hidden pt-1 pb-2.5", className)}
      style={moving ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
    >
      <div
        className={cn("flex w-max", moving && "hh-marquee group-hover/rail:[animation-play-state:paused] group-focus-within/rail:[animation-play-state:paused]")}
        style={moving ? { animationDuration: `${Math.round(overflow / 28)}s` } : undefined}
      >
        <div ref={set} className={cn("flex gap-2", moving && "pr-2")}>
          {chips(false)}
        </div>
        {moving ? <div className="flex gap-2 pr-2">{chips(true)}</div> : null}
      </div>
    </div>
  );
}
