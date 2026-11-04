/**
 * Python number formatting, so documents, explanations and audit details read exactly as the
 * Python row writes them (`f"{x:g}"`, `f"{x:.2f}"`, `round(x, n)`, `str(float)`), plus the
 * money rounding of `shipping/documents.py` (Decimal, ROUND_HALF_UP).
 */

/** Exact decimal digits of a double (toFixed with many places is exact for the binary value). */
function exactDigits(x: number, places: number): string {
  return Math.abs(x).toFixed(Math.min(100, places));
}

/** Python `round(x, n)`: correctly rounded, ties to even. */
export function pyRound(x: number, n = 0): number {
  return Number(pyFixed(x, n));
}

/** Python `f"{x:.{n}f}"`: correctly rounded from the binary value, ties to even. */
export function pyFixed(x: number, n = 2): string {
  if (!Number.isFinite(x)) return String(x);
  const full = exactDigits(x, n + 40);
  const [intPart, frac] = full.split(".");
  const keep = frac.slice(0, n);
  const rest = frac.slice(n);
  let digits = BigInt(intPart + keep);
  const half = "5" + "0".repeat(rest.length - 1);
  if (rest > half) digits += 1n;
  else if (rest === half && digits % 2n === 1n) digits += 1n;
  let s = digits.toString().padStart(n + 1, "0");
  if (n > 0) s = `${s.slice(0, s.length - n)}.${s.slice(s.length - n)}`;
  const negative = x < 0 && /[1-9]/.test(s);
  return (negative ? "-" : "") + s;
}

/** Python `f"{x:g}"`: 6 significant digits, trailing zeros dropped, exponent outside 1e-4..1e6. */
export function pyG(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mant, expStr] = x.toExponential(5).split("e");
  const exp = Number(expStr);
  if (exp < -4 || exp >= 6) {
    const m = mant.replace(/\.?0+$/, "");
    return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = x.toFixed(Math.max(0, 5 - exp));
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Python `str(float)`: `15.0` for whole numbers. */
export function pyFloatStr(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** `_qty` in documents.py: an integer without decimals, otherwise as written. */
export function qtyStr(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

// ---------------------------------------------------------------------------
// Decimal money (Decimal(str(value)).quantize(0.01, ROUND_HALF_UP))
// ---------------------------------------------------------------------------

/** A small exact decimal: value = m / 10^e. */
export class Money {
  constructor(
    readonly m: bigint,
    readonly e: number,
  ) {}

  static of(v: number | string | Money): Money {
    if (v instanceof Money) return v;
    const s = typeof v === "number" ? String(v) : v.trim();
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!match) throw new Error(`Invalid decimal: ${s}`);
    const [, sign, intPart, frac = "", exp] = match;
    let m = BigInt((intPart || "0") + frac);
    if (sign === "-") m = -m;
    let e = frac.length - (exp ? Number(exp) : 0);
    if (e < 0) {
      m *= 10n ** BigInt(-e);
      e = 0;
    }
    return new Money(m, e);
  }

  private static align(a: Money, b: Money): [bigint, bigint, number] {
    if (a.e === b.e) return [a.m, b.m, a.e];
    if (a.e > b.e) return [a.m, b.m * 10n ** BigInt(a.e - b.e), a.e];
    return [a.m * 10n ** BigInt(b.e - a.e), b.m, b.e];
  }

  add(o: Money): Money {
    const [x, y, e] = Money.align(this, o);
    return new Money(x + y, e);
  }
  sub(o: Money): Money {
    const [x, y, e] = Money.align(this, o);
    return new Money(x - y, e);
  }
  mul(o: Money): Money {
    return new Money(this.m * o.m, this.e + o.e);
  }
  divPow10(n: number): Money {
    return new Money(this.m, this.e + n);
  }
  eq(o: Money): boolean {
    const [x, y] = Money.align(this, o);
    return x === y;
  }

  /** Quantize to `places` decimals, ROUND_HALF_UP (away from zero on a tie). */
  quantize(places: number): Money {
    if (this.e === places) return this;
    if (this.e < places) return new Money(this.m * 10n ** BigInt(places - this.e), places);
    const div = 10n ** BigInt(this.e - places);
    const neg = this.m < 0n;
    const abs = neg ? -this.m : this.m;
    let q = abs / div;
    if ((abs % div) * 2n >= div) q += 1n;
    return new Money(neg ? -q : q, places);
  }

  /** Python Decimal.__str__ for the values we write (no exponent form). */
  toString(): string {
    const neg = this.m < 0n;
    const abs = (neg ? -this.m : this.m).toString();
    if (this.e === 0) return (neg ? "-" : "") + abs;
    const padded = abs.padStart(this.e + 1, "0");
    return `${neg ? "-" : ""}${padded.slice(0, padded.length - this.e)}.${padded.slice(padded.length - this.e)}`;
  }

  toNumber(): number {
    return Number(this.toString());
  }
}

/** `money()` in documents.py: Decimal(str(value)) rounded half-up to cents. */
export function money(value: number | string | Money): Money {
  return Money.of(value).quantize(2);
}
