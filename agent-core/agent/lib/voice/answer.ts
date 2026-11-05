/**
 * A spoken question, answered from Mini ERP records only.
 * Code answers what it can place (an order ref, a claim, paddy, trucks, sign-offs). Grok answers
 * the rest from the Home facts, and code checks every number and the page it opens.
 * The sentence is what Grok's voice reads. Nothing here buys, confirms or sends.
 */
import { passport } from "../compliance/passport";
import type { Claim, Erp, Order } from "../core/erp";
import { overviewSnapshot } from "../core/overview";
import { search, type SearchHit } from "../core/search";
import { orderWorkspace, type OrderWorkspace } from "../order/workspace";
import { type Caller, chatJson, hasKey, type Message } from "../grok/client";
import { loadVoiceEnv } from "../grok/voice";
import { loadPaddyData, paddyToBuy, type PaddyRow } from "../purchasing/paddy";

export type VoiceAnswer = { text: string; href: string | null };
export type VoiceOptions = { caller?: Caller | null };

const ORDER_REF = /\b[A-Z]{2,5}-[A-Z0-9]+-\d{2,}\b/g;
const NOTHING = "I couldn't find that in the records.";
/** A question that asks for a reason. Counts and "opening the page" don't answer it. */
const WHY = /\b(why|how come|explain|reason|what happened)\b/i;
/** A question about orders, as opposed to a retailer's claims or payments. */
const ORDERISH = /\b(orders?|split\w*|deliver\w*|ship\w*|ordrsp|confirm\w*)\b/i;

const packs = (n: number) => Math.round(n).toLocaleString("en-GB");
const lowerFirst = (text: string) => text.replace(/^./, (c) => c.toLowerCase());
const dayMonth = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const euros = (n: number) => `${Math.round(n).toLocaleString("en-GB")} euros`;
const tonnes = (n: number) => `${n.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} tonnes`;
const weeks = (n: number) => {
  const shown = n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
  return `${shown} ${n === 1 ? "week" : "weeks"}`;
};

function explicitRefs(question: string): string[] {
  // Batch ids look like LOT-C-0418 and must not be treated as order refs.
  return [...question.toUpperCase().matchAll(ORDER_REF)].map((m) => m[0]).filter((ref) => !ref.startsWith("LOT-"));
}

/** Digit groups a person said as the end of an order ref. A bare year is not one. */
function endingOrders(orders: Order[], question: string): Order[] {
  const groups = [...question.matchAll(/\b(\d{3,})\b/g)]
    .map((m) => m[1] ?? "")
    .filter((digits) => digits.length > 0 && (!/^(?:19|20)\d{2}$/.test(digits) || /\b(?:ending|ends)\b/i.test(question)));
  if (!groups.length) return [];
  return orders.filter((order) => groups.some((digits) => order.orderRef.endsWith(digits)));
}

function speakOrder(order: Order, names: Map<string, string>): string {
  const retailer = order.buyerGln ? names.get(order.buyerGln) : undefined;
  const packs = order.lines.reduce((sum, line) => sum + (line.qtyOrdered ?? 0), 0);
  const status = order.status.replace(/_/g, " ");
  const who = retailer ? `${retailer}, ` : "";
  const qty = packs > 0 ? `, ${Math.round(packs).toLocaleString("en-GB")} packs` : "";
  return `${order.orderRef} is ${who}${status}${qty}.`;
}

function ordersAnswer(list: Order[], erp: Erp): VoiceAnswer {
  const names = new Map(erp.retailers().map((r) => [r.gln, r.name]));
  const shown = list.slice(0, 2);
  const lead = list.length > 2 ? `${list.length} orders match. ` : list.length === 2 ? "Two orders match. " : "";
  const first = shown[0];
  if (!first) return { text: NOTHING, href: null };
  return {
    text: `${lead}${shown.map((order) => speakOrder(order, names)).join(" ")}`.trim(),
    href: `/orders?ref=${encodeURIComponent(first.orderRef)}`,
  };
}

