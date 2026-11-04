/**
 * Grokbot for the Order row: the three cases in order-dec.md (port of order/grokbot.py).
 *
 * 1. parse_flags    -> Grok proposes a corrected EDI; the parser must read it cleanly.
 * 2. qty_short      -> code computes the options (split or a reduced quantity);
 *                      Grok picks one and writes the message. Grok never sets a quantity.
 * 3. price_mismatch -> code drafts the mail; Grok may rewrite it in the retailer's
 *                      language, keeping exactly the same figures.
 *
 * Every function works without a key: it returns null (parse) or the code's own choice and
 * text, marked source="code". A person confirms every order anyway.
 */
import { numbersIn } from "../core/checks";
import { type Caller, chatJson, hasKey, type Message } from "../grok/client";
import type { ParseFlag } from "./parser";
import { pyRepr } from "./py";

const live = (caller?: Caller | null) => caller != null || hasKey();

// ----- 1. parse_flags -------------------------------------------------------

export type ParseFix = {
  corrected_edi: string;
  changes: { segment?: string; before?: string; after?: string; why?: string }[];
  confidence: number;
  [k: string]: unknown;
};

/**
 * Deterministic Grokbot repairs for the well-known parse flags (date ISO → YYYYMMDD,
 * Italian thousands in QTY). Used offline when there is no key, and as a fallback when
 * chat is unavailable or low-confidence — so fixable EDI never sits in manual_edi / Other.
 */
export function codeParseFix(
  rawEdi: string,
  flags: Pick<ParseFlag, "code" | "message" | "segment">[],
): ParseFix | null {
  let edi = rawEdi;
  const changes: ParseFix["changes"] = [];
  const codes = new Set(flags.map((f) => f.code));

  if (codes.has("dtm_bad_format")) {
    edi = edi.replace(/DTM\+([^+:]+):(\d{4})-(\d{2})-(\d{2}):(\d+)/g, (_m, qual, y, mo, d, fmt) => {
      const before = `${y}-${mo}-${d}`;
      const after = `${y}${mo}${d}`;
      changes.push({
        segment: "DTM",
        before,
        after,
        why: "Order dates in ORDERS must be YYYYMMDD",
      });
      return `DTM+${qual}:${after}:${fmt}`;
    });
  }

  if (codes.has("qty_ambiguous_it_thousands") || codes.has("qty_ambiguous_dot")) {
    edi = edi.replace(/QTY\+(\d+):(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+\.\d{3})/g, (full, qual, raw) => {
      let normalized = String(raw).replace(/\./g, "");
      if (normalized.includes(",")) normalized = normalized.replace(/,/g, ".");
      if (!/^\d+(\.\d+)?$/.test(normalized)) return full;
      changes.push({
        segment: "QTY",
        before: String(raw),
        after: normalized,
        why: "Italian thousands grouping in the quantity",
      });
      return `QTY+${qual}:${normalized}`;
    });
  }

  if (!changes.length || edi === rawEdi) return null;
  return { corrected_edi: edi, changes, confidence: 0.9 };
}

export async function proposeParseFix(
  rawEdi: string,
  flags: Pick<ParseFlag, "code" | "message" | "segment">[],
  opts: { caller?: Caller | null } = {},
): Promise<ParseFix | null> {
  const offline = () => codeParseFix(rawEdi, flags);

  if (!live(opts.caller)) return offline();

  const messages: Message[] = [
    {
      role: "system",
      content:
        "You repair EDIFACT ORDERS messages for the Riso Scotti back office. " +
        "Fix only what the parser flags name: segment terminators, date formats, " +
        "Italian thousand separators in QTY (20.000 means 20000). Never invent a value " +
        "you cannot read; if a value is unreadable, leave it and set confidence under 0.5. " +
        'Return one JSON object: {"corrected_edi": string, "changes": ' +
        '[{"segment": string, "before": string, "after": string, "why": string}], ' +
        '"confidence": number from 0 to 1}.',
    },
    {
      role: "user",
      content: `Parser flags:\n${flags.map((f) => `- ${f.code}: ${f.message}`).join("\n")}\n\nEDI as received:\n${rawEdi}`,
    },
  ];

  const validate = (payload: Record<string, unknown>) => {
    const problems: string[] = [];
    if (typeof payload.corrected_edi !== "string" || !payload.corrected_edi.includes("BGM")) {
      problems.push("corrected_edi must be the full EDI text with its BGM segment");
    }
    if (!Array.isArray(payload.changes)) problems.push("changes must be a list");
    if (typeof payload.confidence !== "number") problems.push("confidence must be a number");
    return problems;
  };

  let payload: Record<string, unknown>;
  try {
    payload = await chatJson(messages, { task: "order.fix_parse", validate, caller: opts.caller });
  } catch {
    return offline();
  }
  if (Number(payload.confidence || 0) < 0.5) return offline();
  return payload as ParseFix;
}

// ----- 2. qty_short ---------------------------------------------------------

export type QtyOption = { action: "split" | "mail"; now_qty: number; later_qty: number; later_date: string | null };
export type QtyProposal = QtyOption & { message: string; source: "code" | "grok"; why?: unknown; confidence?: unknown };

