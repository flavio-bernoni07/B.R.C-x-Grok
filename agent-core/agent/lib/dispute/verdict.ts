/**
 * Verdict + sources: Grok proposes accept | partial | reject with a source on every point
 * (port of dispute/verdict.py).
 *
 * Grok reads the Playbook, the contract excerpt, the claim and the facts. Code keeps only
 * euro figures present in the claim / documents / threeway (invented amounts are normalized
 * to a known figure or dropped) and decides whether a person must sign off. There is no euro
 * threshold: only ambiguity sends a case to a person.
 */
import { readFileSync, statSync } from "node:fs";
import { type Caller, chatJson, hasKey, type Message, MissingApiKeyError } from "../grok/client";
import { dataPath } from "../paths";
import { type ClaimExtraction, nullFloat, nullStr, parseExtraction } from "./claim_reader";
import type { DisputeFacts } from "./pull_facts";

export const defaultPlaybookPath = () => dataPath("disputes", "playbook.md");
export const defaultContractPath = () => dataPath("disputes", "contract_excerpt.md");

export const AMOUNT_EPS = 0.05; // euro tolerance when matching proposed amounts to known figures
// There is no euro threshold: any amount can go out without a person when nothing is
// ambiguous. Below this confidence (Grok's verdict or the claim reading) a person decides.
export const MIN_CONFIDENCE = 0.55;

export const VerdictDecision = { ACCEPT: "accept", PARTIAL: "partial", REJECT: "reject" } as const;
export type VerdictDecision = (typeof VerdictDecision)[keyof typeof VerdictDecision];
export const DECISIONS: ReadonlySet<string> = new Set(Object.values(VerdictDecision));

export const VERDICT_SCHEMA_HINT = `
Return a single JSON object only (no markdown), with these keys:
  decision: "accept" | "partial" | "reject"
  amount: number or null — total credit € to propose (null if reject with €0 or unknown)
  confidence: number from 0 to 1
  needs_sign_off: boolean — true if anything is ambiguous: you are unsure, a point has
                  no source, the case is not covered by the Playbook, or the documents disagree
  summary: short string — one-paragraph rationale
  points: array of objects, each with:
    text: string — the finding
    amount: number or null — € for this point only
    source: object with:
      kind: one of "order" | "desadv" | "invoice" | "ddt" | "pod" | "warehouse_event"
            | "contract" | "threeway" | "playbook" | "damage_photo" | "other"
      ref: string — document id, clause, threeway reason, or playbook rule id
      detail: string — brief why this source supports the point

Rules:
- Read the Playbook first and follow it.
- NEVER invent euro amounts. Every amount must equal a figure present in the claim,
  threeway value_variance, invoice/PO line math, or contract promo prices × qty
  already shown in the facts. If you cannot tie an amount to those numbers, use null.
- Every point MUST have a source. Prefer concrete document ids from facts.
- Dispute ends in credit note or evidence reply later — you only decide.
`.trim();

export type VerdictSource = { kind: string; ref: string; detail: string };
export type VerdictPoint = { text: string; amount: number | null; source: VerdictSource };

/** The verdict as a JSON document (Python key names). */
export type DisputeVerdict = {
  decision: VerdictDecision;
  amount: number | null;
  confidence: number;
  needs_sign_off: boolean;
  summary: string;
  points: VerdictPoint[];
  playbook_path: string | null;
  contract_path: string | null;
  amount_notes: string[];
  known_amounts: number[];
  sign_off_reasons: string[];
};

type FactsLike = Partial<DisputeFacts> & Record<string, unknown>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

export function loadText(path: string): string {
  let ok = false;
  try {
    ok = statSync(path).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`File not found: ${path}`);
  return readFileSync(path, "utf8");
}

const round2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;

