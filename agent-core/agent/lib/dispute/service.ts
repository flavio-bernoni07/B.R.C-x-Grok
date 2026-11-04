/**
 * Dispute row on the shared Mini ERP (port of dispute/service.py).
 *
 *   handleClaim()     claim email -> Grok reads it -> facts from the Mini ERP (+ the Dispute
 *                     fixtures) -> Grok verdict -> outcome, or a sign-off
 *   approveVerdict()  a person signs off an ambiguous verdict; the outcome is written and the
 *                     case is added to the Playbook's past cases
 *   rejectVerdict()   the person overturns Grok; nothing is sent, the claim is reopened
 *
 * Grok decides and explains, code writes every document and amount (dispute-dec.md).
 *
 * The app never edits data/disputes/playbook.md: on first use it is copied to
 * data/runtime/playbook.md, and past cases are appended there (the Python demo also writes to a
 * copy). Outcome files go to data/runtime/disputes/ unless `outDir` says otherwise.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Erp } from "../core/erp";
import { decide, recordPastCase, requestSignoff } from "../core/signoff";
import { type Caller, hasKey } from "../grok/client";
import { dataPath } from "../paths";
import { exportForDispute } from "../shipping/service";
import { readClaim } from "./claim_reader";
import { type Catalog, MiniErpStore } from "./mini_erp";
import { type DisputeOutcome, emitOutcome, todayIso } from "./outcome";
import { pullFacts } from "./pull_facts";
import { decideVerdict, defaultPlaybookPath } from "./verdict";

export const OUTCOME_KINDS: Record<string, string> = {
  td04_xml: "FatturaPA TD04",
  edi_invoic_381: "INVOIC 381",
  reject_reply: "claim reply",
  outcome_json: "outcome",
};

type Obj = Record<string, unknown>;

/** Where the app writes outcome files. */
export const runtimeOutDir = () => dataPath("runtime", "disputes");

/**
 * The app's Playbook: a copy of data/disputes/playbook.md made on first use
 * (BRC_PLAYBOOK overrides the path, like BRC_DB for the database; tests use it).
 */
export function runtimePlaybookPath(): string {
  const path = process.env.BRC_PLAYBOOK || dataPath("runtime", "playbook.md");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(defaultPlaybookPath(), path);
  }
  return path;
}

