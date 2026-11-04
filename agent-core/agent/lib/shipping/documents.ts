/**
 * Documents for the Shipping and invoicing row, written by code from Mini ERP records
 * (port of shipping/documents.py).
 *
 * - EANCOM DESADV (what is on the truck, by batch)
 * - DDT (the Italian transport document), as text
 * - EDI INVOIC 380 (the invoice for the retailer's system)
 * - FatturaPA TD01 (the same invoice for SdI)
 *
 * All are demo documents: marked as such, never transmitted.
 *
 * Port note: Python builds the TD01 with python-a38 and validates it. There is no a38 for
 * TypeScript, so `buildTd01Xml` writes the same FatturaPA 1.2 (FPR12) XML that a38 emits,
 * element for element, with a38's decimal rules (Quantita/PrezzoUnitario/PrezzoTotale 2–8
 * decimals, amounts 2 decimals, ROUND_HALF_UP), its ProgressivoInvio encoding, and the same
 * DEMO banner. `checkTd01` runs the a38 field checks that apply to what we write.
 */
import { SELLER } from "../core/seller";
import { Money, money, pyG, qtyStr } from "./format";

export { money };

const yyyymmdd = (iso: string) => iso.replace(/-/g, "").slice(0, 8);

export type DespatchLine = { gtin: string; qty: number; batch?: string | null; [k: string]: unknown };
export type InvoiceDocLine = { gtin: string; qty: number; unit_price: number; vat_rate: number };
/** Product data the documents read (snake_case, as the Python products dict). */
export type DocProduct = { item_code?: string; name?: string; uom?: string };
/** Retailer data the documents read (snake_case, as the Python retailer dict). */
export type DocBuyer = {
  name?: string | null;
  delivery_point?: string | null;
  vat_id?: string | null;
  address?: string | null;
  cap?: string | null;
  comune?: string | null;
  provincia?: string | null;
  sdi_code?: string | null;
};

export function buildDesadv(a: {
  desadvRef: string;
  orderRef: string;
  shipDate: string;
  buyerGln: string | null;
  supplierGln: string | null;
  deliveryPoint: string | null;
  lines: DespatchLine[];
}): string {
  const seg = ["UNH+1+DESADV:D:96A:UN:EAN005'", `BGM+351+${a.desadvRef}+9'`, `DTM+11:${yyyymmdd(a.shipDate)}:102'`, `RFF+ON:${a.orderRef}'`];
  if (a.supplierGln) seg.push(`NAD+SU+${a.supplierGln}::9'`);
  if (a.buyerGln) seg.push(`NAD+BY+${a.buyerGln}::9'`);
  if (a.deliveryPoint) seg.push(`NAD+DP+++${a.deliveryPoint}'`);
  seg.push("CPS+1'");
  a.lines.forEach((line, i) => {
    seg.push(`LIN+${i + 1}++${line.gtin}:SRV'`);
    seg.push(`QTY+12:${qtyStr(line.qty)}'`);
    if (line.batch) seg.push(`PCI+36E'GIN+BX+${line.batch}'`);
  });
  seg.push(`CNT+2:${a.lines.length}'`);
  seg.push(`UNT+${seg.length + 1}+1'`);
  return seg.join("\n") + "\n";
}

export function buildDdt(a: {
  ddtRef: string;
  desadvRef: string;
  orderRef: string;
  shipDate: string;
  buyer: DocBuyer | null | undefined;
  lines: DespatchLine[];
  products: Record<string, DocProduct>;
}): string {
  const name = a.buyer?.name || "Retailer";
  const point = a.buyer?.delivery_point || "";
  const rows = a.lines.map((line) => {
    const product = a.products[line.gtin] ?? {};
    return (
      `  ${String(product.item_code ?? line.gtin).padEnd(16)} ${String(product.name ?? "").padEnd(40)} ` +
      `batch ${String(line.batch || "-").padEnd(12)} qty ${qtyStr(line.qty)} ${product.uom ?? ""}`
    );
  });
  return (
    `DOCUMENTO DI TRASPORTO ${a.ddtRef} (demo)\n` +
    `Mittente: ${SELLER.denominazione}, ${SELLER.indirizzo}, ${SELLER.comune}\n` +
    `Destinatario: ${name}, ${point}\n` +
    `Data: ${a.shipDate}   Ordine: ${a.orderRef}   DESADV: ${a.desadvRef}\n\n` +
    rows.join("\n") +
    "\n\nFirma vettore: ______   Firma destinatario: ______\n"
  );
}