/** Euro figures grounded in claim / docs / threeway: Grok must not invent outside these. */
export function collectKnownAmounts(claim: ClaimExtraction, facts: FactsLike): number[] {
  const known: number[] = [];
  const add = (value: unknown) => {
    const n = nullFloat(value);
    if (n == null) return;
    known.push(round2(Math.abs(n))); // absolute magnitudes for matching credit sizes
  };

  add(claim.amount);
  if (claim.quantity != null) {
    for (const key of ["order", "invoice"]) {
      for (const line of arr(obj(facts[key]).lines)) {
        if (line.unit_price != null) add(claim.quantity * Number(line.unit_price));
      }
    }
  }

  for (const key of ["order", "invoice", "desadv"]) {
    const doc = obj(facts[key]);
    add(doc.total);
    for (const line of arr(doc.lines)) {
      add(line.unit_price);
      const q = nullFloat(line.quantity);
      const p = nullFloat(line.unit_price);
      if (q != null && p != null) add(q * p);
    }
  }

  for (const line of arr(obj(facts.threeway).lines)) {
    add(line.value_variance);
    add(line.po_price);
    add(line.invoice_price);
    const ordered = nullFloat(line.ordered);
    const received = nullFloat(line.received);
    const invoiced = nullFloat(line.invoiced);
    const poPrice = nullFloat(line.po_price);
    const invPrice = nullFloat(line.invoice_price);
    if (ordered != null && received != null && poPrice != null) add((ordered - received) * poPrice);
    if (invoiced != null && received != null && poPrice != null) add((invoiced - received) * poPrice);
    if (invoiced != null && invPrice != null && poPrice != null) add((invPrice - poPrice) * invoiced);
  }

  // Deduplicate while preserving order; zero is not a credit.
  const out: number[] = [];
  for (const v of known) if (v !== 0 && !out.includes(v)) out.push(v);
  return out;
}

function amountIsKnown(amount: number | null, known: number[]): boolean {
  if (amount == null) return true;
  const target = Math.abs(amount);
  return known.some((k) => Math.abs(target - k) <= AMOUNT_EPS);
}

function nearestKnown(amount: number, known: number[]): number | null {
  if (!known.length) return null;
  const target = Math.abs(amount);
  let best = known[0];
  for (const k of known) if (Math.abs(k - target) < Math.abs(best - target)) best = k;
  if (Math.abs(best - target) <= Math.max(AMOUNT_EPS, 0.02 * Math.max(target, best))) return best;
  return null;
}

/** Clamp / null out invented amounts; prefer figures present in claim/facts. */
export function normalizeAmounts(
  decision: VerdictDecision,
  amount: number | null,
  points: VerdictPoint[],
  known: number[],
): [number | null, VerdictPoint[], string[]] {
  const notes: string[] = [];
  const fixed: VerdictPoint[] = [];
  for (const point of points) {
    if (point.amount == null || amountIsKnown(point.amount, known)) {
      fixed.push(point);
      continue;
    }
    const nearest = nearestKnown(point.amount, known);
    if (nearest != null) {
      notes.push(`Point amount ${pyNum(point.amount)} normalized to known ${pyNum(nearest)} from docs/facts`);
      fixed.push({ ...point, amount: nearest });
    } else {
      notes.push(`Point amount ${pyNum(point.amount)} dropped (not grounded in claim/facts/threeway)`);
      fixed.push({ ...point, amount: null });
    }
  }

  if (amount != null && !amountIsKnown(amount, known)) {
    const nearest = nearestKnown(amount, known);
    if (nearest != null) {
      notes.push(`Overall amount ${pyNum(amount)} normalized to known ${pyNum(nearest)}`);
      amount = nearest;
    } else {
      notes.push(`Overall amount ${pyNum(amount)} cleared (not grounded in claim/facts)`);
      amount = null;
    }
  }

  if (decision === VerdictDecision.REJECT && amount == null) {
    // Reject with no credit is fine.
  } else if (amount == null) {
    // Prefer the sum of grounded point amounts when the overall amount is missing.
    const pointSum = fixed.reduce((s, p) => s + (p.amount ?? 0), 0);
    if (pointSum > 0) {
      amount = round2(pointSum);
      notes.push(`Overall amount set from sum of grounded point amounts: ${pyNum(amount)}`);
    }
  }
  return [amount, fixed, notes];
}

