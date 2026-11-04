/** Sidebar icons and the B.R.C leaf tile, drawn exactly as in HeyHandy/videos/brc-banner (one line weight, round joins). */
import type { SVGProps } from "react";

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

export function BrandTile({ size = 26 }: { readonly size?: number }) {
  return (
    <span className="relative inline-block shrink-0 rounded-[7px] bg-hh-dark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 28 28" className="absolute" style={{ left: size * 0.2, top: size * 0.2, width: size * 0.6, height: size * 0.6 }}>
        <ellipse cx="14" cy="14" rx="6.2" ry="11" transform="rotate(32 14 14)" fill="#eef3e8" />
        <path d="M9.5 21.5C12 16 15.5 10.5 19 6.5" stroke="#203119" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
    </span>
  );
}

/** xAI / Grokbot mark (black sphere with specular pills). Shown next to cases Grokbot touched. */
export function GrokbotIcon({ size = 16, title = "Grokbot" }: { readonly size?: number; readonly title?: string }) {
  return (
    <img
      src="/assets/grokbot.png"
      alt=""
      title={title}
      width={size}
      height={size}
      className="inline-block shrink-0 rounded-full align-middle"
      style={{ width: size, height: size }}
    />
  );
}
