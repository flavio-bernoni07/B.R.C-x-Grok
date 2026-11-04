/**
 * Dispute row: Vitest port of tests/test_claim_reader.py, test_pull_facts.py, test_verdict.py,
 * test_outcome.py and test_dispute_service.py. Grok is replaced by callers; no network, no key.
 * The Python CLI tests (`main`) have no TypeScript CLI; their checks are kept on the functions.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshErp } from "../agent/lib/core/world";
import { DEFAULT_MODEL, MissingApiKeyError } from "../agent/lib/grok/client";
import { dataPath } from "../agent/lib/paths";
import { type ClaimExtraction, ClaimType, loadClaimFile, model, parseExtraction, readClaim, refineClaimType } from "../agent/lib/dispute/claim_reader";
import { MiniErpStore, normalizeRef } from "../agent/lib/dispute/mini_erp";
import { buildEdiInvoic381, emitOutcome, loadVerdictJson, resolveFacts } from "../agent/lib/dispute/outcome";
import { loadClaimJson, pullFacts } from "../agent/lib/dispute/pull_facts";
import {
  collectKnownAmounts,
  decideVerdict,
  loadText,
  normalizeAmounts,
  parseVerdictPayload,
  VerdictDecision,
  type VerdictPoint,
} from "../agent/lib/dispute/verdict";
import { approveVerdict, handleClaim, offlineCallers, rejectVerdict } from "../agent/lib/dispute/service";
import { decideSignoff } from "../agent/lib/dispute/decide";
import { claimDetail, listClaims } from "../agent/lib/dispute/views";

const DISPUTES = dataPath("disputes");
const CLAIMS = join(DISPUTES, "claims");
const EXTRACTIONS = join(DISPUTES, "extractions");
const VERDICTS = join(DISPUTES, "verdicts");
const PLAYBOOK = join(DISPUTES, "playbook.md");
const CONTRACT = join(DISPUTES, "contract_excerpt.md");

const ENV_KEYS = ["BRC_PLAYBOOK", "XAI_API_KEY", "GROK_API_KEY", "XAI_MODEL", "GROK_MODEL", "XAI_MODEL_DISPUTE_READ_CLAIM"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const tmp = () => mkdtempSync(join(tmpdir(), "dispute-"));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

// ----- claim_reader ------------------------------------------------------------------------------
describe("claim reader", () => {
  it("maps fields and nulls", () => {
    const r = parseExtraction({
      order_ref: "RS-2026-00481",
      invoice_ref: null,
      product: "Arborio 1kg",
      quantity: 12,
      amount: "186,00",
      claim_type: "shortage",
      confidence: 0.91,
      raw_notes: "invoice present in email but left null in this fixture test",
    });
    expect(r.order_ref).toBe("RS-2026-00481");
    expect(r.invoice_ref).toBeNull();
    expect(r.product).toBe("Arborio 1kg");
    expect(r.quantity).toBe(12);
    expect(r.amount).toBe(186);
    expect(r.claim_type).toBe(ClaimType.SHORTAGE);
    expect(r.confidence).toBe(0.91);
  });

  it("rejects invented blank refs", () => {
    const r = parseExtraction({
      order_ref: "  ",
      invoice_ref: "n/a",
      product: null,
      quantity: null,
      amount: null,
      claim_type: "weird_type",
      confidence: 2.5,
      raw_notes: "ambiguous",
    });
    expect(r.order_ref).toBeNull();
    expect(r.invoice_ref).toBeNull();
    expect(r.claim_type).toBe(ClaimType.OTHER);
    expect(r.confidence).toBe(1);
  });

  it("uses an injected Grok caller", async () => {
    const out = await readClaim("dummy email body", {
      caller: () => ({
        order_ref: "PO77821",
        invoice_ref: "INV2026-0891",
        product: "Basmati 500g",
        quantity: 200,
        amount: 72.0,
        claim_type: "pricing",
        confidence: 0.88,
        raw_notes: "promo price variance",
      }),
    });
    expect(out.claim_type).toBe("pricing");
    expect(out.amount).toBe(72);
  });

  it("fails clearly without a key", async () => {
    await expect(readClaim("Buongiorno, contestiamo la fattura.")).rejects.toThrow(MissingApiKeyError);
    await expect(readClaim("Buongiorno, contestiamo la fattura.")).rejects.toThrow(/XAI_API_KEY or GROK_API_KEY/);
  });

  it("has the claim fixtures", () => {
    for (const name of [
      "01_shortage_messy_it.txt",
      "02_pricing_promo_en.txt",
      "03_damage_it.txt",
      "04_short_payment_incomplete.txt",
      "05_ambiguous_otif_or_shortage.txt",
    ]) {
      expect(loadClaimFile(join(CLAIMS, name)).trim().length).toBeGreaterThan(40);
    }
    expect(() => loadClaimFile(join(CLAIMS, "nope.txt"))).toThrow(/not found/);
    expect(loadClaimFile(join(CLAIMS, "03_damage_it.txt")).toLowerCase()).toMatch(/danneggiat[ai]/);
  });

  it("reads the shortage fixture with a mock", async () => {
    const text = loadClaimFile(join(CLAIMS, "01_shortage_messy_it.txt"));
    const out = await readClaim(text, {
      caller: (messages) => {
        const claim = messages.at(-1)!.content.toLowerCase();
        expect(claim.includes("mancano") || claim.includes("colli")).toBe(true);
        return {
          order_ref: "RS-2026-00481",
          invoice_ref: "FT-2026/1187",
          product: "Riso Scotti Arborio 1kg",
          quantity: 12,
          amount: 186.0,
          claim_type: "shortage",
          confidence: 0.9,
          raw_notes: "spacing typo in PO",
        };
      },
    });
    expect(out.claim_type).toBe("shortage");
    expect(out.order_ref).toBe("RS-2026-00481");
    expect(out.invoice_ref).toBe("FT-2026/1187");
  });

  it("maps remittance PRI/UNK to pricing", () => {
    const r = parseExtraction({
      order_ref: "RS2026/771",
      invoice_ref: "334",
      product: "Arborio sottovuoto",
      quantity: 100,
      amount: 70.0,
      claim_type: "other",
      confidence: 0.55,
      raw_notes: "Remittance PRI/UNK; price hold 70",
    });
    expect(r.claim_type).toBe("pricing");
  });

  it("refines claim type from short-pay text only for other", () => {
    expect(refineClaimType("other", { claimText: "REMITTANCE ADVICE\nInvoice paid short.\nUnit price hold" })).toBe("pricing");
    expect(refineClaimType("shortage", { rawNotes: "PRI/UNK" })).toBe("shortage");
  });

  it("keeps fixture 04 as pricing", () => {
    const payload = json(join(EXTRACTIONS, "04_short_payment.json"));
    expect(payload.claim_type).toBe("pricing");
    expect(parseExtraction(payload).claim_type).toBe("pricing");
  });

  it("picks the model from the environment (TS default is the shared client's)", () => {
    expect(model()).toBe(DEFAULT_MODEL);
    process.env.XAI_MODEL = "grok-3";
    process.env.GROK_MODEL = "ignored-when-xai-set";
    expect(model()).toBe("grok-3");
    delete process.env.XAI_MODEL;
    expect(model()).toBe("ignored-when-xai-set");
  });
});

// ----- mini_erp + pull_facts ---------------------------------------------------------------------
describe("pull facts", () => {
  it("normalizes refs", () => {
    expect(normalizeRef("RS-2026-00481")).toBe("RS202600481");
    expect(normalizeRef("INV 2026-0891")).toBe("INV20260891");
    expect(normalizeRef("PO RS 2026 00481")).toContain(normalizeRef("RS-2026-00481"));
  });

  it("flags the shortage qty gap", () => {
    const facts = pullFacts(loadClaimJson(join(EXTRACTIONS, "01_shortage.json")));
    expect(facts.order && facts.desadv && facts.invoice).toBeTruthy();
    expect(facts.misses).toEqual([]);
    const line = facts.threeway!.lines[0];
    expect(line.status).toBe("exception");
    expect(line.received).toBe(28);
    expect(line.invoiced).toBe(40);
    expect(line.reason.includes("Billed for more than was received") || line.reason.includes("Short delivery")).toBe(true);
    expect(facts.proofs.some((p) => p.kind === "warehouse_event")).toBe(true);
    expect(facts.proofs.some((p) => p.kind === "ddt")).toBe(true);
    expect(facts.threeway!.summary.exception).toBeGreaterThanOrEqual(1);
    expect(facts.catalog_path).toBeTruthy();
  });

  it("flags the pricing gap", () => {
    const facts = pullFacts(loadClaimJson(join(EXTRACTIONS, "02_pricing.json")));
    expect(facts.order!.order_ref).toBe("PO77821");
    expect(facts.invoice!.invoice_ref).toBe("INV2026-0891");
    const line = facts.threeway!.lines[0];
    expect(line.status).toBe("exception");
    expect(line.reason).toBe("Invoice price differs from the PO price");
    expect(facts.proofs.some((p) => p.kind === "contract_excerpt")).toBe(true);
  });

  it("recovers the damage invoice by order", () => {
    const claim = loadClaimJson(join(EXTRACTIONS, "03_damage.json"));
    expect(claim.invoice_ref).toBeNull();
    const facts = pullFacts(claim);
    expect(facts.order!.order_ref).toBe("RS-ORD-99102");
    expect(facts.invoice!.invoice_ref).toBe("FT-2026/2201");
    expect(facts.threeway!.lines[0].status).toBe("matched");
    expect(facts.proofs.some((p) => p.ref === "4521")).toBe(true);
  });

  it("matches a short-payment invoice fragment", () => {
    const facts = pullFacts(loadClaimJson(join(EXTRACTIONS, "04_short_payment.json")));
    expect(facts.invoice!.invoice_ref).toBe("FT-2026/0334");
    expect(facts.threeway!.lines[0].reason).toBe("Invoice price differs from the PO price");
    expect(Math.abs(facts.threeway!.lines[0].value_variance - 70)).toBeLessThan(0.01);
    expect(facts.claim.claim_type).toBe("pricing");
  });

  it("maps other to pricing on a threeway price gap", () => {
    const claim: ClaimExtraction = {
      order_ref: "RS2026/771",
      invoice_ref: "334",
      product: "Riso Scotti Arborio sottovuoto 1kg",
      quantity: 100,
      amount: 70.0,
      claim_type: "other",
      confidence: 0.4,
      raw_notes: "portal blank type",
    };
    const facts = pullFacts(claim);
    expect(facts.claim.claim_type).toBe("pricing");
    expect(facts.claim.raw_notes).toContain("threeway price gap");
  });

  it("resolves the ambiguous alias", () => {
    const facts = pullFacts(loadClaimJson(join(EXTRACTIONS, "05_ambiguous.json")));
    expect(facts.order!.order_ref).toBe("RS26112");
    expect(facts.desadv).toBeTruthy();
    expect(facts.invoice).toBeTruthy();
    const statuses = new Set(facts.threeway!.lines.map((l) => l.status));
    expect(statuses.has("exception") || statuses.has("check") || statuses.has("matched")).toBe(true);
    expect(facts.proofs.some((p) => (p.summary ?? "").includes("OTIF") || p.kind === "warehouse_event")).toBe(true);
  });

  it("records a lookup miss for an unknown order", () => {
    const facts = pullFacts({
      order_ref: "DOES-NOT-EXIST",
      invoice_ref: null,
      product: null,
      quantity: null,
      amount: null,
      claim_type: "other",
      confidence: 0.1,
      raw_notes: "unknown",
    });
    expect(facts.order).toBeNull();
    expect(facts.threeway).toBeNull();
    expect(facts.misses.map((m) => m.kind)).toContain("order");
  });

  it("covers every demo order in the catalog", () => {
    const found = new Set(MiniErpStore.load().orders.map((o) => o.order_ref));
    for (const ref of ["RS-2026-00481", "PO77821", "RS-ORD-99102", "RS2026/771", "RS26112"]) expect(found.has(ref)).toBe(true);
  });
});

// ----- verdict -----------------------------------------------------------------------------------
const shortageBundle = () => {
  const claim = loadClaimJson(join(EXTRACTIONS, "01_shortage.json"));
  return { claim, facts: pullFacts(claim) };
};

const clearPayload = (amount = 2000.0, overrides: Record<string, unknown> = {}) => ({
  decision: "accept",
  amount,
  confidence: 0.9,
  needs_sign_off: false,
  summary: "Clear over-billing",
  points: [
    { text: "Billed for more than was received", amount, source: { kind: "threeway", ref: "Billed for more than was received", detail: "" } },
  ],
  ...overrides,
});

const CLEAR_CLAIM = {
  order_ref: "RS-2026-00481",
  invoice_ref: "FT-2026/1187",
  product: "Riso Scotti Arborio 1kg",
  quantity: 129,
  amount: 2000.0,
  claim_type: "shortage",
  confidence: 0.92,
  raw_notes: "",
};

describe("verdict", () => {
  it("has the Playbook and the contract excerpt", () => {
    const playbook = loadText(PLAYBOOK);
    const contract = loadText(CONTRACT);
    expect(playbook.toLowerCase()).toContain("shortage");
    expect(playbook).toContain("Past cases");
    expect(contract.toLowerCase()).toContain("complaint");
    expect(contract).toContain("1.49");
    expect(contract.toLowerCase()).toContain("tolerance");
  });

  it("collects known amounts from claim and threeway", () => {
    const { claim, facts } = shortageBundle();
    const known = collectKnownAmounts(claim, facts);
    expect(known).toContain(186);
    expect(known).toContain(15.5);
  });

  it("drops invented amounts", () => {
    const points: VerdictPoint[] = [
      { text: "invented", amount: 9999.0, source: { kind: "other", ref: "x", detail: "" } },
      { text: "ok", amount: 186.0, source: { kind: "threeway", ref: "qty", detail: "" } },
    ];
    const [amount, fixed, notes] = normalizeAmounts(VerdictDecision.ACCEPT, 9999.0, points, [186.0, 72.0]);
    expect([186, null, 72]).toContain(amount);
    expect(fixed.every((p) => p.amount !== 9999)).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("maps the decision", () => {
    const v = parseVerdictPayload(
      {
        decision: "partial",
        amount: 72.0,
        confidence: 0.8,
        needs_sign_off: false,
        summary: "Promo price gap",
        points: [{ text: "Invoice above promo", amount: 72.0, source: { kind: "contract", ref: "RS-PROMO-AUT26", detail: "€1.49 vs €1.85" } }],
      },
      { knownAmounts: [72.0, 1.49, 1.85] },
    );
    expect(v.decision).toBe("partial");
    expect(v.amount).toBe(72);
    expect(v.points).toHaveLength(1);
    expect(v.points[0].source.ref).toBe("RS-PROMO-AUT26");
  });

  it("decides with a mocked Grok", async () => {
    const { claim, facts } = shortageBundle();
    const v = await decideVerdict(claim, facts, {
      caller: (messages) => {
        expect(messages.some((m) => m.content.includes("PLAYBOOK"))).toBe(true);
        expect(messages.some((m) => m.content.includes("known_amounts_eur"))).toBe(true);
        return {
          decision: "accept",
          amount: 186.0,
          confidence: 0.9,
          needs_sign_off: false,
          summary: "Invoiced 40 vs DESADV/DDT 28; credit short-shipped cartons.",
          points: [
            { text: "Over-billed 12 CTN vs DESADV", amount: 186.0, source: { kind: "threeway", ref: "Billed for more than was received", detail: "invoiced 40 received 28" } },
            { text: "Signed DDT confirms 28 CTN", amount: null, source: { kind: "ddt", ref: "DDT-1187", detail: "quantity_confirmed 28" } },
          ],
        };
      },
    });
    expect(v.decision).toBe("accept");
    expect(v.amount).toBe(186);
    expect(v.points).toHaveLength(2);
    expect(v.playbook_path!.endsWith("playbook.md")).toBe(true);
  });

  it("rejects an invented amount and asks a person", async () => {
    const { claim, facts } = shortageBundle();
    const v = await decideVerdict(claim, facts, {
      caller: () => ({
        decision: "accept",
        amount: 12345.67,
        confidence: 0.99,
        needs_sign_off: false,
        summary: "bad invent",
        points: [{ text: "made up", amount: 12345.67, source: { kind: "other", ref: "none", detail: "" } }],
      }),
    });
    expect(v.amount).not.toBe(12345.67);
    expect(v.points.every((p) => p.amount !== 12345.67)).toBe(true);
    expect(v.amount_notes.length).toBeGreaterThan(0);
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons).toContain("Grok proposed an amount that is not in the documents");
  });

  it("fails clearly without a key", async () => {
    const { claim, facts } = shortageBundle();
    await expect(decideVerdict(claim, facts)).rejects.toThrow(MissingApiKeyError);
  });

  it("dry run data: known amounts for the pricing claim", () => {
    const claim = loadClaimJson(join(EXTRACTIONS, "02_pricing.json"));
    const facts = pullFacts(claim);
    expect(facts.order!.order_ref).toBe("PO77821");
    expect(collectKnownAmounts(claim, facts)).toContain(72);
  });

  // Sign-off: no euro threshold, only ambiguity sends a case to a person.
  it("lets a large clear credit go without a person", () => {
    const v = parseVerdictPayload(clearPayload(2000), { knownAmounts: [2000], claim: CLEAR_CLAIM, facts: { misses: [] } });
    expect(v.amount).toBe(2000);
    expect(v.needs_sign_off).toBe(false);
    expect(v.sign_off_reasons).toEqual([]);
  });

  it("asks a person when Grok is unsure", () => {
    const v = parseVerdictPayload(clearPayload(186, { needs_sign_off: true }), { knownAmounts: [186] });
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons).toContain("Grok marked the case as unsure");
  });

  it("asks a person on low verdict confidence", () => {
    const v = parseVerdictPayload(clearPayload(186, { confidence: 0.5 }), { knownAmounts: [186] });
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons.some((r) => r.includes("verdict confidence"))).toBe(true);
    expect(v.sign_off_reasons).toContain("verdict confidence 0.50 is under 0.55");
  });

  it("asks a person when a point has no source", () => {
    const payload = clearPayload(186);
    (payload.points[0] as { source: unknown }).source = {};
    const v = parseVerdictPayload(payload, { knownAmounts: [186] });
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons).toContain("a point has no source");
  });

  it("asks a person for a claim type not in the Playbook", () => {
    const claim = { ...CLEAR_CLAIM, claim_type: "other", amount: 70.0, order_ref: "RS2026/771" };
    const v = parseVerdictPayload(clearPayload(70), { knownAmounts: [70], claim, facts: { misses: [] } });
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons).toContain("the claim type is not covered by the Playbook");
  });

  it("asks a person when the claim reading is unsure", () => {
    const v = parseVerdictPayload(clearPayload(186), { knownAmounts: [186], claim: { ...CLEAR_CLAIM, confidence: 0.4 } });
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons.some((r) => r.includes("claim reading confidence"))).toBe(true);
  });

  it("asks a person when a document is missing", () => {
    const facts = { misses: [{ kind: "invoice", queried: "334", detail: "No invoice matched" }] };
    const v = parseVerdictPayload(clearPayload(186), { knownAmounts: [186], claim: CLEAR_CLAIM, facts });
    expect(v.needs_sign_off).toBe(true);
    expect(v.sign_off_reasons).toContain("documents not found: invoice");
  });

  it("lets a clear shortage go without a person", async () => {
    const { claim, facts } = shortageBundle();
    const v = await decideVerdict(claim, facts, { caller: () => clearPayload(186) });
    expect(v.needs_sign_off).toBe(false);
    expect(v.sign_off_reasons).toEqual([]);
  });
});

// ----- outcome -----------------------------------------------------------------------------------
describe("outcome", () => {
  it("emits a TD04 credit note", () => {
    const dir = tmp();
    const verdict = loadVerdictJson(join(VERDICTS, "01_shortage_accept.json"));
    const outcome = emitOutcome(verdict, { facts: resolveFacts(verdict), outDir: dir, issueDate: "2026-11-04" });
    expect(outcome.kind).toBe("credit_note");
    expect(outcome.decision).toBe("accept");
    expect(outcome.amount).toBe(186);
    expect(outcome.credit_note_number).toBe("NC-20261104-RS202600481");
    const xml = readFileSync(outcome.paths.td04_xml, "utf8");
    expect(xml).toContain("TD04");
    expect(xml).toContain("DEMO FatturaPA TD04");
    expect(xml).toContain("186.00");
    expect(xml).toContain("FT-2026/1187");
    // FatturaPA 1.2 structure as a38 writes it: 186.00 = 178.85 taxable + 7.15 VAT at 4%.
    expect(xml).toContain("<ImportoTotaleDocumento>186.00</ImportoTotaleDocumento>");
    expect(xml).toContain("<ImponibileImporto>178.85</ImponibileImporto><Imposta>7.15</Imposta>");
    expect(xml).toContain("<Denominazione>Esselunga</Denominazione>");
    expect(xml).toContain("<DatiFattureCollegate><IdDocumento>FT-2026/1187</IdDocumento><Data>2026-10-28</Data><CodiceCommessaConvenzione>RS-2026-00481</CodiceCommessaConvenzione></DatiFattureCollegate>");
    const edi = readFileSync(outcome.paths.edi_invoic_381, "utf8");
    expect(edi).toContain("BGM+381+");
    expect(edi).toContain("MOA+86:186.00:EUR'");
    const meta = json(outcome.paths.outcome_json);
    expect(meta.kind).toBe("credit_note");
    expect(meta.order_ref).toBe("RS-2026-00481");
  });

  it("matches the Python TD04 amounts for the pricing claim", () => {
    const dir = tmp();
    const verdict = loadVerdictJson(join(VERDICTS, "02_pricing_accept.json"));
    const outcome = emitOutcome(verdict, { facts: resolveFacts(verdict), outDir: dir, issueDate: "2026-11-04" });
    expect(outcome.amount).toBe(72);
    const xml = readFileSync(outcome.paths.td04_xml, "utf8");
    expect(xml).toContain("INV2026-0891");
    expect(xml).toContain("TD04");
    // Same figures as data/disputes/outcomes/PO77821_TD04.xml (written by a38).
    const python = readFileSync(join(DISPUTES, "outcomes", "PO77821_TD04.xml"), "utf8");
    for (const tag of ["ImportoTotaleDocumento", "PrezzoUnitario", "PrezzoTotale", "ImponibileImporto", "Imposta", "Numero", "Quantita"]) {
      const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
      expect(xml.match(re)?.[1], tag).toBe(python.match(re)?.[1]);
    }
    const strip = (s: string) => s.replace(/<ProgressivoInvio>[^<]*<\/ProgressivoInvio>/, "").replace(/<Descrizione>[^<]*<\/Descrizione>/, "").replace(/<Causale>[^<]*<\/Causale>/g, "").split("\n").slice(2).join("\n").trim();
    expect(strip(xml)).toBe(strip(python));
  });

  it("waits for a person on an ambiguous verdict", () => {
    const dir = tmp();
    const verdict = loadVerdictJson(join(VERDICTS, "05_ambiguous_reject.json"));
    const outcome = emitOutcome(verdict, { facts: resolveFacts(verdict), outDir: dir, issueDate: "2026-11-04" });
    expect(outcome.kind).toBe("awaiting_sign_off");
    expect(outcome.sign_off_reasons.length).toBeGreaterThan(0);
    expect(outcome.paths.reject_reply).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.endsWith("_reject_reply.txt") || f.endsWith("_TD04.xml"))).toEqual([]);
    expect(json(outcome.paths.outcome_json).kind).toBe("awaiting_sign_off");
  });

  it("has no sign-off reasons on a clear verdict", () => {
    const verdict = loadVerdictJson(join(VERDICTS, "01_shortage_accept.json"));
    const outcome = emitOutcome(verdict, { facts: resolveFacts(verdict), outDir: tmp() });
    expect(outcome.kind).toBe("credit_note");
    expect(outcome.sign_off_reasons).toEqual([]);
    expect(outcome.approved_by).toBeNull();
  });

  it("writes the evidence reply once a person approves", () => {
    const verdict = loadVerdictJson(join(VERDICTS, "05_ambiguous_reject.json"));
    const outcome = emitOutcome(verdict, { facts: resolveFacts(verdict), outDir: tmp(), issueDate: "2026-11-04", approvedBy: "EMP-DISPUTE-01" });
    expect(outcome.approved_by).toBe("EMP-DISPUTE-01");
    expect(outcome.kind).toBe("reject_reply");
    expect(outcome.decision).toBe("reject");
    expect(outcome.credit_note_number).toBeNull();
    const text = readFileSync(outcome.paths.reject_reply, "utf8");
    expect(text).toContain("REJECT");
    expect(text).toContain("RS26112");
    expect(text).toContain("DESADV-2026-26112");
    expect(text.includes("GATE-IPER") || text.includes("DDT-26112")).toBe(true);
    expect(text).not.toContain("Playbook");
    expect(text).not.toContain("dispute.outcome");
    expect(text).not.toContain("out of scope");
    expect(text.includes("Despatch advice") || text.includes("Delivery note")).toBe(true);
    // Same evidence lines as the Python reply in data/disputes/outcomes/RS26112_reject_reply.txt.
    const python = readFileSync(join(DISPUTES, "outcomes", "RS26112_reject_reply.txt"), "utf8");
    for (const line of python.split("\n").filter((l) => l.startsWith("- "))) expect(text).toContain(line);
  });

  it("writes EDI BGM 381", () => {
    const edi = buildEdiInvoic381({ amount: "72.00", invoiceRef: "INV2026-0891", orderRef: "PO77821", creditNoteNumber: "NC-TEST", issueDate: "2026-11-04" });
    expect(edi).toContain("BGM+381+NC-TEST+9'");
    expect(edi).toContain("RFF+IV:INV2026-0891'");
    expect(edi).toContain("RFF+ON:PO77821'");
    expect(edi).toBe(readFileSync(join(DISPUTES, "outcomes", "PO77821_INVOIC_381.edi"), "utf8").replace("NC-20261104-PO77821", "NC-TEST"));
  });
});

// ----- service (Mini ERP) --------------------------------------------------------------------------
function unclear() {
  const extraction = json(join(EXTRACTIONS, "05_ambiguous.json"));
  const verdict = json(join(VERDICTS, "05_ambiguous_reject.json"));
  for (const key of ["claim", "playbook_path", "contract_path", "amount_notes", "known_amounts"]) delete verdict[key];
  return [() => ({ ...extraction }), () => JSON.parse(JSON.stringify(verdict))] as const;
}

function playbookCopy(dir: string) {
  const path = join(dir, "playbook.md");
  copyFileSync(PLAYBOOK, path);
  return path;
}

describe("dispute service", () => {
  it("holds an unclear claim, then approval writes the reply and the Playbook", async () => {
    const erp = freshErp();
    const dir = tmp();
    const playbook = playbookCopy(dir);
    const [readCaller, verdictCaller] = unclear();
    const res = await handleClaim(erp, readFileSync(join(CLAIMS, "05_ambiguous_otif_or_shortage.txt"), "utf8"), {
      outDir: dir,
      readCaller,
      verdictCaller,
      playbookPath: playbook,
    });
    expect(res.status).toBe("awaiting_person");
    if (res.status !== "awaiting_person") return;
    expect(readdirSync(dir).filter((f) => f.endsWith("_reject_reply.txt"))).toEqual([]);
    expect(erp.claim(res.claim_id)!.status).toBe("awaiting_sign_off");
    expect(erp.signoff(res.case_id)!.reasons).toContain("Grok marked the case as unsure");

    const done = approveVerdict(erp, res.case_id, { by: "Sara", reason: "Late gate-in, quantities agree", playbookPath: playbook, issueDate: "2026-11-07" });
    expect(done.outcome.kind).toBe("reject_reply");
    expect(done.outcome.approved_by).toBe("Sara");
    expect(erp.claim(res.claim_id)!.status).toBe("closed");
    expect(readFileSync(playbook, "utf8")).toContain("| 2026-11-07 | RS26112 | other | reject (approved) |");
    expect(erp.documents({ ref: res.claim_id, kind: "claim reply" }).length).toBeGreaterThan(0);
    const actions = erp.auditLog(res.claim_id).map((a) => a.action);
    for (const a of ["dispute.claim_received", "dispute.claim_read", "dispute.facts_pulled", "dispute.verdict", "signoff.requested", "signoff.approved", "dispute.reject_reply"]) {
      expect(actions).toContain(a);
    }
  });

  it("reopens the claim when the person overturns the verdict", async () => {
    const erp = freshErp();
    const dir = tmp();
    const playbook = playbookCopy(dir);
    const [readCaller, verdictCaller] = unclear();
    const res = await handleClaim(erp, "unclear claim text", { outDir: dir, readCaller, verdictCaller, playbookPath: playbook });
    if (res.status !== "awaiting_person") throw new Error("expected a sign-off");
    rejectVerdict(erp, res.case_id, { by: "Sara", reason: "Ask Auchan for the receiving count first", playbookPath: playbook });
    expect(erp.claim(res.claim_id)!.status).toBe("reopened");
    expect(readFileSync(playbook, "utf8")).toContain("reject overturned");
  });

  it("closes a clear claim with a credit note and no person", async () => {
    const erp = freshErp();
    const dir = tmp();
    const extraction = json(join(EXTRACTIONS, "01_shortage.json"));
    const verdict = json(join(VERDICTS, "01_shortage_accept.json"));
    const res = await handleClaim(erp, readFileSync(join(CLAIMS, "01_shortage_messy_it.txt"), "utf8"), {
      outDir: dir,
      readCaller: () => extraction,
      verdictCaller: () => verdict,
      playbookPath: playbookCopy(dir),
      issueDate: "2026-11-04",
    });
    expect(res.status).toBe("closed");
    if (res.status !== "closed") return;
    expect(res.outcome.kind).toBe("credit_note");
    expect(erp.documents({ ref: res.claim_id, kind: "FatturaPA TD04" })).toHaveLength(1);
    expect(erp.documents({ ref: res.claim_id, kind: "INVOIC 381" })).toHaveLength(1);
    expect(erp.signoffs({ row: "dispute" })).toHaveLength(0);

    const rows = listClaims(erp);
    expect(rows[0].claim_id).toBe(res.claim_id);
    expect(rows[0].grok!.sources).toBe(3);
    expect(rows[0].customer).toBe("Esselunga");
    const detail = claimDetail(erp, res.claim_id)!;
    expect(detail.email!.body).toContain("colli");
    expect(detail.facts!.threeway!.lines[0].status).toBe("exception");
    expect(detail.documents.map((d) => d.kind)).toEqual(expect.arrayContaining(["FatturaPA TD04", "INVOIC 381", "outcome"]));
  });

  it("runs the sign-off decision through decideSignoff", async () => {
    const erp = freshErp();
    const dir = tmp();
    const playbook = playbookCopy(dir);
    const [readCaller, verdictCaller] = unclear();
    process.env.BRC_PLAYBOOK = join(dir, "runtime-playbook.md");
    const res = await handleClaim(erp, "unclear claim text", { outDir: dir, readCaller, verdictCaller, playbookPath: playbook });
    if (res.status !== "awaiting_person") throw new Error("expected a sign-off");
    const out = await decideSignoff(erp, res.case_id, { approve: true, by: "Sara", reason: "Quantities agree" });
    expect(out.status).toBe("closed");
    expect(erp.signoff(res.case_id)!.status).toBe("approved");
    // The default Playbook for the app is a runtime copy, never data/disputes/playbook.md.
    expect(readFileSync(PLAYBOOK, "utf8").includes("No past cases yet")).toBe(true);
    expect(readFileSync(process.env.BRC_PLAYBOOK!, "utf8")).toContain("reject (approved)");
  });

  it("loads the recorded golden answers", async () => {
    const [readCaller, verdictCaller] = offlineCallers(dataPath("world", "golden", "grok_offline.json"));
    const extraction = await readClaim(readFileSync(dataPath("world", "golden", "claim_email.txt"), "utf8"), { caller: readCaller });
    expect(extraction.order_ref).toBe("ESS-GOLD-001");
    expect(extraction.amount).toBe(528);
    expect((await verdictCaller([])) as Record<string, unknown>).toMatchObject({ decision: "accept", amount: 528 });
  });
});
