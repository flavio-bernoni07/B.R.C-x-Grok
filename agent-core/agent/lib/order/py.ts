/**
 * Python string formatting the Order row relies on, so EDI bodies, mails, reasons and audit
 * text come out exactly as the Python code writes them (`f"{x}"`, `f"{x:g}"`, `repr(...)`).
 */

/** `str(x)` of a Python float: 2.5 -> "2.5", 10000.0 -> "10000.0", None -> "None". */
export function pyFloat(v: number | null | undefined): string {
  if (v == null) return "None";
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  return String(v);
}

/** `str(x)` for a value that is an int or a string in Python. */
export function pyStr(v: unknown): string {
  if (v == null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python `format(x, "g")`: six significant digits, no trailing zeros. */
export function pyG(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mant, expStr] = x.toExponential(5).split("e");
  const exp = Number(expStr);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 6) {
    const sign = exp < 0 ? "-" : "+";
    return `${strip(mant)}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return strip(x.toFixed(Math.max(5 - exp, 0)));
}

/** Python `repr` of simple JSON-like values (used only inside prompts). */
export function pyRepr(v: unknown): string {
  if (v == null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), `\\${q}`).replace(/\n/g, "\\n") + q;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
      .join(", ")}}`;
  }
  return String(v);
}

/** Python `float(s)`: returns null where Python raises ValueError. */
export function pyParseFloat(s: string): number | null {
  const t = s.trim().replace(/_/g, "");
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return Number.NaN;
  return null;
}
