/**
 * Vendored from https://github.com/Bhavya-Dhoot/threeway (MIT) — src/threeway/core.py,
 * ported to TypeScript from `dispute/_threeway_core.py`.
 *
 * Pure reconciliation logic, kept free of I/O so the matching/status rules can be
 * unit tested without touching the filesystem and reused by any future front end.
 *
 * MIT License
 *
 * Copyright (c) 2026 Bhavya Dhoot
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Port notes:
 * - Python uses `Decimal` for exact arithmetic. The app has no decimal library, so the
 *   arithmetic runs on a small exact decimal (`Dec`, BigInt mantissa) inside this module.
 *   The public interface takes and returns plain numbers; comparisons against tolerances
 *   are exact, as in Python.
 * - Dates are ISO strings (`YYYY-MM-DD`) or null.
 * - Field names are camelCase (`poNumber`, `itemCode`, ...).
 */

// ---------------------------------------------------------------------------
// Exact decimal (value = m * 10^-e)
// ---------------------------------------------------------------------------

class Dec {
  constructor(
    readonly m: bigint,
    readonly e: number,
  ) {}

  static of(v: Dec | number | string | bigint): Dec {
    if (v instanceof Dec) return v;
    if (typeof v === "bigint") return new Dec(v, 0);
    const s = String(v).trim();
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
      throw new Error(`Invalid decimal: ${s}`);
    }
    const [, sign, intPart, fracPart = "", expPart] = match;
    let mant = BigInt((intPart || "0") + fracPart);
    if (sign === "-") mant = -mant;
    let e = fracPart.length - (expPart ? Number(expPart) : 0);
    if (e < 0) {
      mant = mant * 10n ** BigInt(-e);
      e = 0;
    }
    return new Dec(mant, e);
  }

  private static align(a: Dec, b: Dec): [bigint, bigint, number] {
    if (a.e === b.e) return [a.m, b.m, a.e];
    if (a.e > b.e) return [a.m, b.m * 10n ** BigInt(a.e - b.e), a.e];
    return [a.m * 10n ** BigInt(b.e - a.e), b.m, b.e];
  }

  add(o: Dec): Dec {
    const [x, y, e] = Dec.align(this, o);
    return new Dec(x + y, e);
  }
  sub(o: Dec): Dec {
    const [x, y, e] = Dec.align(this, o);
    return new Dec(x - y, e);
  }
  mul(o: Dec): Dec {
    return new Dec(this.m * o.m, this.e + o.e);
  }
  /** Divide by a power of ten (the only division threeway does: `/ Decimal(100)`). */
  divPow10(n: number): Dec {
    return new Dec(this.m, this.e + n);
  }
  abs(): Dec {
    return this.m < 0n ? new Dec(-this.m, this.e) : this;
  }
  cmp(o: Dec): number {
    const [x, y] = Dec.align(this, o);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  lt(o: Dec): boolean {
    return this.cmp(o) < 0;
  }
  le(o: Dec): boolean {
    return this.cmp(o) <= 0;
  }
  gt(o: Dec): boolean {
    return this.cmp(o) > 0;
  }
  eq(o: Dec): boolean {
    return this.cmp(o) === 0;
  }
  toNumber(): number {
    if (this.e === 0) return Number(this.m);
    const neg = this.m < 0n;
    let digits = (neg ? -this.m : this.m).toString().padStart(this.e + 1, "0");
    digits = `${digits.slice(0, digits.length - this.e)}.${digits.slice(digits.length - this.e)}`;
    return Number((neg ? "-" : "") + digits);
  }
}

const ZERO = Dec.of(0);

// ---------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------

export type Key = [string, string];
export type UomFactor = number | string;
export type UomRule = [string | null, UomFactor | null];
/** User-supplied uom map: `{ global: {UNIT: {unit, factor}}, items: {ITEM: {UNIT: {unit, factor}}} }`. */
export type UomMap = Record<string, unknown>;

interface NormUomMap {
  global_: Record<string, UomRule>;
  items: Record<string, Record<string, UomRule>>;
}

export const DEFAULT_QTY_TOLERANCE = 2;
export const DEFAULT_VALUE_TOLERANCE = 1.0;
export const DEFAULT_PCT_TOLERANCE = 0.5;
export const DEFAULT_CUTOFF_DAYS = 0;

export const ORPHAN_REASON = "Receipt or invoice with no matching purchase order line";
export const UOM_MISMATCH_REASON = "Units differ and no conversion rule applies";
export const TIMING_REASON = "Timing difference within the cut-off window";

/**
 * One parsed row. `price` is null/undefined when the source column was blank, which is
 * meaningful (e.g. no invoice price recorded yet). `uom` and `date` are optional extras.
 */