/** Python's float str(): 186.0 stays "186.0" (keeps notes and texts identical to the Python row). */
export function pyNum(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/**
 * Why a person must decide. Empty list = nothing ambiguous, no sign-off.
 * The size of the amount is not a reason: only ambiguity is.
 */
export function signOffReasons(
  payload: Obj,
  a: {
    decision: VerdictDecision;
    amount: number | null;
    confidence: number;
    points: VerdictPoint[];
    amountNotes: string[];
    claim?: ClaimExtraction | Obj | null;
    facts?: FactsLike | null;
  },
): string[] {
  const reasons: string[] = [];
  if (payload.needs_sign_off === true) reasons.push("Grok marked the case as unsure");
  if (a.confidence < MIN_CONFIDENCE) reasons.push(`verdict confidence ${a.confidence.toFixed(2)} is under ${MIN_CONFIDENCE}`);
  if (!a.points.length) reasons.push("the verdict has no points");
  if (a.points.some((p) => p.source.ref === "unspecified")) reasons.push("a point has no source");
  if (a.amountNotes.length) reasons.push("Grok proposed an amount that is not in the documents");
  if (a.decision !== VerdictDecision.REJECT && a.amount == null) reasons.push("a credit is proposed without an amount from the documents");

  if (a.claim != null) {
    const extraction = parseExtraction(a.claim as Obj);
    if (extraction.claim_type === "other") reasons.push("the claim type is not covered by the Playbook");
    if (extraction.confidence < MIN_CONFIDENCE) {
      reasons.push(`claim reading confidence ${extraction.confidence.toFixed(2)} is under ${MIN_CONFIDENCE}`);
    }
  }
  if (a.facts != null) {
    const missing = arr(a.facts.misses).map((m) => String(m.kind));
    if (missing.length) reasons.push("documents not found: " + missing.join(", "));
  }
  return reasons;
}

export function parseVerdictPayload(
  payload: Obj,
  o: {
    knownAmounts: number[];
    playbookPath?: string | null;
    contractPath?: string | null;
    claim?: ClaimExtraction | Obj | null;
    facts?: FactsLike | null;
  },
): DisputeVerdict {
  let rawDecision = String(payload.decision || "reject").trim().toLowerCase();
  if (!DECISIONS.has(rawDecision)) rawDecision = "reject";
  const decision = rawDecision as VerdictDecision;

  let confidence = nullFloat(payload.confidence) ?? 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const parsedPoints: VerdictPoint[] = [];
  for (const item of arr(payload.points)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const src = obj(item.source);
    const text = nullStr(item.text) || "";
    if (!text) continue;
    parsedPoints.push({
      text,
      amount: nullFloat(item.amount),
      source: { kind: nullStr(src.kind) || "other", ref: nullStr(src.ref) || "unspecified", detail: nullStr(src.detail) || "" },
    });
  }

  const [amount, points, amountNotes] = normalizeAmounts(decision, nullFloat(payload.amount), parsedPoints, o.knownAmounts);
  const reasons = signOffReasons(payload, { decision, amount, confidence, points, amountNotes, claim: o.claim, facts: o.facts });

  return {
    decision,
    amount,
    confidence,
    needs_sign_off: reasons.length > 0,
    summary: nullStr(payload.summary) || "",
    points,
    playbook_path: o.playbookPath ?? null,
    contract_path: o.contractPath ?? null,
    amount_notes: amountNotes,
    known_amounts: o.knownAmounts,
    sign_off_reasons: reasons,
  };
}

export function buildVerdictPrompt(a: {
  playbook: string;
  contract: string;
  claim: ClaimExtraction;
  facts: FactsLike;
  knownAmounts: number[];
}): Message[] {
  const bundle = { claim: a.claim, facts: a.facts, known_amounts_eur: a.knownAmounts, contract_excerpt: a.contract };
  return [
    {
      role: "system",
      content:
        "You are the Dispute verdict agent for Riso Scotti zero-touch back office. " +
        "Decide accept, partial, or reject with sources. " +
        VERDICT_SCHEMA_HINT +
        "\n\n=== PLAYBOOK (read first) ===\n" +
        a.playbook,
    },
    {
      role: "user",
      content:
        "Claim extraction + pulled facts + contract excerpt follow as JSON. " +
        "Use only known_amounts_eur (and exact arithmetic from those docs) for euros.\n\n" +
        JSON.stringify(bundle, null, 2),
    },
  ];
}

/** Propose a verdict from claim + facts. The live path needs an API key unless `caller` is set. */
export async function decideVerdict(
  claim: ClaimExtraction | Obj,
  facts: FactsLike,
  opts: { playbookPath?: string | null; contractPath?: string | null; caller?: Caller | null } = {},
): Promise<DisputeVerdict> {
  const extraction = parseExtraction(claim as Obj);
  const pbPath = opts.playbookPath || defaultPlaybookPath();
  const ctPath = opts.contractPath || defaultContractPath();
  const playbook = loadText(pbPath);
  const contract = loadText(ctPath);
  const known = collectKnownAmounts(extraction, facts);
  const messages = buildVerdictPrompt({ playbook, contract, claim: extraction, facts, knownAmounts: known });

  if (!opts.caller && !hasKey()) {
    throw new MissingApiKeyError(
      "Missing API key. Set XAI_API_KEY or GROK_API_KEY for live verdict. " +
        "Use --dry-run to load claim/facts/playbook without calling Grok.",
    );
  }
  const payload = await chatJson(messages, { task: "dispute.verdict", caller: opts.caller ?? null });

  return parseVerdictPayload(payload, {
    knownAmounts: known,
    playbookPath: pbPath,
    contractPath: ctPath,
    claim: extraction,
    facts,
  });
}
