/**
 * Parse EDIFACT-like ORDERS messages into structured fields + parse_flags (port of order/parser.py).
 *
 * Handles noisy whitespace/indent. Ambiguous quantities (IT thousands vs decimals) and missing
 * required segments raise flags for Grokbot: they do not silently pass.
 *
 * The data objects keep the Python field names (snake_case): they are what `to_dict` returned
 * and what the sign-off proposals store.
 */
import { readFileSync } from "node:fs";
import { pyParseFloat } from "./py";

export const REQUIRED_SEGMENTS = ["BGM", "DTM", "NAD+BY", "NAD+SU", "LIN", "QTY"] as const;

export type ParseFlag = { code: string; message: string; segment: string | null };

export type OrderLine = {
  line_no: number | null;
  gtin: string | null;
  quantity: number | null;
  quantity_raw: string | null;
  unit_price: number | null;
  unit_price_raw: string | null;
};

export type ParsedOrder = {
  order_number: string | null;
  order_date: string | null; // YYYYMMDD when clear
  buyer_gln: string | null;
  supplier_gln: string | null;
  lines: OrderLine[];
  message_type: string | null;
};

export type ParseResultDict = { ok: boolean; order: ParsedOrder; flags: ParseFlag[]; normalized_edi: string };

const flag = (code: string, message: string, segment: string | null = null): ParseFlag => ({ code, message, segment });

export class ParseResult {
  constructor(
    readonly order: ParsedOrder,
    readonly flags: ParseFlag[],
    readonly normalized_edi: string,
    readonly raw_edi: string,
  ) {}

  get ok(): boolean {
    return this.flags.length === 0;
  }

  toDict(): ParseResultDict {
    return {
      ok: this.ok,
      order: { ...this.order, lines: this.order.lines.map((l) => ({ ...l })) },
      flags: this.flags.map((f) => ({ ...f })),
      normalized_edi: this.normalized_edi,
    };
  }
}

export function loadEdiFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** Python str.splitlines() separators. */
const LINE_BREAKS = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");

/** Strip indent/blank lines; keep segment terminators. */
export function normalizeEdiText(raw: string): string {
  const parts = raw
    .split(LINE_BREAKS)
    .map((l) => l.trim())
    .filter(Boolean);
  // Re-join already-stripped segments with nothing between (EDIFACT continuous)
  return parts.join("");
}

function splitSegments(normalized: string): string[] {
  return normalized
    .split("'")
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Parse QTY value; flag Italian-style thousands vs ambiguous dots. */
function parseQuantityToken(token: string): [number | null, ParseFlag[]] {
  const flags: ParseFlag[] = [];
  const raw = token.trim();
  if (!raw) {
    flags.push(flag("qty_empty", "Empty quantity value", "QTY"));
    return [null, flags];
  }

  // Plain integer / decimal with dot as decimal separator and no thousands
  if (/^\d+$/.test(raw)) return [Number(raw), flags];
  if (/^\d+\.\d{1,2}$/.test(raw)) return [Number(raw), flags];
  if (/^\d+,\d{1,2}$/.test(raw)) return [Number(raw.replace(",", ".")), flags];

  // Italian thousands: 20.000 or 20.000,50
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) {
    flags.push(
      flag("qty_ambiguous_it_thousands", `Quantity '${raw}' looks like IT thousands grouping; needs Grokbot confirm`, "QTY"),
    );
    let normalized = raw.replace(/\./g, "");
    if (normalized.includes(",")) normalized = normalized.replace(/,/g, ".");
    const v = pyParseFloat(normalized);
    if (v == null) {
      flags.push(flag("qty_unparseable", `Cannot parse quantity '${raw}'`, "QTY"));
      return [null, flags];
    }
    return [v, flags];
  }

  // Ambiguous single-dot with 3 fractional digits: could be 20.000 units
  if (/^\d+\.\d{3}$/.test(raw)) {
    flags.push(flag("qty_ambiguous_dot", `Quantity '${raw}' has three digits after dot (thousands vs decimal?)`, "QTY"));
    // Prefer thousands interpretation for ORDERS demo volumes, but still flag
    return [pyParseFloat(raw.replace(/\./g, "")), flags];
  }

  flags.push(flag("qty_unparseable", `Unrecognized quantity format '${raw}'`, "QTY"));
  return [null, flags];
}

function parsePriceToken(token: string): [number | null, ParseFlag[]] {
  const v = pyParseFloat(token.trim().replace(/,/g, "."));
  if (v == null) return [null, [flag("pri_unparseable", `Unrecognized price '${token}'`, "PRI")]];
  return [v, []];
}

const elements = (segment: string) => segment.split("+");