export interface RawLine {
  poNumber: string;
  itemCode: string;
  quantity: number | string;
  price?: number | string | null;
  uom?: string | null;
  /** ISO date `YYYY-MM-DD`. */
  date?: string | null;
}

export interface LineResult {
  poNumber: string;
  itemCode: string;
  ordered: number;
  poPrice: number;
  received: number;
  invoiced: number;
  invoicePrice: number;
  expectedValue: number;
  invoicedValue: number;
  qtyVariance: number;
  valueVariance: number;
  status: string;
  reason: string;
  uom: string | null;
  uomConversionApplied: boolean;
  poDate: string | null;
  receivedDate: string | null;
  invoiceDate: string | null;
  timingGapDays: number | null;
}

export interface ReconcileResult {
  lines: LineResult[];
  warnings: string[];
  asOf: string | null;
  cutoffDays: number;
}

export interface ReconcileOptions {
  qtyTolerance?: number | string;
  valueTolerance?: number | string;
  pctTolerance?: number | string;
  uomMap?: UomMap | null;
  asOf?: string | null;
  cutoffDays?: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function keyOf(poNumber: string, itemCode: string): string {
  return JSON.stringify([poNumber.trim().toUpperCase(), itemCode.trim().toUpperCase()]);
}

function lastNonNull<T>(current: T | null | undefined, next: T | null | undefined): T | null {
  return next !== null && next !== undefined ? next : (current ?? null);
}

function _aggregatePo(poRows: RawLine[]) {
  const totals = new Map<string, [Dec, Dec | null]>();
  const uoms = new Map<string, string | null>();
  const dates = new Map<string, string | null>();
  const counts = new Map<string, number>();
  const warnings: string[] = [];
  for (const row of poRows) {
    const key = keyOf(row.poNumber, row.itemCode);
    let [ordered, price] = totals.get(key) ?? [ZERO, null];
    ordered = ordered.add(Dec.of(row.quantity));
    if (row.price !== null && row.price !== undefined) price = Dec.of(row.price);
    totals.set(key, [ordered, price]);
    uoms.set(key, lastNonNull(uoms.get(key), row.uom));
    dates.set(key, lastNonNull(dates.get(key), row.date));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      const [po, item] = JSON.parse(key) as Key;
      warnings.push(`Duplicate PO line for ${po}/${item}: quantities summed, using last price`);
    }
  }
  return { totals, uoms, dates, warnings };
}

function _aggregateQty(rows: RawLine[]) {
  const totals = new Map<string, Dec>();
  const uoms = new Map<string, string | null>();
  const dates = new Map<string, string | null>();
  for (const row of rows) {
    const key = keyOf(row.poNumber, row.itemCode);
    totals.set(key, (totals.get(key) ?? ZERO).add(Dec.of(row.quantity)));
    uoms.set(key, lastNonNull(uoms.get(key), row.uom));
    dates.set(key, lastNonNull(dates.get(key), row.date));
  }
  return { totals, uoms, dates };
}

function _aggregateQtyAndPrice(rows: RawLine[]) {
  const totals = new Map<string, Dec>();
  const prices = new Map<string, Dec>();
  const uoms = new Map<string, string | null>();
  const dates = new Map<string, string | null>();
  for (const row of rows) {
    const key = keyOf(row.poNumber, row.itemCode);
    totals.set(key, (totals.get(key) ?? ZERO).add(Dec.of(row.quantity)));
    if (row.price !== null && row.price !== undefined) prices.set(key, Dec.of(row.price));
    uoms.set(key, lastNonNull(uoms.get(key), row.uom));
    dates.set(key, lastNonNull(dates.get(key), row.date));
  }
  return { totals, prices, uoms, dates };
}

/** Drop rows dated after `asOf`. A row with no date has nothing to filter on and is kept. */
function _filterAsOf(rows: RawLine[], asOf: string | null): RawLine[] {
  if (asOf === null) return rows;
  return rows.filter((row) => row.date === null || row.date === undefined || row.date <= asOf);
}

function _normalizeUnit(unit: string | null | undefined): string | null {
  if (unit === null || unit === undefined) return null;
  const cleaned = unit.trim();
  return cleaned ? cleaned.toUpperCase() : null;
}