/** The retailer a question names: "Coop", "coop's", "Carrefour Italia". */
function retailerIn(erp: Erp, question: string) {
  const text = question.toLowerCase().replace(/[’']s\b/g, "");
  return erp.retailers().find((r) => {
    const name = r.name.toLowerCase();
    const first = name.split(/\s+/)[0] ?? "";
    const keys = first.length >= 3 && first !== name ? [name, first] : [name];
    return keys.some((key) => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  });
}

/** What Grok may read about one order when the question asks why. */
function orderFacts(ws: OrderWorkspace) {
  return {
    ref: ws.orderRef,
    retailer: ws.retailer,
    status: ws.statusText,
    next_step: ws.nextStep,
    owner: ws.owner,
    value_euros: ws.value,
    split: ws.split ? { now_packs: ws.split.now, later_packs: ws.split.later, later_date: ws.split.laterDate, by: ws.split.by, why: ws.split.why } : null,
    exceptions: ws.exceptions.slice(0, 4).map((e) => e.text),
    caught: ws.caught.slice(0, 4).map((c) => c.problem),
    history: ws.history.slice(-8).map((h) => `${h.who}: ${h.action}`),
  };
}

/**
 * A question about named orders. A split is told from its record, with the reason saved when it
 * was decided. Any other "why" goes to Grok with the order's record. Otherwise: where it stands.
 */
async function orderAnswer(erp: Erp, list: Order[], question: string, opts: VoiceOptions): Promise<VoiceAnswer> {
  const why = WHY.test(question);
  const splitAsked = /\bsplit/i.test(question);
  const spaces = list.map((order) => ({ order, ws: orderWorkspace(erp, order.orderRef) }));
  // The split asked about, else the order waiting on a person, else the latest.
  const pick =
    (splitAsked ? spaces.find((s) => s.ws?.split) : undefined) ?? spaces.find((s) => s.ws?.status === "attention") ?? spaces.at(-1);
  if (!pick) return { text: NOTHING, href: null };
  const { order, ws } = pick;
  if (!ws) return ordersAnswer([order], erp);
  const href = `/orders?ref=${encodeURIComponent(order.orderRef)}`;
  const lead = list.length > 1 ? `${ws.retailer} has ${list.length} orders. ` : "";

  if (ws.split && (splitAsked || why)) {
    const s = ws.split;
    const who = s.by === "grok" ? "Grok split it" : "It was split";
    const product = s.product ? ` of ${s.product}` : "";
    const when = s.laterDate ? ` from ${dayMonth(s.laterDate)}` : " later";
    const reason = s.why ? ` ${s.why}` : " The free stock didn't cover the whole order by the delivery date.";
    return { text: `${order.orderRef}: ${who}, ${packs(s.now)} packs${product} now and ${packs(s.later)}${when}.${reason}`, href };
  }
  if (why) {
    const told = await grokAnswer(erp, question, opts, orderFacts(ws), { label: order.orderRef, sub: "The order asked about", href });
    if (told) return told;
  }
  const owner = ws.owner.kind === "none" ? "" : ` ${ws.owner.name} has it: ${lowerFirst(ws.owner.doing)}.`;
  return { text: `${lead}${order.orderRef}, ${ws.retailer}: ${lowerFirst(ws.statusText)}.${owner}`, href };
}

function matchClaim(erp: Erp, question: string): Claim | undefined {
  const text = question.toLowerCase();
  return erp.claims().find((claim) => claim.claimId.length >= 3 && text.includes(claim.claimId.toLowerCase()));
}

function speakPaddy(row: PaddyRow): string {
  const call = row.call.toLowerCase();
  const cover = row.cover_weeks == null ? "cover is not on the plan" : `cover ${weeks(row.cover_weeks)}`;
  const spend = row.spend_eur == null ? "" : `, about ${euros(row.spend_eur)}`;
  const line = `${row.variety}: the plan says ${call}, ${cover}, suggested ${tonnes(row.suggested_t)}${spend}.`;
  if (!row.price) return line;
  return `${line} Last price ${euros(row.price.last)} a tonne, forecast ${euros(row.price.forecast)}.`;
}

/** "Should I buy…", and how Grok Voice sometimes writes it ("should I by…"). */
const BUYING = /\b(?:should|shall|can|could|do|must)\s+(?:i|we)\s+(?:buy|by|bye|purchase)\b/i;
const BUY_WORD = /\b(?:buy|buying|by|bye|purchase)\b/i;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length]!;
}

/**
 * The paddy variety a question names, also when Grok Voice mishears it: "carnaroly",
 * "car na roli", "karnaroli". One, two or three words run together, a third of the letters off at most.
 */
export function varietyIn(question: string): string | null {
  const names = loadPaddyData().varieties.map((row) => row.variety);
  const text = question.toLowerCase();
  const exact = names.find((name) => text.includes(name.toLowerCase()));
  if (exact) return exact;
  const words = text.replace(/[^a-zà-ù\s]/g, " ").split(/\s+/).filter(Boolean);
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const want = name.toLowerCase();
    const limit = Math.floor(want.length / 3);
    for (let i = 0; i < words.length; i++) {
      let joined = "";
      for (let k = i; k < Math.min(words.length, i + 3); k++) {
        joined += words[k];
        if (Math.abs(joined.length - want.length) > limit) continue;
        const d = editDistance(joined, want);
        if (d <= limit && (!best || d < best.d)) best = { name, d };
      }
    }
  }
  return best?.name ?? null;
}

