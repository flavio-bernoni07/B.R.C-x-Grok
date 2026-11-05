/** Sidebar icons and the Risolve mark, drawn exactly as in HeyHandy/videos/brc-banner (one line weight, round joins). */
import { RISOLVE_MARK } from "./brand-mark";
import { useId, type SVGProps } from "react";

const base = { viewBox: "0 0 28 28", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
type P = SVGProps<SVGSVGElement>;

export const OverviewIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="4" y="4" width="8" height="8" rx="2.5" />
    <rect x="16" y="4" width="8" height="8" rx="2.5" />
    <rect x="4" y="16" width="8" height="8" rx="2.5" />
    <rect x="16" y="16" width="8" height="8" rx="2.5" />
  </svg>
);

export const OrdersIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M7 4h11l4 4v16H7z M18 4v4h4 M11 13h7 M11 17.5h7" />
  </svg>
);

export const ShippingIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 8h13v11H3z M16 12h5l4 4v3h-9z" />
    <circle cx="8" cy="21" r="2.4" fill="var(--color-hh-sidebar)" />
    <circle cx="20" cy="21" r="2.4" fill="var(--color-hh-sidebar)" />
  </svg>
);

export const DisputesIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 6h18v12H12l-5 4v-4H5z" />
    <path d="M14 9.5v4 M14 15.8v.2" strokeWidth={2.4} />
  </svg>
);

export const SignoffIcon = (p: P) => (
  <svg {...base} strokeWidth={2.6} {...p}>
    <path d="M5.5 14.5l5.5 5.5L22.5 8" />
  </svg>
);

/** From the launch CRM's Results page: the rising line. */
export const ForecastIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3.5 21l7-7 4.5 4.5 9-10 M17.5 8.5H24V15" />
  </svg>
);

/** From the launch CRM: bars. */
export const StockIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 23V13 M11 23V6 M17 23v-8 M23 23V9" />
  </svg>
);

/**
 * The Risolve mark. Light (#eef3e8) by default, for dark grounds such as the toolbar's Dark Green dot;
 * pass fill="#203119" on light grounds.
 */
export function BrandMark({ className, fill = "#eef3e8" }: { readonly className?: string; readonly fill?: string }) {
  return (
    <svg viewBox="0 0 1377 1545" className={className} aria-hidden>
      <g transform="translate(-80.37 1619.85) scale(1 -1)" fill={fill}>
        <path d={RISOLVE_MARK} />
      </g>
    </svg>
  );
}

/** The sidebar lockup's mark: Dark Green on the light sidebar, no tile. */
export function BrandTile({ size = 26 }: { readonly size?: number }) {
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <BrandMark className="size-full" fill="#203119" />
    </span>
  );
}

/**
 * The Grok bot (the hackathon's mark, pavia.grokbot.it/icon.svg): a white face with two slanted
 * eyes, drawn as a glossy sphere on a black disc. Shown wherever Grok acted or suggests something.
 */
export function GrokMark({ size = 16, className, title = "Handled by Grok" }: { readonly size?: number; readonly className?: string; readonly title?: string }) {
  // One gradient id per mark. A shared id makes every face after the first paint as an empty disc.
  const face = `grokbot-face-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`shrink-0 ${className ?? ""}`} role="img" aria-label={title}>
      <title>{title}</title>
      <defs>
        <radialGradient id={face} cx="34%" cy="28%" r="78%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#f1f3f5" />
          <stop offset="1" stopColor="#aab1ba" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill="#0a0a0a" />
      <circle cx="50" cy="50" r="40" fill={`url(#${face})`} />
      <ellipse cx="34" cy="28" rx="11" ry="5.5" transform="rotate(-32 34 28)" fill="#fff" opacity="0.85" />
      <ellipse cx="41" cy="48" rx="5.6" ry="10" transform="rotate(-12 41 48)" fill="#0a0a0a" />
      <ellipse cx="60" cy="45" rx="5.6" ry="10" transform="rotate(-12 60 45)" fill="#0a0a0a" />
    </svg>
  );
}

/** Same mark, the name the order desk already uses. */
export function GrokbotIcon({ size = 16, title = "Grokbot" }: { readonly size?: number; readonly title?: string }) {
  return <GrokMark size={size} title={title} />;
}
