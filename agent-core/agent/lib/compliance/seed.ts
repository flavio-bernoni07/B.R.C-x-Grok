/**
 * Seed lot-compliance source documents into the Mini ERP and apply the Basmati demo hold.
 * Covers every batch already in the ERP (fixtures + synthesized history lots).
 */
import type { Erp } from "../core/erp";
import { requestSignoff } from "../core/signoff";
import { recordEvent } from "../core/stock";
import { allPassportBatches, plantInfo, rawBatches, rawForSeed, type RawBatch } from "./passport";

function ensureDoc(erp: Erp, kind: string, ref: string, body: string): string {
  const existing = erp.documents({ ref, kind });
  if (existing.length) return existing[0]!.docId;
  return erp.addDocument(kind, ref, body);
}

function writeBatchDocs(erp: Erp, b: RawBatch): number {
  let n = 0;
  ensureDoc(
    erp,
    "Origin label",
    b.batch,
    [
      `Lot ${b.lot_mark}`,
      `Batch ${b.batch}`,
      b.origin.label,
      `Cultivation: ${b.origin.cultivation}`,
      `Processing: ${b.origin.processing}`,
      `Packing: ${b.origin.packing}`,
      "",
      "Source: DM 26 July 2017 (Italian rice origin labelling, prorogued through 31 Dec 2026).",
      "DEMO DATA — hackathon fixture.",
    ].join("\n"),
  );
  n += 1;
  ensureDoc(
    erp,
    "MRL lab report",
    b.batch,
    [
      `Report ${b.mrl.report_id}`,
      `Lab: ${b.mrl.lab}`,
      `Tested: ${b.mrl.tested_on}`,
      `Status: ${b.mrl.status}`,
      b.mrl.summary,
      "",
      "Source: Reg (EC) 396/2005 (maximum residue levels).",
      "DEMO DATA — hackathon fixture.",
    ].join("\n"),
  );
  n += 1;
  if (b.gmo.declaration_id) {
    ensureDoc(
      erp,
      "GMO-free declaration",
      b.batch,
      [
        `Declaration ${b.gmo.declaration_id}`,
        `Batch ${b.batch}`,
        b.gmo.summary,
        "",
        "Source: Reg (EC) 1829/2003 and 1830/2003.",
        "DEMO DATA — hackathon fixture.",
      ].join("\n"),
    );
    n += 1;
  }
  ensureDoc(
    erp,
    "Paddy intake",
    b.batch,
    [
      `Intake ${b.paddy_intake.id}`,
      `Supplier: ${b.paddy_intake.supplier}`,
      `Farm: ${b.paddy_intake.farm}`,
      `Region: ${b.paddy_intake.region}`,
      `Received: ${b.paddy_intake.received_on}`,
      `Tonnes: ${b.paddy_intake.tonnes}`,
      "",
      "Art. 18 one step back (Reg (EC) 178/2002).",
      "DEMO DATA — hackathon fixture.",
    ].join("\n"),
  );
  n += 1;
  if (b.badges.includes("BIO")) {
    ensureDoc(erp, "Organic cert", b.batch, [`EU organic (Reg 2018/848) — demo for ${b.batch}.`, "DEMO DATA."].join("\n"));
    n += 1;
  }
  if (b.badges.includes("Fairtrade")) {
    ensureDoc(erp, "Fairtrade cert", b.batch, [`Fairtrade — demo for ${b.batch}.`, "Voluntary scheme.", "DEMO DATA."].join("\n"));
    n += 1;
  }
  if (b.badges.includes("SRP")) {
    ensureDoc(erp, "SRP statement", b.batch, [`Sustainable Rice Platform — demo for ${b.batch}.`, "Voluntary scheme.", "DEMO DATA."].join("\n"));
    n += 1;
  }
  return n;
}

export function seedCompliance(erp: Erp, opts: { say?: (line: string) => void } = {}): { held: string[]; docs: number; signoffs: string[]; lots: number } {
  const plant = plantInfo();
  let docs = 0;
  const held: string[] = [];
  const signoffs: string[] = [];

  for (const c of plant.certs) {
    ensureDoc(
      erp,
      `Plant cert ${c.scheme}`,
      "PLANT",
      [
        `${c.scheme}${c.level ? ` ${c.level}` : ""}`,
        `Certificate ${c.id}`,
        `Issued to: ${plant.plant}`,
        `Valid to: ${c.valid_to}`,
        `Body: ${c.body}`,
        c.note,
        "",
        "DEMO DATA — hackathon fixture, not a live certificate.",
      ].join("\n"),
    );
    docs += 1;
  }

  const lots = allPassportBatches(erp);
  for (const id of lots) {
    const b = rawForSeed(erp, id);
    if (!b) continue;
    docs += writeBatchDocs(erp, b);
  }

  // Demo gate: only explicit fixture holds (Basmati LOT-B-0901).
  for (const b of rawBatches()) {
    if (!b.hold_on_seed) continue;
    const row = erp.sqlite.prepare("SELECT batch, status FROM batches WHERE batch = ?").get(b.batch) as { batch: string; status: string } | undefined;
    if (row && row.status !== "hold") {
      recordEvent(erp, "quality_hold", { batch: b.batch, note: b.hold_note ?? "compliance docs missing" });
      held.push(b.batch);
    }
    const open = erp.signoffs({ status: "pending" }).find((s) => s.kind === "compliance_docs" && s.subjectRef === b.batch);
    if (!open) {
      const caseId = requestSignoff(erp, {
        row: "shipping",
        kind: "compliance_docs",
        subjectRef: b.batch,
        title: `Compliance papers missing for ${b.batch}`,
        proposal: {
          batch: b.batch,
          missing: b.missing_docs,
          action_if_approved: "hold_released",
          cite: "Decision 2011/884/EU (demo import gate)",
        },
        reasons: [b.hold_note ?? "Required compliance documents are missing", "A person must confirm before the lot can ship"],
      });
      signoffs.push(caseId);
    }
  }

  erp.log("code", "compliance.seeded", null, { detail: { docs, held, signoffs, lots: lots.length } });
  opts.say?.(`Compliance passports: ${lots.length} lots, ${held.length} on hold for missing papers`);
  return { held, docs, signoffs, lots: lots.length };
}
