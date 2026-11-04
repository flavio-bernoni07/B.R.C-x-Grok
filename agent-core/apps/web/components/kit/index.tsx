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
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PillTone = "ok" | "live" | "grok" | "attention" | "wait" | "quiet";

const PILL: Record<PillTone, string> = {
  ok: "bg-st-ok text-st-ok-ink font-bold",
  live: "bg-hh-flex text-hh-dark font-bold shadow-[inset_0_0_0_1px_rgb(32_49_25/0.1)]",
  grok: "bg-hh-dark text-hh-window font-bold",
  attention: "bg-st-attention text-st-attention-ink font-bold",
  wait: "bg-st-wait text-st-wait-ink",
  quiet: "bg-hh-honeydew text-ink-68",
};

export function Pill({ tone, children, className }: { readonly tone: PillTone; readonly children: ReactNode; readonly className?: string }) {
  return (
    <span className={cn("inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] leading-none", PILL[tone], className)}>
      {children}
    </span>
  );
}

/** A small red ✗ beside a wrong answer (UI.md: never a fill). */
export const WrongMark = () => <span className="ml-1.5 font-bold text-st-wrong">✗</span>;

/** The content sheet: Seasalt, rounded, a faint Dark Green rim. */
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
    <section className={cn("w-full rounded-[14px] bg-hh-seasalt p-4 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]", className)}>
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

/** A KPI tile (the `ps` stat from the launch CRM). */
export function Stat({ label, value, hint, className }: { readonly label: string; readonly value: ReactNode; readonly hint?: ReactNode; readonly className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-[12px] bg-hh-seasalt px-3.5 py-2.5 shadow-[inset_0_0_0_1.5px_rgb(32_49_25/0.09)]", className)}>
      <div className="truncate text-[12px] text-ink-78">{label}</div>
      <div className="mt-0.5 font-bold text-[24px] tabular-nums leading-tight tracking-[-0.03em]">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[12px] text-ink-68">{hint}</div> : null}
    </div>
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
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn("whitespace-nowrap pr-5 pb-2 font-medium text-[12px] text-ink-68 last:pr-0", c.align === "right" && "text-right")}
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
                  "border-hairline border-t first:border-t-0",
                  onRowClick && "cursor-pointer transition-colors hover:bg-hh-honeydew/60",
                  selectedKey === k && "bg-hh-honeydew",
                )}
              >
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={cn(
                      "h-[50px] whitespace-nowrap pr-5 text-[14px] tabular-nums last:pr-0",
                      c.main ? "font-bold text-ink tracking-[-0.02em]" : "text-ink-78",
                      c.align === "right" && "text-right",
                      i === 0 && "pl-0",
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

/** The glass segmented control (Today / Week / Month). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  readonly options: { value: T; label: string }[];
  readonly value: T;
  readonly onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-[34px] items-center gap-0.5 rounded-full bg-white/85 p-1 shadow-[inset_0_1.5px_0.5px_rgb(255_255_255/0.95),inset_0_0_0_1px_rgb(32_49_25/0.07),0_10px_26px_-16px_rgb(32_49_25/0.35),0_2px_6px_rgb(32_49_25/0.06)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-[26px] rounded-full px-3 text-[13px] transition-colors",
            o.value === value ? "bg-hh-dark font-bold text-hh-window" : "text-ink-68 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Page header inside the content sheet: a 26 px bold title and toolbar capsules. */
export function PageHeader({ title, sub, children }: { readonly title: string; readonly sub?: ReactNode; readonly children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-bold text-[26px] tracking-[-0.035em]">{title}</h1>
        {sub ? <p className="mt-0.5 text-[13px] text-ink-68">{sub}</p> : null}
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </header>
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
