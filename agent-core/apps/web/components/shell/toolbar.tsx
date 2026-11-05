"use client";

/**
 * The film's toolbar, on every page: the Search capsule (orders, retailers, invoices, claims,
 * trucks; results drop down under it), the + capsule (a new question for Grok), the voice button
 * (ask Grok out loud) and the account.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/kit/icons";
import { cn } from "@/lib/utils";
import { VoiceButton } from "./voice-hold";

const GLASS =
  "bg-white/45 backdrop-blur-[26px] backdrop-saturate-[1.85] shadow-[inset_0_1.5px_0.5px_rgb(255_255_255/0.95),inset_0_0_0_1px_rgb(255_255_255/0.5),inset_0_0_0_1px_rgb(32_49_25/0.06),0_18px_40px_-18px_rgb(32_49_25/0.35),0_2px_6px_rgb(32_49_25/0.07)]";

type Hit = { label: string; sub: string; href: string };

function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const path = usePathname();

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d: { hits?: Hit[] }) => live && setHits(d.hits ?? []))
        .catch(() => live && setHits([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="relative">
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute top-[11px] left-[14px] z-10 size-[16px]" fill="none" stroke="rgb(32 49 25 / 0.72)" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="M15.5 15.5L21 21" />
      </svg>
      <input
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search"
        className={cn("h-[38px] w-[150px] rounded-full pr-3 pl-[38px] text-[15px] outline-none transition-[width] duration-300 placeholder:text-ink-78 focus:w-[220px]", GLASS)}
      />
      {open && q.trim().length >= 2 ? (
        <ul className="absolute top-11 right-0 z-40 max-h-80 w-[280px] overflow-y-auto rounded-[14px] bg-hh-seasalt p-1 shadow-[0_18px_40px_-14px_rgb(32_49_25/0.4),inset_0_0_0_1px_rgb(32_49_25/0.08)]">
          {hits.length ? (
            hits.map((h) => (
              <li key={`${h.href}|${h.label}`}>
                <Link href={h.href} className="block rounded-[10px] px-2.5 py-2 hover:bg-hh-honeydew">
                  <span className="block truncate font-bold text-[14px]">{h.label}</span>
                  <span className="block truncate text-[12px] text-ink-68">{h.sub}</span>
                </Link>
              </li>
            ))
          ) : (
            <li className="px-2.5 py-2 text-[13px] text-ink-68">Nothing found.</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function Toolbar() {
  return (
    <>
      <Search />
      <Link href="/s" title="Ask Grok" className={cn("flex size-[38px] items-center justify-center rounded-full", GLASS)}>
        <svg viewBox="0 0 24 24" className="size-[16px]" fill="none" stroke="#203119" strokeWidth="2.4" strokeLinecap="round">
          <path d="M12 5v14 M5 12h14" />
        </svg>
      </Link>
      <VoiceButton />
      <span title="Riso Scotti back office" className="flex size-[38px] items-center justify-center rounded-full bg-hh-dark shadow-[0_10px_22px_-10px_rgb(32_49_25/0.55)]">
        <BrandMark className="size-[18px]" />
      </span>
    </>
  );
}
