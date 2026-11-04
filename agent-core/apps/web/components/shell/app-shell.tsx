"use client";

/**
 * The app window from the HeyHandy UI kit (brand/UI.md): a window tint, a glass sidebar inset
 * 12 px with the B.R.C x Grok lockup, nav items with a selection that glides between them, the
 * sign-off badge, the retailer list, and the Seasalt content sheet beside it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  BrandTile,
  DisputesIcon,
  ForecastIcon,
  OrdersIcon,
  OverviewIcon,
  ShippingIcon,
  SignoffIcon,
  StockIcon,
} from "@/components/kit/icons";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: OverviewIcon, match: (p: string) => p === "/" || p === "/s" || p.startsWith("/s/") },
  { href: "/orders", label: "Orders", icon: OrdersIcon },
  { href: "/shipping", label: "Shipping", icon: ShippingIcon },
  { href: "/disputes", label: "Disputes", icon: DisputesIcon },
  { href: "/signoff", label: "Sign-off Pending", icon: SignoffIcon, badge: true },
  { href: "/stock", label: "Stock", icon: StockIcon },
  { href: "/forecast", label: "Paddy prices", icon: ForecastIcon },
] as const;

// Retailer dots in the banner's order: Flex Green, Opal, a warm note, a quiet grey-green.
const DOTS = ["#bfff80", "#9fc6bf", "#f2c46b", "#a2b9a2", "#d7e4e0"];

type ShellData = { pending: number; retailers: { gln: string; name: string }[] };

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
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [path]);

  const active = NAV.findIndex((n) => ("match" in n ? n.match(path) : path.startsWith(n.href)));

  return (
    <div className="flex h-dvh gap-2 bg-hh-window p-2 max-md:flex-col">
      <aside className="relative flex w-[200px] shrink-0 flex-col rounded-[16px] bg-hh-sidebar px-2.5 pt-4 pb-3 shadow-[inset_0_0_0_1px_rgb(32_49_25/0.05)] max-md:w-full max-md:flex-row max-md:items-center max-md:gap-2 max-md:overflow-x-auto max-md:px-2 max-md:py-2">
        <Link href="/" className="mb-5 flex items-center gap-2 px-2 font-bold text-[17px] tracking-[-0.03em] max-md:mb-0 max-md:shrink-0">
          <BrandTile />
          <span className="max-md:hidden">B.R.C x Grok</span>
        </Link>

        <nav className="flex flex-col gap-0.5 max-md:flex-row">
          {NAV.map((n, i) => {
            const Icon = n.icon;
            const on = i === active;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "relative flex h-[34px] items-center gap-2.5 rounded-[10px] px-2 text-[15px] tracking-[-0.015em] transition-[background,box-shadow] duration-300 ease-in-out-kit max-md:shrink-0",
                  on
                    ? "bg-hh-selection shadow-[0_1px_2px_rgb(32_49_25/0.1),0_4px_12px_-4px_rgb(32_49_25/0.16)]"
                    : "hover:bg-hh-selection/50",
                )}
              >
                <Icon className="size-[17px] shrink-0" />
                <span>{n.label}</span>
                {"badge" in n && data.pending > 0 ? (
                  <span className="ml-auto flex h-[19px] min-w-[21px] items-center justify-center rounded-full bg-[#e8a23a] px-1.5 font-bold text-[11px] text-white">
                    {data.pending}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        {data.retailers.length ? (
          <div className="mt-7 max-md:hidden">
            <div className="mb-2 px-2 text-[12px] text-ink-78">Retailers</div>
            <ul className="flex flex-col gap-1.5">
              {data.retailers.map((r, i) => (
                <li key={r.gln}>
                  <Link href={`/orders?retailer=${encodeURIComponent(r.gln)}`} className="flex items-center gap-2 px-2 text-[14px] hover:underline">
                    <i
                      className="block size-[7px] shrink-0 rounded-full"
                      style={{ background: DOTS[i % DOTS.length], boxShadow: i === 0 ? "inset 0 0 0 1px rgb(32 49 25 / 0.25)" : undefined }}
                    />
                    <span className="truncate">{r.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-auto flex items-center gap-2 px-2 pt-4 max-md:hidden">
          <span className="flex size-[30px] items-center justify-center rounded-full bg-hh-dark font-bold text-[11px] text-hh-window">RS</span>
          <span className="text-[12px] leading-tight text-ink-68">
            Riso Scotti
            <br />
            back office
          </span>
        </div>
      </aside>

      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-[16px] bg-hh-seasalt shadow-[inset_0_0_0_1px_rgb(32_49_25/0.06),0_10px_30px_-18px_rgb(32_49_25/0.25)]">
        {children}
      </main>
    </div>
  );
}

/** A scrolling page inside the content sheet. */
export function Page({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-[1180px] space-y-5 px-6 py-6", className)}>{children}</div>
    </div>
  );
}