function _normalizeUomMap(uomMap: UomMap | null | undefined): NormUomMap {
  const normRules = (rules: unknown): Record<string, UomRule> => {
    const out: Record<string, UomRule> = {};
    const mapping = (rules || {}) as Record<string, unknown>;
    for (const [unit, rule] of Object.entries(mapping)) {
      const normUnit = _normalizeUnit(unit);
      if (normUnit === null || typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
      const r = rule as Record<string, unknown>;
      out[normUnit] = [(r.unit as string | undefined) ?? null, (r.factor as UomFactor | undefined) ?? null];
    }
    return out;
  };

  if (!uomMap || Object.keys(uomMap).length === 0) return { global_: {}, items: {} };
  const globalRules = normRules(uomMap.global);
  const items: Record<string, Record<string, UomRule>> = {};
  for (const [itemCode, rules] of Object.entries((uomMap.items || {}) as Record<string, unknown>)) {
    items[itemCode.trim().toUpperCase()] = normRules(rules);
  }
  return { global_: globalRules, items };
}

function _uomRule(normMap: NormUomMap, itemCode: string, unit: string | null): UomRule | null {
  const normUnit = _normalizeUnit(unit);
  if (normUnit === null) return null;
  const itemRules = normMap.items[itemCode.trim().toUpperCase()] ?? {};
  if (normUnit in itemRules) return itemRules[normUnit];
  return normMap.global_[normUnit] ?? null;
}

function _convertToBase(
  quantity: Dec,
  sourceUom: string | null,
  baseUom: string | null,
  itemCode: string,
  normMap: NormUomMap,
): [Dec, boolean, boolean] {
  const normSource = _normalizeUnit(sourceUom);
  const normBase = _normalizeUnit(baseUom);
  if (normSource === null || normBase === null || normSource === normBase) return [quantity, false, true];
  const rule = _uomRule(normMap, itemCode, sourceUom);
  if (rule === null) return [quantity, false, false];
  const [targetUnit, factor] = rule;
  if (_normalizeUnit(targetUnit) !== normBase || factor === null) return [quantity, false, false];
  return [quantity.mul(Dec.of(factor)), true, true];
}

/**
 * Pick which of the three files' units is the base. Two documents agreeing outvote the
 * third; a three-way tie or a lone unit falls back to PO, then GRN, then invoice.
 */
function _baseUom(poUom: string | null, grnUom: string | null, invoiceUom: string | null): string | null {
  const candidates = [poUom, grnUom, invoiceUom].filter((u): u is string => u !== null && u !== undefined);
  if (candidates.length === 0) return null;
  const counts = new Map<string | null, number>();
  for (const uom of candidates) {
    const norm = _normalizeUnit(uom);
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  const best = Math.max(...counts.values());
  for (const uom of candidates) {
    if (counts.get(_normalizeUnit(uom)) === best) return uom;
  }
  return candidates[0];
}

function _gapDays(first: string | null, second: string | null): number | null {
  if (first === null || second === null) return null;
  const a = Date.parse(`${first.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${second.slice(0, 10)}T00:00:00Z`);
  return Math.abs(Math.round((a - b) / 86_400_000));
}

function _evaluate(
  ordered: Dec,
  poPrice: Dec,
  received: Dec,
  invoiced: Dec,
  invoicePrice: Dec,
  qtyTolerance: Dec,
  valueTolerance: Dec,
  pctTolerance: Dec,
  orphan: boolean,
): [string, string, Dec, Dec, Dec, Dec] {
  const expectedValue = received.mul(poPrice);
  const invoicedValue = invoiced.mul(invoicePrice);
  const qtyVariance = invoiced.sub(received);
  const valueVariance = invoicedValue.sub(expectedValue);

  if (orphan) return ["exception", ORPHAN_REASON, expectedValue, invoicedValue, qtyVariance, valueVariance];

  let status: string;
  if (received.eq(ZERO) && invoiced.eq(ZERO)) status = "not_started";
  else if (qtyVariance.abs().le(qtyTolerance) && valueVariance.abs().le(valueTolerance)) status = "matched";
  else if (
    qtyVariance.abs().le(qtyTolerance.mul(Dec.of(2))) &&
    valueVariance.abs().le(valueTolerance.mul(Dec.of(3)))
  )
    status = "check";
  else status = "exception";

  let reason: string;
  if (status === "matched") reason = "";
  else if (received.eq(ZERO) && invoiced.gt(ZERO)) reason = "Invoiced but nothing received";
  else if (received.eq(ZERO) && invoiced.eq(ZERO)) reason = "No receipt and no invoice yet";
  else if (invoiced.gt(received)) reason = "Billed for more than was received";
  else if (received.gt(ordered)) reason = "Received more than was ordered";
  else if (received.lt(ordered)) reason = "Short delivery against the order";
  else if (invoicePrice.sub(poPrice).abs().gt(poPrice.mul(pctTolerance).divPow10(2)))
    reason = "Invoice price differs from the PO price";
  else reason = "Value gap with matching quantities";

  return [status, reason, expectedValue, invoicedValue, qtyVariance, valueVariance];
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

export function reconcile(
  poRows: RawLine[],
  grnRows: RawLine[],
  invoiceRows: RawLine[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const qtyTolerance = Dec.of(options.qtyTolerance ?? DEFAULT_QTY_TOLERANCE);
  const valueTolerance = Dec.of(options.valueTolerance ?? "1.00");
  const pctTolerance = Dec.of(options.pctTolerance ?? DEFAULT_PCT_TOLERANCE);
  const asOf = options.asOf ?? null;
  const cutoffDays = options.cutoffDays ?? DEFAULT_CUTOFF_DAYS;

  poRows = _filterAsOf(poRows, asOf);
  grnRows = _filterAsOf(grnRows, asOf);
  invoiceRows = _filterAsOf(invoiceRows, asOf);

  const po = _aggregatePo(poRows);
  const grn = _aggregateQty(grnRows);
  const inv = _aggregateQtyAndPrice(invoiceRows);
  const normMap = _normalizeUomMap(options.uomMap);

  const allKeys = new Set<string>([...po.totals.keys(), ...grn.totals.keys(), ...inv.totals.keys()]);

  const lines: LineResult[] = [];
  for (const key of allKeys) {
    const [poNumber, itemCode] = JSON.parse(key) as Key;
    const orphan = !po.totals.has(key);
    let ordered: Dec;
    let poPrice: Dec;
    if (orphan) {
      ordered = ZERO;
      poPrice = ZERO;
    } else {
      const [o, rawPrice] = po.totals.get(key)!;
      ordered = o;
      poPrice = rawPrice ?? ZERO;
    }
    let received = grn.totals.get(key) ?? ZERO;
    let invoiced = inv.totals.get(key) ?? ZERO;
    const invoicePrice = inv.prices.get(key) ?? ZERO;

    const poUom = po.uoms.get(key) ?? null;
    const grnUom = grn.uoms.get(key) ?? null;
    const invoiceUom = inv.uoms.get(key) ?? null;
    const baseUom = _baseUom(poUom, grnUom, invoiceUom);

    const poDate = po.dates.get(key) ?? null;
    const receivedDate = grn.dates.get(key) ?? null;
    const invoiceDate = inv.dates.get(key) ?? null;

    let uomConversionApplied = false;
    let uomCovered = true;
    let applied: boolean;
    let covered: boolean;

    [ordered, applied, covered] = _convertToBase(ordered, poUom, baseUom, itemCode, normMap);
    uomConversionApplied ||= applied;
    uomCovered &&= covered;
    [received, applied, covered] = _convertToBase(received, grnUom, baseUom, itemCode, normMap);
    uomConversionApplied ||= applied;
    uomCovered &&= covered;
    [invoiced, applied, covered] = _convertToBase(invoiced, invoiceUom, baseUom, itemCode, normMap);
    uomConversionApplied ||= applied;
    uomCovered &&= covered;

    let [status, reason, expectedValue, invoicedValue, qtyVariance, valueVariance] = _evaluate(
      ordered,
      poPrice,
      received,
      invoiced,
      invoicePrice,
      qtyTolerance,
      valueTolerance,
      pctTolerance,
      orphan,
    );

    const timingGapDays = _gapDays(receivedDate, invoiceDate);

    if (orphan) {
      // orphan reason from _evaluate always wins - checked first.
    } else if (!uomCovered) {
      status = "exception";
      reason = UOM_MISMATCH_REASON;
    } else if (status === "exception" && timingGapDays !== null && timingGapDays > 0 && timingGapDays <= cutoffDays) {
      status = "check";
      reason = TIMING_REASON;
    }

    lines.push({
      poNumber,
      itemCode,
      ordered: ordered.toNumber(),
      poPrice: poPrice.toNumber(),
      received: received.toNumber(),
      invoiced: invoiced.toNumber(),
      invoicePrice: invoicePrice.toNumber(),
      expectedValue: expectedValue.toNumber(),
      invoicedValue: invoicedValue.toNumber(),
      qtyVariance: qtyVariance.toNumber(),
      valueVariance: valueVariance.toNumber(),
      status,
      reason,
      uom: baseUom,
      uomConversionApplied,
      poDate,
      receivedDate,
      invoiceDate,
      timingGapDays,
    });
  }

  lines.sort((a, b) =>
    a.poNumber < b.poNumber ? -1 : a.poNumber > b.poNumber ? 1 : a.itemCode < b.itemCode ? -1 : a.itemCode > b.itemCode ? 1 : 0,
  );
  return { lines, warnings: po.warnings, asOf, cutoffDays };
}