function wantsPaddy(question: string): boolean {
  if (/\b(paddy|prices?|forecast|buy(?:ing)?|variet(?:y|ies))\b/i.test(question)) return true;
  return varietyIn(question) !== null;
}

/**
 * Lot compliance / passport / norms. Includes how Grok Voice often mangles the words
 * (compliments, password, trace ability, GMOs, etc.).
 */
export function wantsCompliance(question: string): boolean {
  return (
    /\b(compl(?:iance|iant|iments?|ains?|eance|eans)|pass\s*ports?|passwords?|trace(?:\s*ability|able)?|certificat(?:e|es|ion)s?|norms?|regulations?|g\.?\s*m\.?\s*o\.?s?|mrl|residues?|fair\s*trade|organic|origine|origin\s+label|ifs|brcgs|lot\s+mark)\b/i.test(
      question,
    ) || /\b(docs?|documents?|papers?)\b.*\b(lot|batch|product|rice)\b/i.test(question)
  );
}

/** Prefer pack sizes people ask about: "basmati 1 kg" before "basmati 500g". */
function productRank(name: string): number {
  const n = name.toLowerCase();
  if (/\b1\s*kg\b/.test(n) && !/carton/.test(n)) return 0;
  if (/500\s*g/.test(n)) return 1;
  if (/carton/.test(n)) return 2;
  return 3;
}