export function parseOrdersEdi(raw: string): ParseResult {
  const flags: ParseFlag[] = [];
  const normalized = normalizeEdiText(raw);
  const segments = splitSegments(normalized);

  const order: ParsedOrder = {
    order_number: null,
    order_date: null,
    buyer_gln: null,
    supplier_gln: null,
    lines: [],
    message_type: null,
  };

  if (!segments.length) {
    flags.push(flag("empty_message", "EDI message is empty"));
    return new ParseResult(order, flags, normalized, raw);
  }

  const seen = new Set<string>();
  let current: OrderLine | null = null;

  for (const seg of segments) {
    const els = elements(seg);
    const tag = els[0];

    if (tag === "UNH") {
      // UNH+1+ORDERS:D:96A:UN
      if (els.length > 2) {
        order.message_type = els[2].split(":")[0];
        if (order.message_type && order.message_type !== "ORDERS") {
          flags.push(flag("unexpected_message_type", `Expected ORDERS, got ${order.message_type}`, "UNH"));
        }
      }
      seen.add("UNH");
    } else if (tag === "BGM") {
      seen.add("BGM");
      // BGM+220+ESS001+9
      if (els.length >= 3 && els[2]) order.order_number = els[2];
      else flags.push(flag("bgm_missing_id", "BGM without order number", "BGM"));
    } else if (tag === "DTM") {
      seen.add("DTM");
      // DTM+137:20261104:102
      const composite = els.length > 1 ? els[1] : "";
      const parts = composite.split(":");
      if (parts.length >= 2) {
        const dateRaw = parts[1];
        if (/^\d{8}$/.test(dateRaw)) {
          order.order_date = dateRaw;
        } else {
          flags.push(flag("dtm_bad_format", `DTM date '${dateRaw}' is not YYYYMMDD`, "DTM"));
          order.order_date = dateRaw; // keep for Grokbot
        }
      } else {
        flags.push(flag("dtm_incomplete", "DTM segment incomplete", "DTM"));
      }
    } else if (tag === "NAD") {
      // NAD+BY+BUYER001::9
      const party = els.length > 1 ? els[1] : "";
      const code = els.length > 2 ? els[2].split(":")[0] : "";
      if (party === "BY") {
        seen.add("NAD+BY");
        order.buyer_gln = code || null;
        if (!code) flags.push(flag("nad_by_missing", "NAD+BY without code", "NAD+BY"));
      } else if (party === "SU") {
        seen.add("NAD+SU");
        order.supplier_gln = code || null;
        if (!code) flags.push(flag("nad_su_missing", "NAD+SU without code", "NAD+SU"));
      }
    } else if (tag === "LIN") {
      if (current !== null) order.lines.push(current);
      seen.add("LIN");
      const lineNo = els.length > 1 && /^\d+$/.test(els[1]) ? Number.parseInt(els[1], 10) : null;
      // LIN+1++8000000000000:EN
      const gtin = els.length > 3 && els[3] ? els[3].split(":")[0] : null;
      if (!gtin) flags.push(flag("lin_missing_gtin", "LIN without GTIN", "LIN"));
      else if (!/^\d{8,14}$/.test(gtin)) flags.push(flag("lin_gtin_malformed", `GTIN '${gtin}' looks malformed`, "LIN"));
      current = { line_no: lineNo, gtin, quantity: null, quantity_raw: null, unit_price: null, unit_price_raw: null };
    } else if (tag === "QTY") {
      seen.add("QTY");
      const composite = els.length > 1 ? els[1] : "";
      const parts = composite.split(":");
      const qtyRaw = parts.length > 1 ? parts[1] : parts[0];
      const [q, qtyFlags] = parseQuantityToken(qtyRaw);
      flags.push(...qtyFlags);
      if (current === null) {
        flags.push(flag("qty_without_lin", "QTY before LIN", "QTY"));
        current = { line_no: null, gtin: null, quantity: q, quantity_raw: qtyRaw, unit_price: null, unit_price_raw: null };
      } else {
        current.quantity = q;
        current.quantity_raw = qtyRaw;
      }
    } else if (tag === "PRI") {
      // PRI+AAA:1.85:CT
      const composite = els.length > 1 ? els[1] : "";
      const parts = composite.split(":");
      const priceRaw = parts.length > 1 ? parts[1] : "";
      const [price, priceFlags] = priceRaw ? parsePriceToken(priceRaw) : [null, [] as ParseFlag[]];
      flags.push(...priceFlags);
      if (current === null) {
        flags.push(flag("pri_without_lin", "PRI before LIN", "PRI"));
      } else {
        current.unit_price = price;
        current.unit_price_raw = priceRaw || null;
      }
    }
  }

  if (current !== null) order.lines.push(current);

  for (const req of REQUIRED_SEGMENTS) {
    if (!seen.has(req)) flags.push(flag("missing_segment", `Required segment ${req} missing`, req));
  }
  if (!order.lines.length) flags.push(flag("no_lines", "No order lines parsed"));

  return new ParseResult(order, flags, normalized.endsWith("'") ? normalized : `${normalized}'`, raw);
}

export function parseOrdersFile(path: string): ParseResult {
  return parseOrdersEdi(loadEdiFile(path));
}
