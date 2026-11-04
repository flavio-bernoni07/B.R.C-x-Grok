/**
 * Dispute outcome: TD04 credit note (accept/partial) or evidence reply (reject)
 * (port of dispute/outcome.py).
 *
 * Code writes every document and amount from the verdict / facts / claim; nothing here invents
 * a euro total. accept / partial → FatturaPA TD04 XML (same FatturaPA 1.2 structure the Python
 * `a38` builder emits, with the DEMO banner) + a minimal EDI INVOIC with BGM 381.
 * reject → a retailer-facing evidence reply.
 *
 * Sign-off: no euro threshold. An ambiguous verdict writes nothing for the retailer until
 * `approvedBy` names the person who signed it off; until then the outcome is awaiting_sign_off.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUYER_DEFAULT, DEMO_ALIQUOTA_IVA, SELLER } from "../core/seller";
import { dataPath } from "../paths";
import { parseExtraction } from "./claim_reader";
import { pullFacts } from "./pull_facts";
import { parseVerdictPayload, pyNum, VerdictDecision } from "./verdict";

export const defaultOutDir = () => dataPath("disputes", "outcomes");

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export type OutcomeKind = "credit_note" | "reject_reply" | "awaiting_sign_off";

/** The outcome as a JSON document (Python key names). */
export type DisputeOutcome = {
  kind: OutcomeKind;
  decision: string;
  amount: number | null;
  order_ref: string | null;
  invoice_ref: string | null;
  credit_note_number: string | null;
  paths: Record<string, string>;
  evidence_refs: { kind: string; ref: string; detail: string; text: string }[];
  notes: string[];
  sign_off_reasons: string[];
  approved_by: string | null;
};

