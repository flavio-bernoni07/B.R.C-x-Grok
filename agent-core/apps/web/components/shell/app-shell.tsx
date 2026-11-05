"use client";

/**
 * The app window from the HeyHandy UI kit (brand/UI.md): a window tint, a glass sidebar inset
 * 12 px with the B.R.C x Grok lockup, nav items with a selection that glides between them, the
 * sign-off badge, the retailer list, and the Seasalt content sheet beside it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { BrandTile, DisputesIcon, OrdersIcon, OverviewIcon, ShippingIcon, SignoffIcon, StockIcon } from "@/components/kit/icons";
import { cn } from "@/lib/utils";
import { VoiceProvider, VoiceSubtitles } from "./voice-hold";

const NAV = [
  { href: "/", label: "Home", icon: OverviewIcon, match: (p: string) => p === "/" || p === "/s" || p.startsWith("/s/") },
  { href: "/orders", label: "Orders", icon: OrdersIcon },
  { href: "/shipping", label: "Shipping", icon: ShippingIcon },
  { href: "/stock", label: "Stock", icon: StockIcon },
  { href: "/disputes", label: "Disputes", icon: DisputesIcon },
  { href: "/signoff", label: "Sign-off", icon: SignoffIcon, badge: true },
] as const;

// Retailer dots in the banner's order: Flex Green, Opal, a warm note, a quiet grey-green.
const DOTS = ["#bfff80", "#9fc6bf", "#bfff80", "#a2b9a2", "#d7e4e0"];

type ShellData = { pending: number; retailers: { gln: string; name: string; orders?: number }[] };

export function AppShell({ children }: { readonly children: ReactNode }) {
  const path = usePathname();
  const [data, setData] = useState<ShellData>({ pending: 0, retailers: [] });

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/shell")
        .then((r) => r.json())
        .then((d: ShellData) => live && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    const onChange = () => load();
    window.addEventListener("brc:changed", onChange);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener("brc:changed", onChange);
    };
  }, [path]);

  const active = NAV.findIndex((n) => ("match" in n ? n.match(path) : path.startsWith(n.href)));

  return (
    <VoiceProvider>
    <div className="flex h-dvh gap-2.5 bg-hh-window p-2.5 max-md:flex-col">
      <aside className="relative flex w-[230px] shrink-0 flex-col overflow-hidden rounded-[18px] bg-hh-sidebar px-3 pt-7 pb-4 shadow-[inset_0_0_0_1px_rgb(32_49_25/0.05)] max-md:w-full max-md:flex-row max-md:items-center max-md:gap-2 max-md:overflow-x-auto max-md:px-2 max-md:py-2">
        <Link href="/" className="mb-8 flex items-center gap-2.5 px-2.5 font-bold text-[19px] tracking-[-0.03em] max-md:mb-0 max-md:shrink-0">
          <BrandTile size={30} />
          <span className="max-md:hidden">B.R.C x Grok</span>
        </Link>

        <nav className="relative flex flex-col gap-1 max-md:flex-row">
          {active >= 0 ? (
            <span
              aria-hidden
              className="absolute right-0 left-0 h-[40px] rounded-[12px] bg-hh-selection shadow-[0_1px_2px_rgb(32_49_25/0.1),0_4px_12px_-4px_rgb(32_49_25/0.16)] transition-[top] duration-[450ms] max-md:hidden"
              style={{ top: active * 44, transitionTimingFunction: "cubic-bezier(0.77, 0, 0.175, 1)" }}
            />
          ) : null}
          {NAV.map((n, i) => {
            const Icon = n.icon;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "relative z-10 flex h-[40px] items-center gap-3 rounded-[12px] px-2.5 text-[17px] tracking-[-0.015em] transition-colors max-md:shrink-0",
                  i !== active && "hover:bg-hh-selection/40",
                )}
              >
                <Icon className="size-[19px] shrink-0" />
                <span>{n.label}</span>
                {"badge" in n && data.pending > 0 ? (
                  <span className="ml-auto flex h-[21px] min-w-[23px] items-center justify-center rounded-full bg-st-pending px-1.5 font-bold text-[13px] text-st-pending-ink tabular-nums">{data.pending}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        {data.retailers.length ? (
          <div className="mt-9 flex min-h-0 flex-1 flex-col max-md:hidden">
            <div className="mb-2.5 px-2.5 text-[13px] text-ink-78">Retailers</div>
            <ul className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-2 [scrollbar-width:none]">
              {data.retailers.map((r, i) => (
                <li key={r.gln}>
                  <Link href={`/orders?retailer=${encodeURIComponent(r.name)}`} className="flex h-[32px] items-center gap-2.5 rounded-[10px] px-2.5 text-[16px] transition-colors hover:bg-hh-selection/40">
                    <RetailerLogo name={r.name} dot={DOTS[i % DOTS.length]} />
                    <span className="truncate">{r.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>

      <main className="voice-sheet relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-[18px] bg-hh-seasalt shadow-[inset_0_0_0_1px_rgb(32_49_25/0.06),0_10px_30px_-18px_rgb(32_49_25/0.25)]">
        {children}
        <VoiceSubtitles />
      </main>
    </div>
    </VoiceProvider>
  );
}

/** The retailer's logo (public/retailers/<brand>.png), or its dot until the file exists. */
export function RetailerLogo({ name, dot, size = 20 }: { readonly name: string; readonly dot?: string; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const slug = name.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
  if (failed)
    return (
      <span className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <i className="block size-[8px] rounded-full" style={{ background: dot ?? "#cfe2cf" }} />
      </span>
    );
  return (
    // biome-ignore lint/performance/noImgElement: a 20 px local icon, no optimisation needed
    <img
      src={`/retailers/${slug}.png`}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-[6px] bg-white object-contain shadow-[0_0_0_1px_rgb(32_49_25/0.08)]"
      style={{ width: size, height: size }}
    />
  );
}

/** Tell the shell (badge) and other views that a decision changed the records. */
export const announceChange = () => window.dispatchEvent(new Event("brc:changed"));

/** A scrolling page inside the content sheet. */
export function Page({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-[1280px] space-y-8 px-9 pt-8 pb-16", className)}>{children}</div>
    </div>
  );
}
