export const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "–" : `€${v.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;

export const pct = (v: number | null | undefined) =>
  v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;

export const trendClass = (v: number | null | undefined) =>
  v == null || Math.abs(v) < 0.05
    ? "text-muted-foreground"
    : v > 0
      ? "text-[var(--rice-up)]"
      : "text-[var(--rice-down)]";

export const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