/** Shipping's export of the Mini ERP, with the Dispute fixtures behind it. */
export function disputeStore(erp: Erp, includeFixtures = true): MiniErpStore {
  const live = MiniErpStore.fromDict(exportForDispute(erp) as Catalog, { label: "Mini ERP (core/erp.py)" });
  return includeFixtures ? live.mergedWith(MiniErpStore.load()) : live;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function saveOutcome(erp: Erp, claimId: string, outcome: DisputeOutcome) {
  for (const [key, path] of Object.entries(outcome.paths)) {
    const body = isFile(path) ? readFileSync(path, "utf8") : null;
    const docId = erp.addDocument(OUTCOME_KINDS[key] ?? key, claimId, body, { path });
    erp.log("code", `dispute.${key}`, claimId, { sourceDoc: docId });
  }
  erp.setClaim(claimId, {
    status: outcome.kind !== "awaiting_sign_off" ? "closed" : "awaiting_sign_off",
    outcome: outcome as unknown as Obj,
  });
}

export type HandleClaimResult =
  | { status: "awaiting_person"; claim_id: string; case_id: string; verdict: Obj }
  | { status: "closed"; claim_id: string; verdict: Obj; outcome: DisputeOutcome };

export async function handleClaim(
  erp: Erp,
  emailText: string,
  opts: {
    outDir?: string | null;
    sourceName?: string;
    readCaller?: Caller | null;
    verdictCaller?: Caller | null;
    includeFixtures?: boolean;
    issueDate?: string | null;
    playbookPath?: string | null;
  } = {},
): Promise<HandleClaimResult> {
  const outDir = opts.outDir || runtimeOutDir();
  const docId = erp.addDocument("claim email", null, emailText, { path: opts.sourceName ?? "claim email" });
  const claimId = erp.nextId("claim", "CLM-");
  erp.saveClaim({ claimId, sourceDoc: docId, status: "received" });
  erp.log("retailer", "dispute.claim_received", claimId, { sourceDoc: docId });

  const extraction = await readClaim(emailText, { caller: opts.readCaller });
  erp.log("grok", "dispute.claim_read", claimId, { sourceDoc: docId, detail: extraction });
  const facts = pullFacts(extraction, { store: disputeStore(erp, opts.includeFixtures ?? true) });
  erp.log("code", "dispute.facts_pulled", claimId, {
    detail: { misses: facts.misses, threeway: facts.threeway ? facts.threeway.summary : null },
  });
  const verdict = await decideVerdict(extraction, facts, {
    caller: opts.verdictCaller,
    playbookPath: opts.playbookPath || runtimePlaybookPath(),
  });
  const verdictDict: Obj = { ...verdict, claim: extraction };
  erp.log("grok", "dispute.verdict", claimId, {
    detail: { decision: verdict.decision, amount: verdict.amount, sign_off_reasons: verdict.sign_off_reasons },
  });
  erp.setClaim(claimId, {
    orderRef: extraction.order_ref,
    invoiceRef: extraction.invoice_ref,
    extraction: extraction as unknown as Obj,
    verdict: verdictDict,
  });

  const factsDict = facts as unknown as Obj;
  if (verdict.needs_sign_off) {
    const caseId = requestSignoff(erp, {
      row: "dispute",
      kind: "verdict",
      subjectRef: claimId,
      title: `Claim ${claimId} on ${extraction.order_ref || "an unknown order"}: Grok proposes ${verdict.decision}`,
      proposal: { verdict: verdictDict, facts: factsDict, out_dir: outDir },
      reasons: verdict.sign_off_reasons,
    });
    erp.setClaim(claimId, { status: "awaiting_sign_off" });
    return { status: "awaiting_person", claim_id: claimId, case_id: caseId, verdict: verdictDict };
  }

  const outcome = emitOutcome(verdictDict, { facts: factsDict, outDir, issueDate: opts.issueDate });
  saveOutcome(erp, claimId, outcome);
  return { status: "closed", claim_id: claimId, verdict: verdictDict, outcome };
}

function disputeCase(erp: Erp, caseId: string) {
  const c = erp.signoff(caseId);
  if (!c || c.row !== "dispute") throw new Error(`${caseId} is not a dispute sign-off`);
  return c;
}

export function approveVerdict(
  erp: Erp,
  caseId: string,
  opts: { by: string; reason: string; playbookPath?: string | null; issueDate?: string | null; edits?: Obj | null },
): { status: "closed"; claim_id: string; outcome: DisputeOutcome } {
  const c = disputeCase(erp, caseId);
  decide(erp, caseId, { approve: true, by: opts.by, reason: opts.reason, edits: opts.edits ?? null });
  const proposal = (c.proposal ?? {}) as Obj;
  const verdict = (proposal.verdict ?? {}) as Obj;
  const outcome = emitOutcome(verdict, {
    facts: (proposal.facts as Obj) ?? null,
    outDir: (proposal.out_dir as string) || runtimeOutDir(),
    issueDate: opts.issueDate,
    approvedBy: opts.by,
  });
  const claimId = c.subjectRef as string;
  saveOutcome(erp, claimId, outcome);
  const claim = (verdict.claim ?? {}) as Obj;
  recordPastCase(opts.playbookPath || runtimePlaybookPath(), {
    when: opts.issueDate || todayIso(),
    orderRef: (claim.order_ref as string) || "—",
    caseType: (claim.claim_type as string) || "other",
    decision: `${String(verdict.decision)} (approved)`,
    amount: (verdict.amount as number | null) ?? null,
    notes: `${opts.by}: ${opts.reason}`,
  });
  return { status: "closed", claim_id: claimId, outcome };
}

export function rejectVerdict(
  erp: Erp,
  caseId: string,
  opts: { by: string; reason: string; playbookPath?: string | null; edits?: Obj | null },
): { status: "reopened"; claim_id: string } {
  const c = disputeCase(erp, caseId);
  decide(erp, caseId, { approve: false, by: opts.by, reason: opts.reason, edits: opts.edits ?? null });
  const verdict = ((c.proposal ?? {}) as Obj).verdict as Obj;
  const claim = (verdict?.claim ?? {}) as Obj;
  const claimId = c.subjectRef as string;
  erp.setClaim(claimId, { status: "reopened" });
  recordPastCase(opts.playbookPath || runtimePlaybookPath(), {
    when: todayIso(),
    orderRef: (claim.order_ref as string) || "—",
    caseType: (claim.claim_type as string) || "other",
    decision: `${String(verdict?.decision)} overturned`,
    amount: (verdict?.amount as number | null) ?? null,
    notes: `${opts.by}: ${opts.reason}`,
  });
  return { status: "reopened", claim_id: claimId };
}

/** Recorded Grok answers (for a demo with the network off). Same code checks apply. */
export function offlineCallers(path: string): [Caller, Caller] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { read_claim: Obj; verdict: Obj };
  return [() => ({ ...data.read_claim }), () => JSON.parse(JSON.stringify(data.verdict))];
}

