/**
 * The HeyHandy UI kit as React components (HeyHandy/brand/UI.md, tokens.ts `ui`), scaled from the
 * 1920 px film canvas to a desktop app (about 0.55x). Every page and every chat card uses these,
 * so the agent's widgets and the pages look the same.
 *
 * Pills, per UI.md:
 *   ok        soft success: confirmed, sent, credit note        (client screen state)
 *   live      Flex Green: the one positive state that should shout
 *   grok      Strong (Dark Green): the system acted on its own, e.g. "Grok: fixed"
 *   attention amber: a person has to act                        (client screen state)
 *   wait      grey-green: checking, not decided yet
 *   quiet     Honeydew: shortlisted, informational
 *   pending   light red: mail/hold waiting on retailer
 *   reject    red: rejected
 */
import type React from "react";
import type { ReactNode } from "react";
import { GrokMark } from "@/components/kit/icons";
import { Toolbar } from "@/components/shell/toolbar";
import { cn } from "@/lib/utils";

export type PillTone = "ok" | "live" | "grok" | "attention" | "wait" | "quiet" | "pending" | "reject";

/**
 * Pill states. No dark fills (Flavio, 5 Nov: "I don't like a darker background, change the number
 * colour"; "red is a bad alert signal"): a person must act = the pending yellow; Grok acted = ink on Honeydew.
 */
const PILL: Record<PillTone, string> = {
  ok: "bg-hh-flex text-hh-dark font-bold shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)]",
  live: "bg-hh-flex text-hh-dark font-bold shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)]",
  grok: "bg-hh-honeydew text-hh-dark font-bold shadow-[inset_0_0_0_1px_rgb(32_49_25/0.12)]",
  attention: "bg-st-pending text-st-pending-ink font-bold",
  wait: "bg-hh-honeydew text-ink-68",
  quiet: "bg-hh-honeydew text-ink-68",
  pending: "bg-st-pending text-st-pending-ink font-bold",
  reject: "bg-st-reject text-st-reject-ink font-bold",
};

export function Pill({ tone, children, className }: { readonly tone: PillTone; readonly children: ReactNode; readonly className?: string }) {
  return (
    <span className={cn("inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[14px] leading-none", PILL[tone], className)}>
      {children}
    </span>
  );
}

/** A small red ✗ beside a wrong answer (UI.md: never a fill). */
export const WrongMark = () => <span className="ml-1.5 font-bold text-st-wrong">✗</span>;

/**
 * A chat card's frame: a quiet white sheet with a hairline. Pages don't use it; they use Section,
 * which has no frame at all (the sheet is already the frame).
 */