/** The only answers allowed. Quantities come from stock, never from Grok. */
export function qtyOptions(o: { ordered: number; available: number; nextDate: string | null; laterAvailable: number }): QtyOption[] {
  const options: QtyOption[] = [];
  const now = Math.max(Math.trunc(o.available), 0);
  const rest = Math.trunc(o.ordered) - now;
  if (now > 0 && o.nextDate && o.laterAvailable >= rest && rest > 0) {
    options.push({ action: "split", now_qty: now, later_qty: rest, later_date: o.nextDate });
  }
  if (now > 0) options.push({ action: "mail", now_qty: now, later_qty: 0, later_date: null });
  return options;
}

function qtyTemplate(option: QtyOption, o: { orderRef: string; ordered: number; buyer: string; product: string }): string {
  if (option.action === "split") {
    return (
      `Gentile ${o.buyer}, per l'ordine ${o.orderRef} (${o.product}) possiamo consegnare subito ` +
      `${option.now_qty} pezzi e i restanti ${option.later_qty} dal ${option.later_date}. ` +
      `Vi confermiamo le due consegne con l'ORDRSP. Cordiali saluti, Riso Scotti.`
    );
  }
  return (
    `Gentile ${o.buyer}, per l'ordine ${o.orderRef} (${o.product}) oggi possiamo garantire ` +
    `${option.now_qty} dei ${Math.trunc(o.ordered)} pezzi richiesti. Vi chiediamo se accettate questa quantità ` +
    `o preferite rivedere l'ordine. Cordiali saluti, Riso Scotti.`
  );
}

export async function proposeQtyResolution(o: {
  orderRef: string;
  gtin: string;
  product: string;
  buyer: string;
  ordered: number;
  available: number;
  nextDate: string | null;
  laterAvailable: number;
  caller?: Caller | null;
}): Promise<QtyProposal | null> {
  const options = qtyOptions(o);
  if (!options.length) return null;
  const def = options[0];
  const result: QtyProposal = { ...def, message: qtyTemplate(def, o), source: "code" };
  if (!live(o.caller)) return result;

  const allowed = numbersIn(
    `${options.flatMap((x) => [x.now_qty, x.later_qty, x.later_date ?? ""].map(String)).join(" ")} ${Math.trunc(o.ordered)} ${o.orderRef} ${o.product}`,
  );
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You help the Riso Scotti order desk when stock is short. Choose one of the allowed " +
        "options and write a short, polite message to the retailer in Italian. Use only the " +
        'quantities and dates given. Return one JSON object: {"action": one of the allowed ' +
        'actions, "message": string, "why": string, "confidence": number}.',
    },
    {
      role: "user",
      content:
        `Order ${o.orderRef}, retailer ${o.buyer}, product ${o.product} (GTIN ${o.gtin}). Ordered ${Math.trunc(o.ordered)}, ` +
        `available now ${Math.trunc(o.available)}. Allowed options: ${pyRepr(options)}`,
    },
  ];

  const validate = (payload: Record<string, unknown>) => {
    const problems: string[] = [];
    if (!options.some((x) => x.action === payload.action)) {
      problems.push(`action must be one of ${pyRepr(options.map((x) => x.action))}`);
    }
    const extra = [...numbersIn(String(payload.message || ""))].filter((n) => !allowed.has(n));
    if (extra.length) problems.push(`the message uses figures that are not in the options: ${pyRepr(extra.sort())}`);
    return problems;
  };

  let payload: Record<string, unknown>;
  try {
    payload = await chatJson(messages, { task: "order.qty_short", validate, caller: o.caller });
  } catch {
    return result;
  }
  const chosen = options.find((x) => x.action === payload.action)!;
  return {
    ...chosen,
    message: (payload.message as string) || result.message,
    why: payload.why ?? null,
    confidence: payload.confidence ?? null,
    source: "grok",
  };
}

// ----- 3. price_mismatch ----------------------------------------------------

/** Returns [mail, source]. The figures must stay exactly those of the code draft. */
export async function polishPriceMail(codeDraft: string, opts: { caller?: Caller | null } = {}): Promise<[string, "code" | "grok"]> {
  if (!live(opts.caller)) return [codeDraft, "code"];
  const allowed = numbersIn(codeDraft);
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You rewrite a price-discrepancy email from Riso Scotti to a retailer in clear, polite " +
        "Italian. Keep every figure, order number and contract id exactly as given; add no new " +
        'figure. Return one JSON object: {"mail": string}.',
    },
    { role: "user", content: codeDraft },
  ];

  const validate = (payload: Record<string, unknown>) => {
    const mail = String(payload.mail || "");
    if (!mail) return ["mail is empty"];
    const got = numbersIn(mail);
    const problems: string[] = [];
    const added = [...got].filter((n) => !allowed.has(n)).sort();
    const dropped = [...allowed].filter((n) => !got.has(n)).sort();
    if (added.length) problems.push(`new figures appeared: ${pyRepr(added)}`);
    if (dropped.length) problems.push(`figures were dropped: ${pyRepr(dropped)}`);
    return problems;
  };

  try {
    const payload = await chatJson(messages, { task: "order.price_mail", validate, caller: opts.caller });
    return [String(payload.mail), "grok"];
  } catch {
    return [codeDraft, "code"];
  }
}