// ----- recorded answers when there is no API key ------------------------------------------------

/** Demo claim fixtures with their recorded extraction and verdict (scripts/run_dispute_claim.sh). */
export const DEMO_CLAIMS: { claim: string; extraction: string; verdict: string }[] = [
  { claim: "01_shortage_messy_it.txt", extraction: "01_shortage.json", verdict: "01_shortage_accept.json" },
  { claim: "02_pricing_promo_en.txt", extraction: "02_pricing.json", verdict: "02_pricing_accept.json" },
  { claim: "03_damage_it.txt", extraction: "03_damage.json", verdict: "03_damage_accept.json" },
  { claim: "04_short_payment_incomplete.txt", extraction: "04_short_payment.json", verdict: "04_short_payment_accept.json" },
  { claim: "05_ambiguous_otif_or_shortage.txt", extraction: "05_ambiguous.json", verdict: "05_ambiguous_reject.json" },
];

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();

/** The demo claim emails the UI and the tools can offer (name and text). */
export function demoClaims(): { name: string; text: string }[] {
  const out = [{ name: "claim_email.txt", text: readFileSync(dataPath("world", "golden", "claim_email.txt"), "utf8") }];
  for (const d of DEMO_CLAIMS) out.push({ name: d.claim, text: readFileSync(dataPath("disputes", "claims", d.claim), "utf8") });
  return out;
}

/**
 * Callers for handleClaim. With an API key: none (live Grok). Without one: the recorded answers
 * for a known demo claim (the golden claim, or claims 01–05, as the demo runner does), with the
 * same keys stripped as demo.py does; otherwise an error saying a key is needed.
 */
export function callersFor(emailText: string): { readCaller: Caller | null; verdictCaller: Caller | null; mode: "live" | "offline" } {
  if (hasKey()) return { readCaller: null, verdictCaller: null, mode: "live" };
  const golden = dataPath("world", "golden", "claim_email.txt");
  if (existsSync(golden) && sameText(readFileSync(golden, "utf8"), emailText)) {
    const [readCaller, verdictCaller] = offlineCallers(dataPath("world", "golden", "grok_offline.json"));
    return { readCaller, verdictCaller, mode: "offline" };
  }
  for (const d of DEMO_CLAIMS) {
    const path = dataPath("disputes", "claims", d.claim);
    if (!existsSync(path) || !sameText(readFileSync(path, "utf8"), emailText)) continue;
    const extraction = JSON.parse(readFileSync(dataPath("disputes", "extractions", d.extraction), "utf8")) as Obj;
    const verdict = JSON.parse(readFileSync(dataPath("disputes", "verdicts", d.verdict), "utf8")) as Obj;
    for (const key of ["claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"]) delete verdict[key];
    return {
      readCaller: () => ({ ...extraction }),
      verdictCaller: () => JSON.parse(JSON.stringify(verdict)),
      mode: "offline",
    };
  }
  throw new Error(
    `No API key (XAI_API_KEY or GROK_API_KEY) and no recorded Grok answers for this claim; ` +
      `offline mode only replays the demo claims (${[basename(golden), ...DEMO_CLAIMS.map((d) => d.claim)].join(", ")}).`,
  );
}