/** The finished-goods product a question names (fuzzy, same idea as varietyIn). */
export function productIn(erp: Erp, question: string): { gtin: string; name: string } | null {
  const products = [...erp.products()].sort((a, b) => productRank(a.name) - productRank(b.name) || a.name.localeCompare(b.name));
  const text = question.toLowerCase();
  const words = text.replace(/[^a-zà-ù0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  let best: { gtin: string; name: string; d: number; rank: number } | null = null;
  for (const p of products) {
    const short = p.name.replace(/^riso scotti\s+|^scotti\s+/i, "").toLowerCase();
    const keys = [short, short.replace(/\s+\d.*$/, "").trim(), short.split(/\s+/)[0] ?? ""].filter((k) => k.length >= 4);
    for (const key of keys) {
      if (text.includes(key)) {
        const rank = productRank(p.name);
        if (!best || rank < best.rank || (rank === best.rank && 0 < best.d)) best = { gtin: p.gtin, name: p.name, d: 0, rank };
        continue;
      }
      const want = key.replace(/\s+/g, "");
      const limit = Math.max(1, Math.floor(want.length / 3));
      for (let i = 0; i < words.length; i++) {
        let joined = "";
        for (let k = i; k < Math.min(words.length, i + 4); k++) {
          joined += words[k];
          if (Math.abs(joined.length - want.length) > limit) continue;
          const d = editDistance(joined, want);
          const rank = productRank(p.name);
          if (d <= limit && (!best || d < best.d || (d === best.d && rank < best.rank))) {
            best = { gtin: p.gtin, name: p.name, d, rank };
          }
        }
      }
    }
  }
  return best ? { gtin: best.gtin, name: best.name } : null;
}

function batchIn(question: string): string | null {
  const m = question.toUpperCase().match(/\bLOT-[A-Z0-9]+(?:-\d+)?\b/);
  return m?.[0] ?? null;
}

function shortProduct(name: string): string {
  return name.replace(/^Riso Scotti\s+|^Scotti\s+/i, "");
}

/** Open Stock on a product drawer (and a batch passport when we can name one). */
function complianceAnswer(erp: Erp, question: string): VoiceAnswer {
  const namedBatch = batchIn(question);
  if (namedBatch) {
    const row = erp.sqlite.prepare("SELECT gtin FROM batches WHERE batch = ? OR batch = ?").get(namedBatch, `${namedBatch}-HOLD`) as
      | { gtin: string }
      | undefined;
    if (row?.gtin) {
      const product = erp.product({ gtin: row.gtin });
      const pass = passport(erp, namedBatch);
      const gap = pass?.status === "gap";
      const label = product ? shortProduct(product.name) : "that product";
      return {
        text: gap
          ? `${namedBatch} on ${label} still needs compliance papers. Opening its passport.`
          : `Opening the compliance passport for ${namedBatch} on ${label}.`,
        href: `/stock?product=${encodeURIComponent(row.gtin)}&batch=${encodeURIComponent(namedBatch)}`,
      };
    }
  }

  const product = productIn(erp, question);
  if (product) {
    const batches = (
      erp.sqlite.prepare("SELECT batch, status FROM batches WHERE gtin = ? ORDER BY batch").all(product.gtin) as {
        batch: string;
        status: string;
      }[]
    ).filter((b) => !b.batch.endsWith("-HOLD"));
    const gapBatch = batches.map((b) => b.batch).find((id) => passport(erp, id)?.status === "gap");
    const holdBatch = batches.find((b) => b.status === "hold")?.batch;
    const openBatch = gapBatch ?? holdBatch ?? batches.find((b) => b.status === "released")?.batch ?? batches[0]?.batch;
    const label = shortProduct(product.name);
    const n = batches.length;
    const href = openBatch
      ? `/stock?product=${encodeURIComponent(product.gtin)}&batch=${encodeURIComponent(openBatch)}`
      : `/stock?product=${encodeURIComponent(product.gtin)}&passport=1`;
    if (gapBatch) {
      return {
        text: `${label} has a lot that still needs papers. Opening ${gapBatch}.`,
        href,
      };
    }
    return {
      text:
        n === 0
          ? `Opening ${label} in stock.`
          : n === 1
            ? `Opening ${label} and its lot passport.`
            : `Opening ${label}: ${n} batches. Showing the passport for ${openBatch}.`,
      href,
    };
  }

  // No product named: open the demo gap lot if present, else Carnaroli packs.
  const gap = erp.sqlite
    .prepare("SELECT batch, gtin FROM batches WHERE status = 'hold' ORDER BY batch")
    .all() as { batch: string; gtin: string }[];
  for (const row of gap) {
    if (passport(erp, row.batch)?.status === "gap") {
      const productName = erp.product({ gtin: row.gtin })?.name;
      return {
        text: `${row.batch}${productName ? ` on ${shortProduct(productName)}` : ""} still needs compliance papers. Opening its passport.`,
        href: `/stock?product=${encodeURIComponent(row.gtin)}&batch=${encodeURIComponent(row.batch)}`,
      };
    }
  }
  const carnaroli = erp.products().find((p) => /carnaroli/i.test(p.name) && /1\s*kg/i.test(p.name) && !/carton/i.test(p.name));
  if (carnaroli) {
    const batch = (
      erp.sqlite.prepare("SELECT batch FROM batches WHERE gtin = ? AND status = 'released' ORDER BY batch").get(carnaroli.gtin) as
        | { batch: string }
        | undefined
    )?.batch;
    return {
      text: batch
        ? `Opening Carnaroli stock and the passport for ${batch}.`
        : "Opening Carnaroli stock so you can open a lot passport.",
      href: batch
        ? `/stock?product=${encodeURIComponent(carnaroli.gtin)}&batch=${encodeURIComponent(batch)}`
        : `/stock?product=${encodeURIComponent(carnaroli.gtin)}&passport=1`,
    };
  }
  return { text: "Opening stock. Pick a product, then open a batch for its compliance passport.", href: "/stock?passport=1" };
}

async function paddyAnswer(erp: Erp, question: string): Promise<VoiceAnswer> {
  const href = "/stock?view=buying";
  try {
    const plan = await paddyToBuy(erp);
    const variety = varietyIn(question);
    const named = plan.rows.filter((row) => row.variety === variety);
    const row = named[0] ?? [...plan.rows].sort((a, b) => (a.cover_weeks ?? 999) - (b.cover_weeks ?? 999))[0];
    if (!row) return { text: "The buying plan has no varieties. Opening the buying page.", href };
    return { text: speakPaddy(row), href: `${href}&variety=${encodeURIComponent(row.variety)}` };
  } catch {
    return { text: "The buying plan didn't load. Opening the buying page.", href };
  }
}

function truckCount(erp: Erp): number | null {
  try {
    const row = erp.sqlite.prepare("select count(*) as n from si_trucks").get() as { n: number } | undefined;
    return typeof row?.n === "number" ? row.n : null;
  } catch {
    return null;
  }
}

function countSentence(n: number, one: string, many: string): string {
  if (n === 0) return `No ${many}.`;
  if (n === 1) return `There is 1 ${one}.`;
  return `There are ${n.toLocaleString("en-GB")} ${many}.`;
}

export async function answerQuestion(erp: Erp, question: string, opts: VoiceOptions = {}): Promise<VoiceAnswer> {
  const q = question.trim();
  if (!q) return { text: NOTHING, href: null };

  // Lot compliance / passport / norms — before buying or bare stock, including STT mangling.
  if (wantsCompliance(q) && !explicitRefs(q).length) return complianceAnswer(erp, q);

  // The demo question, however Grok Voice spells it: "Should I buy Carnaroli?", "should I by car na roli".
  if ((BUYING.test(q) || (BUY_WORD.test(q) && varietyIn(q))) && !explicitRefs(q).length) return paddyAnswer(erp, q);

  const why = WHY.test(q);
  const orders = erp.orders();
  const refs = explicitRefs(q);
  if (refs.length) {
    const found = orders.filter((order) => refs.includes(order.orderRef.toUpperCase()));
    if (found.length) return orderAnswer(erp, found, q, opts);
  }

  const ending = endingOrders(orders, q);
  if (ending.length) return orderAnswer(erp, ending, q, opts);

  // "Why is Coop's order split?": the retailer's orders, not a count of every order.
  const retailer = refs.length ? undefined : retailerIn(erp, q);
  if (retailer && (ORDERISH.test(q) || why)) {
    const theirs = orders.filter((order) => order.buyerGln === retailer.gln);
    if (theirs.length) return orderAnswer(erp, theirs, q, opts);
  }

  const claim = matchClaim(erp, q);
  if (claim) {
    const status = claim.status.replace(/_/g, " ");
    const onOrder = claim.orderRef ? ` on order ${claim.orderRef}` : "";
    return {
      text: `${claim.claimId} is ${status}${onOrder}.`,
      href: `/disputes?claim=${encodeURIComponent(claim.claimId)}`,
    };
  }

  if (!refs.length && wantsPaddy(q)) return paddyAnswer(erp, q);

  // A count and a page don't answer a "why". Those go to Grok below.
  if (why) return (await grokAnswer(erp, q, opts)) ?? { text: NOTHING, href: null };

  if (/\b(truck|trucks|shipping|route|routes|diesel|pallet|pallets)\b/i.test(q)) {
    const n = truckCount(erp);
    const text = n == null ? "Opening shipping." : `${countSentence(n, "truck", "trucks")} Opening shipping.`;
    return { text, href: "/shipping" };
  }

  if (/\b(claim|claims|dispute|disputes)\b/i.test(q)) {
    const n = erp.claims().length;
    return { text: `${countSentence(n, "claim", "claims")} Opening disputes.`, href: "/disputes" };
  }

  if (/\bsign[- ]?offs?\b/i.test(q)) {
    const pending = erp.signoffs({ status: "pending" });
    if (pending.length === 1) {
      const one = pending[0]!;
      const title = one.title?.trim() || one.caseId;
      return { text: `One case is waiting: ${title}.`, href: `/signoff?case=${encodeURIComponent(one.caseId)}` };
    }
    const text =
      pending.length === 0
        ? "Nothing is waiting for a person to sign off."
        : `${countSentence(pending.length, "case", "cases")} A person still has to decide.`;
    return { text, href: "/signoff" };
  }

  if (/\borders?\b/i.test(q)) {
    return { text: `${countSentence(orders.length, "order", "orders")} Opening orders.`, href: "/orders" };
  }

  // "Show me Basmati batches" / "open Carnaroli lots" — product drawer, not the bare list.
  if (/\b(batch|batches|lots?|pass\s*ports?)\b/i.test(q)) {
    const product = productIn(erp, q);
    if (product) return complianceAnswer(erp, q);
  }

  if (/\b(stock|stocks|silo|silos|inventory|batch|batches)\b/i.test(q)) {
    const product = productIn(erp, q);
    if (product) {
      return {
        text: `Opening ${shortProduct(product.name)} in stock.`,
        href: `/stock?product=${encodeURIComponent(product.gtin)}`,
      };
    }
    return { text: "Opening stock.", href: "/stock" };
  }

  if (refs.length) return { text: `I couldn't find ${refs[0]} in the records.`, href: null };

  const hits = search(erp, q, 2);
  const first = hits[0];
  if (first) {
    const spoken = hits.map((hit) => `${hit.label}. ${hit.sub}.`).join(" ");
    return { text: spoken, href: first.href };
  }

  return (await grokAnswer(erp, q, opts)) ?? { text: NOTHING, href: null };
}

/** Pages Grok may open, with what each one shows. */
const PAGES: Record<string, string> = {
  "/": "Home: the desk, the to-do, packs running short, the next trucks",
  "/orders": "Orders: every retailer order and who has it now",
  "/shipping": "Shipping: the truck plan, the loading dock, invoices against what shipped",
  "/stock": "Stock: what we can promise and the 8-week projection",
  "/stock?view=buying": "Paddy to buy, by variety",
  "/stock?passport=1": "Stock: open a product, then a batch for its compliance passport",
  "/disputes": "Disputes: claims, payments and deductions",
  "/signoff": "Sign-off: cases waiting for a person",
};

/** Stock product / batch passport deep links Grok or code may open. */
function stockComplianceHrefs(erp: Erp): string[] {
  const out = ["/stock?passport=1"];
  for (const p of erp.products()) {
    out.push(`/stock?product=${encodeURIComponent(p.gtin)}`);
    out.push(`/stock?product=${encodeURIComponent(p.gtin)}&passport=1`);
    for (const b of erp.sqlite.prepare("SELECT batch FROM batches WHERE gtin = ?").all(p.gtin) as { batch: string }[]) {
      if (b.batch.endsWith("-HOLD")) continue;
      out.push(`/stock?product=${encodeURIComponent(p.gtin)}&batch=${encodeURIComponent(b.batch)}`);
    }
  }
  return out;
}

/** A spoken answer has to come back in a second or two; a reasoning model takes 6 to 12. */
const VOICE_MODEL = "grok-4.20-non-reasoning";

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (text: string) =>
  new Set([...text.matchAll(NUMBER)].map((m) => m[0].replace(/,/g, "").replace(/\.0+$/, "")));

/** What Grok may say: the Home counts, the cases waiting, held stock and the latest orders. */
function voiceFacts(erp: Erp, hits: SearchHit[], order: ReturnType<typeof orderFacts> | null = null) {
  const snap = overviewSnapshot(erp, { recent: 0 });
  const names = new Map(erp.retailers().map((r) => [r.gln, r.name]));
  return {
    as_of: snap.asOf.slice(0, 10),
    orders: { total: snap.counts.orders, by_status: snap.counts.ordersByStatus },
    invoices: { sent: snap.counts.invoicesSent, held_back: snap.counts.invoicesHeld, net_euros_all_retailers: Math.round(snap.counts.invoicedNet).toLocaleString("en-GB") },
    claims: { total: snap.counts.claims, by_status: snap.counts.claimsByStatus },
    trucks: truckCount(erp),
    signoffs_waiting: snap.counts.signoffsWaiting,
    cases_waiting: snap.waiting.slice(0, 8).map((w) => ({ case: w.caseId, about: w.subjectRef, title: w.title })),
    stock_on_hold: snap.stockAlerts.slice(0, 6).map((a) => ({ product: a.name, held_packs: a.held, free_packs: a.atp })),
    compliance: {
      note: "Lot passports live under Stock → a product → a batch. For compliance, origin, GMO, MRL or certificates, open /stock?product=<gtin>&batch=<LOT-…>.",
      example_hrefs: stockComplianceHrefs(erp).slice(0, 12),
    },
    latest_orders: erp.orders().slice(-12).map((o) => ({ ref: o.orderRef, retailer: o.buyerGln ? names.get(o.buyerGln) ?? null : null, status: o.status })),
    matches: hits,
    ...(order ? { order_asked_about: order } : {}),
  };
}

/** The checks on Grok's answer: plain speech, numbers from the facts, a page we have. */
export function checkVoiceAnswer(payload: Record<string, unknown>, facts: ReturnType<typeof voiceFacts>): string[] {
  const problems: string[] = [];
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) problems.push("text is empty");
  if (text.length > 320) problems.push("text is longer than 320 characters");
  if (/[*#`|]|https?:/.test(text)) problems.push("text must be plain speech, with no markdown or links");
  const known = numbersIn(JSON.stringify(facts));
  for (const n of numbersIn(text)) if (!known.has(n)) problems.push(`${n} is not in the facts`);
  const href = payload.href;
  if (href != null) {
    const allowed = new Set([
      ...Object.keys(PAGES),
      ...facts.latest_orders.map((o) => `/orders?ref=${encodeURIComponent(o.ref)}`),
      ...facts.cases_waiting.map((c) => `/signoff?case=${encodeURIComponent(c.case)}`),
      ...facts.matches.map((m) => m.href),
      ...(facts.compliance?.example_hrefs ?? []),
    ]);
    // Any /stock?product=…(&batch=…) deep link is fine even if not in the short example list.
    const stockDeep = typeof href === "string" && /^\/stock\?(?:.*&)?product=[^&]+/.test(href);
    if (typeof href !== "string" || (!allowed.has(href) && !stockDeep)) {
      problems.push(`href ${JSON.stringify(href)} is not one of the pages`);
    }
  }
  return problems;
}

/** Grok on what the rules couldn't place. Null when there is no key or the answer fails the checks. */
async function grokAnswer(
  erp: Erp,
  question: string,
  opts: VoiceOptions,
  order: ReturnType<typeof orderFacts> | null = null,
  page: SearchHit | null = null,
): Promise<VoiceAnswer | null> {
  if (!opts.caller) {
    loadVoiceEnv();
    if (!hasKey()) return null;
  }
  try {
    const facts = voiceFacts(erp, [...(page ? [page] : []), ...search(erp, question, 4)], order);
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "You answer one spoken question for Riso Scotti's back office. Your answer is read aloud.",
          'Reply with a JSON object only: {"text": string, "href": string | null}.',
          "text: one or two short sentences, under 40 words, plain speech. Write numbers as digits with thousands separators (280,203) and money as euros. Don't say dates unless asked.",
          "Use only the facts. Every number you say must appear in the facts, and means what its field says. The counts and totals cover every retailer: never give them as one retailer's, product's or truck's. If the facts don't answer the question, say so in one sentence and open the closest page.",
          "Don't read lists of ids aloud. Give the count and at most one example by its title.",
          "href: the page that shows your answer. One of the pages listed, or /orders?ref=<a ref in the facts> or /signoff?case=<a case in the facts> when the answer is about that one record, or /stock?product=<gtin>&batch=<LOT-…> for lot compliance / passport / certificates / origin / GMO / MRL, or a matches href, or null.",
          "If the person asks for compliance, passports, norms, regulations, certificates, traceability, GMO or lab docs, open a stock product+batch passport href from the facts — never invent a Compliance page.",
          "Never say you approved, confirmed, sent or bought anything: a person decides.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Question: ${question}\n\nPages:\n${Object.entries(PAGES)
          .map(([href, what]) => `${href} = ${what}`)
          .join("\n")}\n\nFacts:\n${JSON.stringify(facts)}`,
      },
    ];
    const payload = await chatJson(messages, {
      task: "voice.answer",
      model: VOICE_MODEL,
      caller: opts.caller ?? null,
      validate: (p) => checkVoiceAnswer(p, facts),
      retries: 1,
      timeoutMs: 12_000,
    });
    const href = typeof payload.href === "string" ? payload.href : null;
    // 280203 reads better as 280,203. Refs (BEN-31877) and years keep their digits.
    const text = String(payload.text)
      .trim()
      .replace(/(?<![\w-])\d{5,}(?![\w-])/g, (n) => Number(n).toLocaleString("en-GB"));
    return { text, href };
  } catch (err) {
    console.error("voice grok answer", err instanceof Error ? err.message : err);
    return null;
  }
}