export function loadVerdictJson(path: string): Obj {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Verdict JSON must be an object: ${path}`);
  return payload as Obj;
}

// ----- money in integer cents, ROUND_HALF_UP like Python's Decimal -----------------------------
const toCents = (v: number) => Math.round((Math.abs(v) + Number.EPSILON) * 100) * Math.sign(v || 1);
/** Positive num/den rounded half up to an integer. */
const divHalfUp = (num: number, den: number) => Math.floor((2 * num + den) / (2 * den));
const fmtCents = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

/** Decimal(str(value)).quantize(0.01, ROUND_HALF_UP) as a string, e.g. "72.00". */
export function money(value: number | null | undefined): string {
  if (value == null) throw new Error("amount is required for credit note");
  return fmtCents(toCents(value));
}

function slug(value: string | null | undefined, fallback = "case"): string {
  const text = (value || fallback).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return text.slice(0, 48) || fallback;
}

function buyerFromFacts(facts: Obj | null | undefined): Record<string, string> {
  const buyer: Record<string, string> = { ...BUYER_DEFAULT };
  if (!facts) return buyer;
  const customer = obj(facts.order).customer;
  if (customer) buyer.denominazione = String(customer);
  return buyer;
}

const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, "");

export function creditNoteNumber(orderRef: string | null, issueDate: string): string {
  const stem = slug(orderRef, "DISP").toUpperCase().replace(/-/g, "").slice(0, 12);
  return `NC-${ymd(issueDate)}-${stem}`;
}

function lineDescription(verdict: Obj, facts: Obj | null | undefined): string {
  const claim = obj(verdict.claim);
  const firstLine = arr(obj(obj(facts).order).lines)[0] ?? {};
  const product = claim.product || firstLine.product;
  const summary = verdict.summary || "Dispute credit";
  const q = claim.quantity;
  const amount = verdict.amount;
  const bits = ["Credit note"];
  if (product) bits.push(String(product));
  if (q != null) bits.push(`qty ${typeof q === "number" ? pyNum(q) : String(q)}`);
  if (amount != null) bits.push(`€ ${typeof amount === "number" ? pyNum(amount) : String(amount)}`);
  bits.push(String(summary));
  return bits.join(" — ").slice(0, 200);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const el = (tag: string, ...children: (string | null | undefined | false)[]) => `<${tag}>${children.filter(Boolean).join("")}</${tag}>`;
const tx = (tag: string, value: string) => `<${tag}>${esc(value)}</${tag}>`;

/** A FatturaPA ProgressivoInvio (max 10 chars), unique per call like a38's generated value. */
function progressivoInvio(): string {
  return (Date.now().toString(36) + Math.floor(Math.random() * 36 ** 2).toString(36)).toUpperCase().slice(-10);
}

function validIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.slice(0, 10));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * A FatturaPA TD04 (nota di credito) XML, FatturaPrivati 1.2 (FPR12), element for element the
 * document `a38` builds in dispute/outcome.py. One line at the taxable amount, demo VAT split so
 * taxable + VAT = the verdict amount.
 */
export function buildTd04Xml(a: {
  amount: string;
  invoiceRef: string | null;
  invoiceDate: string | null;
  orderRef: string | null;
  creditNoteNumber: string;
  issueDate: string;
  description: string;
  causale: string[];
  buyer: Record<string, string>;
}): string {
  const grossCents = toCents(Number(a.amount));
  const aliquotaBp = Math.round(DEMO_ALIQUOTA_IVA * 100); // 4.00% → 400 basis points
  // imponibile + IVA = amount; imponibile = amount * 100 / (100 + aliquota), ROUND_HALF_UP.
  const imponibile = divHalfUp(grossCents * 10000, 10000 + aliquotaBp);
  const imposta = divHalfUp(imponibile * aliquotaBp, 10000);
  const totale = imponibile + imposta;
  const aliquota = fmtCents(aliquotaBp);
  const gross = fmtCents(grossCents);
  const imp = fmtCents(imponibile);

  const sede = (p: Record<string, string>) =>
    el("Sede", tx("Indirizzo", p.indirizzo), tx("CAP", p.cap), tx("Comune", p.comune), tx("Provincia", p.provincia), tx("Nazione", p.nazione));
  const idFiscale = (p: Record<string, string>) => el("IdFiscaleIVA", tx("IdPaese", p.id_paese), tx("IdCodice", p.id_codice));

  const header = el(
    "FatturaElettronicaHeader",
    el(
      "DatiTrasmissione",
      el("IdTrasmittente", tx("IdPaese", SELLER.id_paese), tx("IdCodice", SELLER.id_codice)),
      tx("ProgressivoInvio", progressivoInvio()),
      tx("FormatoTrasmissione", "FPR12"),
      tx("CodiceDestinatario", a.buyer.codice_destinatario || "XXXXXXX"),
    ),
    el(
      "CedentePrestatore",
      el("DatiAnagrafici", idFiscale(SELLER), el("Anagrafica", tx("Denominazione", SELLER.denominazione)), tx("RegimeFiscale", SELLER.regime_fiscale)),
      sede(SELLER),
    ),
    el("CessionarioCommittente", el("DatiAnagrafici", idFiscale(a.buyer), el("Anagrafica", tx("Denominazione", a.buyer.denominazione))), sede(a.buyer)),
  );

  const causale = a.causale.slice(0, 10).filter((c) => c.trim());
  const causali = (causale.length ? causale : ["Dispute credit note"]).map((c) => tx("Causale", c.slice(0, 200)));

  let collegate = "";
  if (a.invoiceRef) {
    const linkedDate = validIsoDate(a.invoiceDate);
    collegate = el(
      "DatiFattureCollegate",
      tx("IdDocumento", String(a.invoiceRef).slice(0, 20)),
      linkedDate && tx("Data", linkedDate),
      a.orderRef && tx("CodiceCommessaConvenzione", String(a.orderRef).slice(0, 100)),
    );
  }

  const body = el(
    "FatturaElettronicaBody",
    el(
      "DatiGenerali",
      el(
        "DatiGeneraliDocumento",
        tx("TipoDocumento", "TD04"),
        tx("Divisa", "EUR"),
        tx("Data", a.issueDate.slice(0, 10)),
        tx("Numero", a.creditNoteNumber),
        tx("ImportoTotaleDocumento", fmtCents(totale)),
        ...causali,
      ),
      collegate,
    ),
    el(
      "DatiBeniServizi",
      el(
        "DettaglioLinee",
        tx("NumeroLinea", "1"),
        tx("Descrizione", a.description.slice(0, 1000)),
        tx("Quantita", "1.00"),
        tx("UnitaMisura", "NR"),
        tx("PrezzoUnitario", imp),
        tx("PrezzoTotale", `${imp}00`), // Quantita 1.00 x PrezzoUnitario, 4 decimals as a38 writes it
        tx("AliquotaIVA", aliquota),
      ),
      el("DatiRiepilogo", tx("AliquotaIVA", aliquota), tx("ImponibileImporto", imp), tx("Imposta", fmtCents(imposta)), tx("EsigibilitaIVA", "I")),
    ),
  );

  const root =
    `<ns0:FatturaElettronica xmlns:ns0="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">` +
    header +
    body +
    `</ns0:FatturaElettronica>`;
  const banner = `<!-- DEMO FatturaPA TD04 nota di credito generated by dispute.outcome (TypeScript port, a38 structure); credit ${gross} EUR; not for SDI transmission -->\n`;
  return `<?xml version='1.0' encoding='utf-8'?>\n${banner}${root}`;
}

/** Minimal EDIFACT INVOIC credit hint (BGM 381). Demo stub, not a full UNA/UNB envelope. */
export function buildEdiInvoic381(a: {
  amount: string;
  invoiceRef: string | null;
  orderRef: string | null;
  creditNoteNumber: string;
  issueDate: string;
}): string {
  const lines = ["UNA:+.? '", "UNH+1+INVOIC:D:96A:UN'", `BGM+381+${a.creditNoteNumber}+9'`, `DTM+137:${ymd(a.issueDate)}:102'`, `MOA+86:${a.amount}:EUR'`];
  if (a.invoiceRef) lines.push(`RFF+IV:${a.invoiceRef}'`);
  if (a.orderRef) lines.push(`RFF+ON:${a.orderRef}'`);
  lines.push(`UNT+${lines.length}+1'`);
  return lines.join("\n") + "\n";
}