export function Panel({
  title,
  aside,
  children,
  className,
}: {
  readonly title?: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("w-full rounded-[14px] bg-white/70 p-4 ring-1 ring-hairline", className)}>
      {title || aside ? (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          {title ? <h3 className="font-bold text-[15px] tracking-[-0.02em]">{title}</h3> : <span />}
          {aside ? <div className="text-[12px] text-ink-68">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A page section: a short bold heading, an optional aside on the right, then the content. No frame. */
export function Section({
  title,
  aside,
  children,
  className,
  id,
}: {
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) {
  return (
    <section id={id} className={cn("scroll-mt-6", className)}>
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-bold text-[17px] tracking-[-0.025em]">{title}</h2>
        {aside ? <div className="flex items-center gap-3 text-[13px] text-ink-68">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** A number on the sheet: label, value, a short note. No tile. */
export function Stat({ label, value, hint, className }: { readonly label: ReactNode; readonly value: ReactNode; readonly hint?: ReactNode; readonly className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[12px] text-ink-68">{label}</div>
      <div className="mt-0.5 font-bold text-[26px] tabular-nums leading-tight tracking-[-0.035em]">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[12px] text-ink-68">{hint}</div> : null}
    </div>
  );
}

/** The glass capsule of the toolbar (UI.md "Glass capsule"): white 30% over blur, bright rim, soft lift. */
export const GLASS =
  "bg-white/45 backdrop-blur-[26px] backdrop-saturate-[1.85] shadow-[inset_0_1.5px_0.5px_rgb(255_255_255/0.95),inset_0_0_0_1px_rgb(255_255_255/0.5),inset_0_0_0_1px_rgb(32_49_25/0.06),0_18px_40px_-18px_rgb(32_49_25/0.35),0_2px_6px_rgb(32_49_25/0.07)]";

/** A chart or map card (the launch film's Results page): Seasalt, a 1.5 px rim, a bold title and a legend on the right. */
export function Card({ title, aside, children, className }: { readonly title?: ReactNode; readonly aside?: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  return (
    <section className={cn("rounded-[16px] bg-hh-seasalt p-5 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]", className)}>
      {title || aside ? (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="font-bold text-[17px] tracking-[-0.02em]">{title}</h2> : <span />}
          {aside ? <div className="flex items-center gap-3 text-[13px] text-ink-78">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** A legend dot and label, as in the film's charts. */
export const Legend = ({ color, children }: { readonly color: string; readonly children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
    <i className="block size-[9px] rounded-full" style={{ background: color }} />
    {children}
  </span>
);

/** A KPI card (the film's "Lower CPA 29% ›"): label, one big number, a chevron when it leads somewhere. */
/**
 * Kpi tones: every card stays white; only the number takes the colour. Plain for a count; strong
 * (red) for the one figure that asks for a person; good (lime) for money saved or a quantity to make.
 */
const BOX = "bg-hh-seasalt shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)] hover:bg-white";
const KPI_TONE = {
  plain: { box: BOX, label: "text-ink-78", value: "", sub: "text-ink-68", chev: "text-ink-50" },
  strong: { box: BOX, label: "text-ink-78", value: "text-hh-lime", sub: "text-ink-68", chev: "text-ink-50" },
  good: { box: BOX, label: "text-ink-78", value: "text-hh-lime", sub: "text-ink-68", chev: "text-ink-50" },
} as const;

export function Kpi({
  label,
  value,
  sub,
  tone = "plain",
  size = "md",
  onClick,
  href,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** A short line under the number, e.g. "was 7". */
  readonly sub?: ReactNode;
  readonly tone?: keyof typeof KPI_TONE;
  /** `sm` is the home strip: a shorter card, so the desk underneath keeps its room. */
  readonly size?: "md" | "sm";
  readonly onClick?: () => void;
  readonly href?: string;
}) {
  const t = KPI_TONE[tone];
  const sm = size === "sm";
  const body = (
    <>
      <span className={cn("block truncate", sm ? "text-[12px]" : "text-[13px]", t.label)}>{label}</span>
      <b className={cn("block font-bold tabular-nums leading-none tracking-[-0.03em]", sm ? "mt-0.5 text-[22px]" : "mt-1 text-[28px]", t.value)}>{value}</b>
      {sub ? <span className={cn("block truncate text-[13px] tabular-nums", sm ? "mt-1" : "mt-1.5", t.sub)}>{sub}</span> : null}
      {onClick || href ? <span className={cn("absolute text-[16px]", sm ? "top-2 right-3" : "top-3 right-4", t.chev)}>›</span> : null}
    </>
  );
  const cls = cn("relative block min-w-0 text-left transition-colors", sm ? "rounded-[12px] px-3 pt-2 pb-2" : "rounded-[14px] px-4 pt-3 pb-3.5", t.box);
  if (href)
    return (
      <a href={href} className={cls}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}

/** A panel that slides in from the right edge of the sheet (UI.md: panels from an edge). */
export function Drawer({ open, onClose, children }: { readonly open: boolean; readonly onClose: () => void; readonly children: ReactNode }) {
  return (
    <>
      <div
        onClick={onClose}
        className={cn("absolute inset-0 z-20 bg-hh-dark/[0.06] transition-opacity duration-300", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <aside
        className={cn(
          "absolute top-0 right-0 bottom-0 z-30 w-[min(620px,92%)] overflow-y-auto rounded-l-[22px] bg-hh-seasalt shadow-[-1px_0_0_rgb(32_49_25/0.06),-24px_0_60px_-30px_rgb(32_49_25/0.45)] transition-transform duration-500",
          open ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
        style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
      >
        <button type="button" onClick={onClose} aria-label="Close" className={cn("absolute top-5 right-5 z-10 flex size-[36px] items-center justify-center rounded-full text-[18px] text-ink-78", GLASS)}>
          ×
        </button>
        {children}
      </aside>
    </>
  );
}

export type MeterTone = "ink" | "ok" | "attention" | "wrong" | "flex";
const METER: Record<MeterTone, string> = {
  ink: "bg-hh-dark",
  ok: "bg-hh-asparagus",
  attention: "bg-hh-flex",
  wrong: "bg-st-wrong",
  flex: "bg-hh-flex",
};

/** A thin fill bar: how full a truck is, how much cover is left. */
export function Meter({ value, max, tone = "ink", className, label }: { readonly value: number; readonly max: number; readonly tone?: MeterTone; readonly className?: string; readonly label?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cn("h-[6px] w-full overflow-hidden rounded-full bg-hh-dark/[0.07]", className)} role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out-kit", METER[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export type OwnerKind = "agent" | "person" | "team" | "retailer" | "none";

/**
 * The people behind each desk (demo staff; portraits from randomuser.me, saved in public/people).
 * The data names roles ("Order desk", "Giulia, order desk"); the UI shows the person.
 */
export const PEOPLE: Record<string, { readonly name: string; readonly photo: string }> = {
  "order desk": { name: "Giulia Ferri", photo: "/people/giulia.jpg" },
  "credit desk": { name: "Marco Bellini", photo: "/people/marco.jpg" },
  "account manager": { name: "Chiara Moretti", photo: "/people/chiara.jpg" },
  "warehouse lead": { name: "Luca Galli", photo: "/people/luca.jpg" },
  warehouse: { name: "Luca Galli", photo: "/people/luca.jpg" },
  "transport planner": { name: "Davide Conti", photo: "/people/davide.jpg" },
  purchasing: { name: "Elena Rinaldi", photo: "/people/elena.jpg" },
  "production planner": { name: "Paolo Greco", photo: "/people/paolo.jpg" },
};

/** "Order desk", "Giulia, order desk" or "Giulia" → the person, or undefined for a name we don't know. */
export function personFor(name: string) {
  const key = name.toLowerCase().trim();
  const role = key.includes(",") ? key.split(",").pop()?.trim() ?? key : key;
  if (PEOPLE[role]) return { ...PEOPLE[role], role: role.replace(/^./, (s) => s.toUpperCase()) };
  const first = key.split(/[\s,]+/)[0];
  const hit = Object.entries(PEOPLE).find(([, p]) => p.name.toLowerCase().startsWith(`${first} `));
  return hit ? { ...hit[1], role: hit[0].replace(/^./, (s) => s.toUpperCase()) } : undefined;
}

/** Who has it: agents get the Grok bot; a person or team shows the face of who is on it; a retailer is quiet. */
export function Avatar({ kind, name, size = 22 }: { readonly kind: OwnerKind; readonly name: string; readonly size?: number }) {
  const initials = name
    .replace(/,.*$/, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (kind === "agent") return <GrokMark size={size} title={`${name}: Grok and code`} />;
  const person = kind === "person" || kind === "team" ? personFor(name) : undefined;
  if (person)
    return (
      // biome-ignore lint/performance/noImgElement: tiny local portrait, no need for next/image
      <img src={person.photo} alt={person.name} width={size} height={size} className="shrink-0 rounded-full object-cover ring-1 ring-hairline" style={style} />
    );
  if (kind === "person")
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-hh-dark font-bold text-hh-honeydew" style={style}>
        {initials}
      </span>
    );
  if (kind === "team")
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-hh-mint font-bold text-ink" style={style}>
        {initials}
      </span>
    );
  if (kind === "retailer")
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-hh-honeydew font-bold text-ink-78 ring-1 ring-hairline" style={style}>
        {initials}
      </span>
    );
  return <span className="inline-flex shrink-0 rounded-full bg-hh-mint ring-1 ring-hairline" style={style} />;
}

/** "On it" label: avatar, name, and what they are doing. */
export function Owner({ kind, name, doing, compact }: { readonly kind: OwnerKind; readonly name: string; readonly doing?: string; readonly compact?: boolean }) {
  const person = kind === "person" ? personFor(name) : undefined;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar kind={kind} name={name} size={compact ? 18 : 22} />
      <span className={cn("truncate", compact ? "text-[12px]" : "text-[13px]")}>
        <span className="font-bold">{kind === "none" ? "Done" : kind === "agent" ? "Grok" : person ? person.name.split(" ")[0] : name}</span>
        {kind === "agent" ? <span className="text-ink-68"> · {name}</span> : person ? <span className="text-ink-68"> · {person.role}</span> : null}
        {doing && kind !== "none" ? <span className="text-ink-68"> · {doing}</span> : null}
      </span>
    </span>
  );
}

const BTN = {
  primary: "bg-hh-dark text-hh-window font-bold hover:bg-hh-dark/90",
  quiet: "bg-hh-dark/[0.06] text-ink font-bold hover:bg-hh-dark/[0.1]",
  outline: "bg-white text-ink font-bold ring-1 ring-hairline hover:bg-hh-honeydew",
} as const;

/** The kit button: a pill. Primary for the one action on a view, quiet for the rest. */
export function Btn({
  children,
  variant = "primary",
  className,
  ...rest
}: { readonly children: ReactNode; readonly variant?: keyof typeof BTN } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn("inline-flex h-[34px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-40", BTN[variant], className)}
    >
      {children}
    </button>
  );
}

export type Column<T> = {
  key: string;
  header: string;
  /** Main cell: bold, full ink. */
  main?: boolean;
  align?: "left" | "right";
  width?: string;
  cell: (row: T) => ReactNode;
};

/** A kit table: header in light ink, rows separated by a hairline, no boxes. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty = "Nothing here yet.",
}: {
  readonly columns: Column<T>[];
  readonly rows: T[];
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly selectedKey?: string;
  readonly empty?: ReactNode;
}) {
  if (!rows.length) return <p className="py-6 text-center text-[14px] text-ink-68">{empty}</p>;
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-left [&_tbody_tr+tr_td]:border-hairline [&_tbody_tr+tr_td]:border-t">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn("whitespace-nowrap pr-6 pb-2 font-medium text-[13px] text-ink-68 first:pl-3 last:pr-3", c.align === "right" && "text-right")}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r);
            return (
              <tr
                key={k}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn(
                  "",
                  onRowClick && "cursor-pointer transition-colors hover:bg-white",
                  selectedKey === k && "bg-white",
                )}
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      "h-[60px] whitespace-nowrap pr-6 text-[15px] tabular-nums first:rounded-l-[12px] first:pl-3 last:rounded-r-[12px] last:pr-3",
                      c.main ? "font-bold text-[16px] text-ink tracking-[-0.02em]" : "text-ink-68",
                      c.align === "right" && "text-right",
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The glass segmented control (the film's 7d / 30d / 90d). Options can carry a count. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  readonly options: { value: T; label: string; count?: number }[];
  readonly value: T;
  readonly onChange: (v: T) => void;
}) {
  return (
    <div className={cn("inline-flex h-[38px] items-center gap-0.5 rounded-full p-[4px]", GLASS)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-[30px] whitespace-nowrap rounded-full px-3.5 text-[14px] transition-colors duration-300",
            o.value === value ? "bg-hh-dark font-bold text-hh-honeydew" : "text-ink-78 hover:text-ink",
          )}
        >
          {o.label}
          {o.count != null ? <span className="ml-1.5 tabular-nums">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Page header (the film's sheet): a 30 px bold title; on the right the page's capsules, Search, + and the account. */
export function PageHeader({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
  return (
    <header className="flex min-h-[40px] flex-wrap items-center justify-between gap-3">
      <h1 className="font-bold text-[30px] leading-none tracking-[-0.035em]">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Toolbar />
      </div>
    </header>
  );
}

/** A document you can download: the file chip used under orders, claims and cases. */
export function DocLink({ href, kind, label, className }: { readonly href: string; readonly kind: string; readonly label?: string | null; readonly className?: string }) {
  return (
    <a
      href={href}
      download
      className={cn(
        "inline-flex h-[34px] max-w-full items-center gap-2 rounded-[10px] bg-white px-3 text-[13px] shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)] transition-colors hover:bg-hh-honeydew",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="size-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15 M10 9v5.5 M7.5 12l2.5 2.5 2.5-2.5" />
      </svg>
      <b className="shrink-0">{kind}</b>
      {label ? <span className="truncate text-ink-68">{label}</span> : null}
    </a>
  );
}

/** A source citation: every number links to the document it came from. */
export function SourceTag({ children, title }: { readonly children: ReactNode; readonly title?: string }) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-hh-honeydew px-1.5 py-0.5 font-medium text-[11px] text-ink-78">
      {children}
    </span>
  );
}

/** Key/value list used in detail cards. */
export function Facts({ items }: { readonly items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-68">{k}</dt>
          <dd className="min-w-0 text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const eur = (v: number | null | undefined, digits = 2) =>
  v == null ? "–" : `€${v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const qty = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-GB", { maximumFractionDigits: 2 }));

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "–";