/** Python `str(float)` of a price as written in PRI+AAA (2.2 stays 2.2, 15 becomes 15.0). */
const priceStr = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

export function buildInvoic380(a: {
  invoiceRef: string;
  invoiceDate: string;
  orderRef: string;
  desadvRef: string;
  buyerGln: string | null;
  supplierGln: string | null;
  lines: InvoiceDocLine[];
  totalNet: Money;
  totalVat: Money;
  total: Money;
}): string {
  const seg = [
    "UNH+1+INVOIC:D:96A:UN:EAN008'",
    `BGM+380+${a.invoiceRef}+9'`,
    `DTM+137:${yyyymmdd(a.invoiceDate)}:102'`,
    `RFF+ON:${a.orderRef}'`,
    `RFF+DQ:${a.desadvRef}'`,
  ];
  if (a.supplierGln) seg.push(`NAD+SU+${a.supplierGln}::9'`);
  if (a.buyerGln) seg.push(`NAD+BY+${a.buyerGln}::9'`);
  seg.push("CUX+2:EUR:4'");
  a.lines.forEach((line, i) => {
    seg.push(`LIN+${i + 1}++${line.gtin}:SRV'`);
    seg.push(`QTY+47:${qtyStr(line.qty)}'`);
    seg.push(`MOA+203:${money(Money.of(line.qty).mul(Money.of(line.unit_price)))}'`);
    seg.push(`PRI+AAA:${priceStr(line.unit_price)}'`);
    seg.push(`TAX+7+VAT+++:::${pyG(line.vat_rate)}'`);
  });
  seg.push("UNS+S'");
  seg.push(`MOA+79:${a.totalNet}'`);
  seg.push(`MOA+124:${a.totalVat}'`);
  seg.push(`MOA+77:${a.total}'`);
  seg.push(`UNT+${seg.length + 1}+1'`);
  return seg.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// FatturaPA TD01 (the XML python-a38 writes for FatturaPrivati12)
// ---------------------------------------------------------------------------

/** a38 DecimalField.clean_value: keep between `min` and `max` decimals, ROUND_HALF_UP. */
function a38Decimal(value: Money | number | string, min = 2, max = min): Money {
  const d = Money.of(value);
  if (d.e < min) return d.quantize(min);
  if (d.e > max) return d.quantize(max);
  return d;
}

const PROGRESSIVO_CHARS = "+-./0123456789=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
const progressivo = { lastTs: -1, sequence: 0 };

/** a38 ProgressivoInvioField: (unix time << 16) + sequence, in base 43. */
function progressivoInvio(): string {
  const ts = Math.floor(Date.now() / 1000);
  if (progressivo.lastTs !== ts) {
    progressivo.sequence = 0;
    progressivo.lastTs = ts;
  } else {
    progressivo.sequence += 1;
  }
  let value = (BigInt(ts) << 16n) + BigInt(progressivo.sequence);
  let out = "";
  while (value > 0n) {
    out = PROGRESSIVO_CHARS[Number(value % 43n)] + out;
    value /= 43n;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const el = (tag: string, inner: string) => `<${tag}>${inner}</${tag}>`;
const txt = (tag: string, value: string | Money) => el(tag, esc(String(value)));

export class Td01ValidationError extends Error {}

/** The a38 field checks that apply to the TD01 we write. Empty list = valid. */
export function checkTd01(fields: {
  buyerVat: string;
  sdiCode: string;
  numero: string;
  buyerCap: string;
  buyerProvincia: string;
  lines: { descrizione: string; unitaMisura: string }[];
}): string[] {
  const errors: string[] = [];
  const idPaese = fields.buyerVat.slice(0, 2);
  const idCodice = fields.buyerVat.slice(2);
  if (!/^[A-Z]{2}$/.test(idPaese)) errors.push(`IdPaese '${idPaese}' should be 2 capital letters`);
  if (!idCodice || idCodice.length > 28) errors.push(`IdCodice '${idCodice}' should be 1 to 28 characters`);
  if (fields.sdiCode.length < 6 || fields.sdiCode.length > 7) errors.push(`CodiceDestinatario '${fields.sdiCode}' should be 6 or 7 characters`);
  if (!fields.numero || fields.numero.length > 20) errors.push(`Numero '${fields.numero}' should be 1 to 20 characters`);
  if (fields.buyerCap.length !== 5) errors.push(`CAP '${fields.buyerCap}' should be 5 characters`);
  if (fields.buyerProvincia.length !== 2) errors.push(`Provincia '${fields.buyerProvincia}' should be 2 characters`);
  if (!fields.lines.length) errors.push("DettaglioLinee must have at least one line");
  for (const l of fields.lines) {
    if (!l.descrizione) errors.push("Descrizione must not be empty");
    if (l.unitaMisura.length > 10) errors.push(`UnitaMisura '${l.unitaMisura}' should be at most 10 characters`);
  }
  return errors;
}

/** FatturaPA TD01. Returns [xml, total]. Throws Td01ValidationError if the field checks fail. */
export function buildTd01Xml(a: {
  invoiceRef: string;
  invoiceDate: string;
  orderRef: string;
  ddtRef: string;
  shipDate: string;
  buyer: DocBuyer;
  lines: InvoiceDocLine[];
  products: Record<string, DocProduct>;
}): [string, Money] {
  const vat = a.buyer.vat_id || "IT00000000000";
  const sdiCode = a.buyer.sdi_code || "XXXXXXX";
  const buyerCap = a.buyer.cap || "00000";
  const buyerProvincia = a.buyer.provincia || "MI";

  // DettaglioLinee, as add_dettaglio_linee + autofill_prezzo_totale
  const dettaglio = a.lines.map((line, i) => {
    const product = a.products[line.gtin] ?? {};
    const quantita = a38Decimal(money(line.qty), 2, 8);
    const prezzoUnitario = a38Decimal(Money.of(line.unit_price), 2, 8);
    const prezzoTotale = a38Decimal(prezzoUnitario.mul(quantita), 2, 8);
    const aliquota = a38Decimal(money(line.vat_rate), 2);
    return {
      numero: i + 1,
      descrizione: `${product.name ?? line.gtin} (GTIN ${line.gtin})`.slice(0, 1000),
      quantita,
      unitaMisura: product.uom || "NR",
      prezzoUnitario,
      prezzoTotale,
      aliquota,
    };
  });

  // DatiRiepilogo, as build_dati_riepilogo: group by aliquota, sorted
  const byAliquota = new Map<string, { aliquota: Money; sum: Money }>();
  for (const d of dettaglio) {
    const key = d.aliquota.toString();
    const cur = byAliquota.get(key);
    byAliquota.set(key, { aliquota: d.aliquota, sum: cur ? cur.sum.add(d.prezzoTotale) : d.prezzoTotale });
  }
  const riepilogo = [...byAliquota.values()]
    .sort((x, y) => x.aliquota.toNumber() - y.aliquota.toNumber())
    .map(({ aliquota, sum }) => ({
      aliquota,
      imponibile: a38Decimal(sum, 2),
      imposta: a38Decimal(sum.mul(aliquota).divPow10(2), 2),
    }));
  let total = Money.of(0);
  for (const r of riepilogo) total = total.add(r.imponibile).add(r.imposta);
  total = a38Decimal(total, 2);

  const errors = checkTd01({ buyerVat: vat, sdiCode, numero: a.invoiceRef, buyerCap, buyerProvincia, lines: dettaglio });
  if (errors.length) throw new Td01ValidationError(`FatturaPA TD01 failed validation: ${errors.join("; ")}`);

  const header =
    el(
      "DatiTrasmissione",
      el("IdTrasmittente", txt("IdPaese", SELLER.id_paese) + txt("IdCodice", SELLER.id_codice)) +
        txt("ProgressivoInvio", progressivoInvio()) +
        txt("FormatoTrasmissione", "FPR12") +
        txt("CodiceDestinatario", sdiCode),
    ) +
    el(
      "CedentePrestatore",
      el(
        "DatiAnagrafici",
        el("IdFiscaleIVA", txt("IdPaese", SELLER.id_paese) + txt("IdCodice", SELLER.id_codice)) +
          el("Anagrafica", txt("Denominazione", SELLER.denominazione)) +
          txt("RegimeFiscale", SELLER.regime_fiscale),
      ) +
        el(
          "Sede",
          txt("Indirizzo", SELLER.indirizzo) + txt("CAP", SELLER.cap) + txt("Comune", SELLER.comune) + txt("Provincia", SELLER.provincia) + txt("Nazione", SELLER.nazione),
        ),
    ) +
    el(
      "CessionarioCommittente",
      el(
        "DatiAnagrafici",
        el("IdFiscaleIVA", txt("IdPaese", vat.slice(0, 2)) + txt("IdCodice", vat.slice(2))) + el("Anagrafica", txt("Denominazione", a.buyer.name || "Retailer")),
      ) +
        el(
          "Sede",
          txt("Indirizzo", a.buyer.address || "n/a") +
            txt("CAP", buyerCap) +
            txt("Comune", a.buyer.comune || "n/a") +
            txt("Provincia", buyerProvincia) +
            txt("Nazione", "IT"),
        ),
    );

  const body =
    el(
      "DatiGenerali",
      el(
        "DatiGeneraliDocumento",
        txt("TipoDocumento", "TD01") +
          txt("Divisa", "EUR") +
          txt("Data", a.invoiceDate.slice(0, 10)) +
          txt("Numero", a.invoiceRef) +
          txt("ImportoTotaleDocumento", total) +
          txt("Causale", `Ordine ${a.orderRef}, DDT ${a.ddtRef}`),
      ) +
        el("DatiOrdineAcquisto", txt("IdDocumento", a.orderRef.slice(0, 20))) +
        el("DatiDDT", txt("NumeroDDT", a.ddtRef.slice(0, 20)) + txt("DataDDT", a.shipDate.slice(0, 10))),
    ) +
    el(
      "DatiBeniServizi",
      dettaglio
        .map((d) =>
          el(
            "DettaglioLinee",
            txt("NumeroLinea", String(d.numero)) +
              txt("Descrizione", d.descrizione) +
              txt("Quantita", d.quantita) +
              txt("UnitaMisura", d.unitaMisura) +
              txt("PrezzoUnitario", d.prezzoUnitario) +
              txt("PrezzoTotale", d.prezzoTotale) +
              txt("AliquotaIVA", d.aliquota),
          ),
        )
        .join("") +
        riepilogo
          .map((r) =>
            el("DatiRiepilogo", txt("AliquotaIVA", r.aliquota) + txt("ImponibileImporto", r.imponibile) + txt("Imposta", r.imposta) + txt("EsigibilitaIVA", "I")),
          )
          .join(""),
    );

  const ns = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";
  const xml =
    "<?xml version='1.0' encoding='utf-8'?>\n" +
    "<!-- DEMO FatturaPA TD01 generated by shipping.documents (a38); not for SDI transmission -->\n" +
    `<ns0:FatturaElettronica xmlns:ns0="${ns}" versione="FPR12">` +
    el("FatturaElettronicaHeader", header) +
    el("FatturaElettronicaBody", body) +
    "</ns0:FatturaElettronica>";
  return [xml, total];
}