const SOURCE_LABELS: Record<string, string> = {
  order: "Purchase order",
  desadv: "Despatch advice (DESADV)",
  invoice: "Invoice",
  ddt: "Delivery note (DDT)",
  pod: "Proof of delivery",
  warehouse_event: "Warehouse / gate event",
  contract: "Contract / promo clause",
  threeway: "Order–ship–invoice match",
  damage_photo: "Damage photo / portal",
  other: "Supporting document",
};

export function evidenceLabel(kind: string | null | undefined): string {
  let key = (kind || "other").trim().toLowerCase();
  if (key.startsWith("proof:")) key = key.split(":", 2)[1] ?? key;
  return SOURCE_LABELS[key] ?? "Supporting document";
}

const pyVal = (v: unknown) => (v == null ? "None" : typeof v === "number" ? pyNum(v) : String(v));

/** Retailer-facing evidence reply; refs/amounts filled from verdict/facts by code. */
export function buildRejectReply(a: { verdict: Obj; facts: Obj | null | undefined }): string {
  const { verdict } = a;
  const facts = a.facts ?? null;
  const claim = obj(verdict.claim);
  const orderRef = claim.order_ref || obj(facts?.order).order_ref;
  const invoiceRef = claim.invoice_ref || obj(facts?.invoice).invoice_ref;
  const customer = obj(facts?.order).customer || "Customer";
  const summary = verdict.summary || "";

  // Unique evidence by document ref (retailer-facing; internal Playbook rules are skipped).
  const entries: [string, string, string][] = [];
  const addEntry = (kind: unknown, ref: unknown, body: string) => {
    const k = kind == null ? "" : String(kind);
    if (k.toLowerCase() === "playbook") return;
    const refS = (ref == null ? "" : String(ref)).trim() || "n/a";
    const text = body.trim();
    if (!text) return;
    entries.push([`${k.toLowerCase()}|${refS.toLowerCase()}`, evidenceLabel(k), `${refS} — ${text}`]);
  };

  for (const point of arr(verdict.points)) {
    const src = obj(point.source);
    const parts = [String(point.text ?? "").trim()];
    if (src.detail) parts.push(String(src.detail).trim());
    if (point.amount != null) parts.push(`amount € ${pyVal(point.amount)}`);
    addEntry(src.kind, src.ref, parts.filter(Boolean).join("; "));
  }

  if (facts) {
    for (const proof of arr(facts.proofs)) addEntry(proof.kind, proof.ref, String(proof.summary ?? ""));
    const desadv = obj(facts.desadv);
    if (desadv.desadv_ref) addEntry("desadv", desadv.desadv_ref, `linked to order ${pyVal(desadv.order_ref)}`);
    for (const line of arr(obj(facts.threeway).lines)) {
      if (!line.reason) continue;
      addEntry(
        "threeway",
        String(line.item_code || "line"),
        `${pyVal(line.reason)} (ordered ${pyVal(line.ordered)}, shipped/received ${pyVal(line.received)}, invoiced ${pyVal(line.invoiced)})`,
      );
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const [key, label, body] of entries) {
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(`- ${label}: ${body}`);
  }

  const invoiceBit = invoiceRef ? ` / invoice ${String(invoiceRef)}` : "";
  return `Subject: Your claim — decision REJECT — order ${orderRef ? String(orderRef) : "n/a"}${invoiceBit}

Dear ${String(customer)},

Thank you for your claim. We compared it with our purchase order, despatch advice (DESADV),
invoice, and warehouse / delivery evidence.

Our decision: we are not issuing a credit note on this claim.
No credit amount applies.

Why:
${String(summary)}

Evidence we relied on:
${unique.length ? unique.join("\n") : "- (no document refs available)"}

If you can provide a clearer order/invoice reference, a formal receiving count, or additional
proof, please reply and we will re-open the review.

Kind regards,
Riso Scotti — Supplier dispute desk
`;
}

export function resolveFacts(verdict: Obj, opts: { facts?: Obj | null; factsPath?: string | null; catalogPath?: string | null } = {}): Obj | null {
  if (opts.facts != null) return opts.facts;
  if (opts.factsPath) return JSON.parse(readFileSync(opts.factsPath, "utf8")) as Obj;
  const claim = verdict.claim;
  if (claim && typeof claim === "object" && ((claim as Obj).order_ref || (claim as Obj).invoice_ref)) {
    return pullFacts(parseExtraction(claim as Obj), { catalogPath: opts.catalogPath }) as unknown as Obj;
  }
  return null;
}

/** Today's date as YYYY-MM-DD (local time, like Python's date.today()). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");

/**
 * Write TD04 (+ EDI) or the reject reply under outDir and return the structured result.
 * An ambiguous verdict (needs_sign_off) writes nothing for the retailer until approvedBy
 * names the person who signed it off.
 */
export function emitOutcome(
  verdict: Obj,
  opts: { facts?: Obj | null; outDir?: string | null; issueDate?: string | null; approvedBy?: string | null } = {},
): DisputeOutcome {
  const facts = opts.facts ?? null;
  const known = arr(verdict.known_amounts).map(Number);
  const claimForChecks = verdict.claim && typeof verdict.claim === "object" && !Array.isArray(verdict.claim) ? (verdict.claim as Obj) : null;
  const parsed = parseVerdictPayload(verdict, { knownAmounts: known, claim: claimForChecks, facts });
  const decision = parsed.decision;
  const out = opts.outDir || defaultOutDir();
  mkdirSync(out, { recursive: true });

  const claim = obj(verdict.claim);
  const orderRef = str(claim.order_ref) ?? str(obj(facts?.order).order_ref);
  const invoiceRef = str(claim.invoice_ref) ?? str(obj(facts?.invoice).invoice_ref);
  const invoiceDate = str(obj(facts?.invoice).invoice_date);
  const issue = opts.issueDate || todayIso();
  const stem = slug(orderRef || invoiceRef, decision);

  const evidenceRefs = parsed.points.map((p) => ({ kind: p.source.kind, ref: p.source.ref, detail: p.source.detail, text: p.text }));

  const reasons: string[] = [];
  for (const r of [...(Array.isArray(verdict.sign_off_reasons) ? verdict.sign_off_reasons.map(String) : []), ...parsed.sign_off_reasons]) {
    if (!reasons.includes(r)) reasons.push(r);
  }
  if (verdict.needs_sign_off === true && !reasons.length) reasons.push("the verdict was marked as needing sign-off");
  const approver = (opts.approvedBy || "").trim() || null;
  const metaPath = join(out, `${stem}_outcome.json`);

  if (reasons.length && approver == null) {
    const result: DisputeOutcome = {
      kind: "awaiting_sign_off",
      decision,
      amount: parsed.amount,
      order_ref: orderRef,
      invoice_ref: invoiceRef,
      credit_note_number: null,
      paths: {},
      evidence_refs: evidenceRefs,
      notes: ["Nothing sent to the retailer: a person must approve this verdict first."],
      sign_off_reasons: reasons,
      approved_by: null,
    };
    writeJson(metaPath, result);
    result.paths.outcome_json = metaPath;
    return result;
  }

  const notes: string[] = [];
  if (approver) notes.push(`Signed off by ${approver}.`);

  if (decision === VerdictDecision.REJECT) {
    const replyPath = join(out, `${stem}_reject_reply.txt`);
    writeFileSync(replyPath, buildRejectReply({ verdict, facts }), "utf8");
    const result: DisputeOutcome = {
      kind: "reject_reply",
      decision,
      amount: parsed.amount,
      order_ref: orderRef,
      invoice_ref: invoiceRef,
      credit_note_number: null,
      paths: { reject_reply: replyPath },
      evidence_refs: evidenceRefs,
      notes,
      sign_off_reasons: reasons,
      approved_by: approver,
    };
    writeJson(metaPath, result);
    result.paths.outcome_json = metaPath;
    return result;
  }

  // accept | partial → credit note
  if (parsed.amount == null) throw new Error(`Cannot emit TD04 for decision=${decision}: verdict.amount is null`);
  const amount = money(parsed.amount);
  const cnNumber = creditNoteNumber(orderRef, issue);
  const causale = [`Dispute ${decision} order ${orderRef || "n/a"}`, (parsed.summary || "").slice(0, 200)];
  const xml = buildTd04Xml({
    amount,
    invoiceRef,
    invoiceDate,
    orderRef,
    creditNoteNumber: cnNumber,
    issueDate: issue,
    description: lineDescription(verdict, facts),
    causale,
    buyer: buyerFromFacts(facts),
  });
  if (!xml.includes("TD04")) throw new Error("Generated XML missing TipoDocumento TD04");

  const xmlPath = join(out, `${stem}_TD04.xml`);
  writeFileSync(xmlPath, xml, "utf8");
  const ediPath = join(out, `${stem}_INVOIC_381.edi`);
  writeFileSync(ediPath, buildEdiInvoic381({ amount, invoiceRef, orderRef, creditNoteNumber: cnNumber, issueDate: issue }), "utf8");
  notes.push("Built in the FatturaPA 1.2 structure a38 writes (TypeScript port; no a38 validation).");
  notes.push(`Demo VAT rate ${DEMO_ALIQUOTA_IVA.toFixed(2)}% applied so net+IVA ≈ verdict amount.`);

  const result: DisputeOutcome = {
    kind: "credit_note",
    decision,
    amount: Number(amount),
    order_ref: orderRef,
    invoice_ref: invoiceRef,
    credit_note_number: cnNumber,
    paths: { td04_xml: xmlPath, edi_invoic_381: ediPath },
    evidence_refs: evidenceRefs,
    notes,
    sign_off_reasons: reasons,
    approved_by: approver,
  };
  writeJson(metaPath, result);
  result.paths.outcome_json = metaPath;
  return result;
}
