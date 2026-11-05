/**
 * Writes the demo world's generated fixtures (demo data, invented, not Riso Scotti's real figures):
 *
 *   data/world/contracts/CTR-SCOTTI-<code>-2026.json   one annual supply contract per retailer
 *   data/orders/contract_scotti_esselunga.json         the order row's default contract (= Esselunga's)
 *   data/world/history/ORDERS_<ref>.edi                the ORDERS of the past orders the seed replays
 *   data/world/order_history_more.csv                  weekly demand of the products added for the demo
 *
 *   pnpm exec tsx scripts/build-demo-world.ts
 *
 * Deterministic: run it again and the files come out the same. The three products the Python
 * forecaster generated (Carnaroli, Arborio, Risotto ai funghi) stay in data/world/order_history.csv,
 * which this script only reads (the Python reference and its score use it); the products added for
 * the demo get their own series in order_history_more.csv, with different patterns (seasonality,
 * promo weeks, trend), so their 8-week projections differ.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../agent/lib/paths";

type Product = { gtin: string; item_code: string; name: string; uom: string; list_price: number; units_per_pallet: number };
const products = (JSON.parse(readFileSync(dataPath("world", "products.json"), "utf8")) as { products: Product[] }).products;
const byCode = new Map(products.map((p) => [p.item_code, p]));
const retailers = (JSON.parse(readFileSync(dataPath("world", "retailers.json"), "utf8")) as { retailers: { gln: string; name: string }[] }).retailers;
const gln = (name: string) => retailers.find((r) => r.name === name)!.gln;

const cents = (v: number) => Math.round(v * 100 + 1e-9) / 100;
/** JSON with two-space indent, each volume tier on one line (as the contract was hand-written). */
const pretty = (v: unknown) =>
  JSON.stringify(v, null, 2).replace(/\{\s+"min_qty": (\d+),\s+"unit_price": ([\d.]+)\s+\}/g, '{ "min_qty": $1, "unit_price": $2 }') + "\n";

// ----- contracts ----------------------------------------------------------------------------

/** Arborio and Carnaroli 1 kg: one national price list (the ORDERS fixtures already carry it). */
const CORE: Record<string, { unit_price: number; volume_discounts: { min_qty: number; unit_price: number }[] }> = {
  "ARB-1KG": { unit_price: 1.85, volume_discounts: [{ min_qty: 15000, unit_price: 1.7 }, { min_qty: 30000, unit_price: 1.55 }] },
  "CAR-1KG": { unit_price: 2.4, volume_discounts: [{ min_qty: 10000, unit_price: 2.2 }] },
};

/** Units a retailer commits to buy in the contract year, per product, for a retailer of size 1. */
const ANNUAL_BASE: Record<string, number> = {
  "ARB-1KG": 300000, "CAR-1KG": 220000, "ARB-1KG-CTN12": 6000, "CAR-1KG-CTN12": 5000, "ARB-VAC-1KG": 8000, "BAS-500G": 90000,
  "RSP-FUNGHI-210": 120000, "RIBE-1KG": 180000, "PARB-1KG": 140000, "INT-1KG": 70000, "VEN-500G": 50000, "BAS-1KG": 80000,
  "JAS-1KG": 40000, "SUSHI-500G": 60000, "RSP-ZAFF-210": 90000, "RSP-ASP-210": 50000, "GAL-150G": 220000, "BEV-1L": 110000,
};

type Terms = {
  code: string;
  retailer: string;
  start: string;
  end: string;
  /** Price factor on the list price, for every product but Arborio and Carnaroli 1 kg. */
  factor: number;
  size: number;
  /** Discounters get their volume tiers earlier and deeper. */
  discounter?: boolean;
  skip?: string[];
  notes: string[];
};

const COMMON_NOTES = [
  "Demo data: an invented contract for the hackathon, not Riso Scotti's real terms.",
  "Annual agreement, invoiced monthly: every delivery is invoiced when it ships (FatturaPA TD01 + EDI INVOIC) and the month's invoices are paid together.",
  "Payment 60 days from the invoice date, the legal maximum for non-perishable agri-food products (D.Lgs. 198/2021, art. 4).",
  "Prices are per consumer unit, ex VAT, delivered to the retailer's distribution centre (DDP).",
];

const TERMS: Terms[] = [
  { code: "ESS", retailer: "Esselunga", start: "2026-01-01", end: "2026-12-31", factor: 1, size: 1, notes: ["Volume tiers apply per ORDERS line.", "Promotions (flyers, temporary prices) only through a signed promo annex; none is in force for Q4 2026."] },
  { code: "CRF", retailer: "Carrefour Italia", start: "2026-01-01", end: "2026-12-31", factor: 0.99, size: 1.1, notes: ["Volume tiers apply per ORDERS line.", "Autumn promo annex RS-PROMO-AUT26 covers Basmati 500 g only."] },
  { code: "AUC", retailer: "Auchan", start: "2026-01-01", end: "2026-12-31", factor: 1, size: 0.6, notes: ["Volume tiers apply per ORDERS line."] },
  { code: "CON", retailer: "Conad Ancona", start: "2026-01-01", end: "2026-12-31", factor: 0.99, size: 1.2, notes: ["Volume tiers apply per ORDERS line.", "Deliveries to CeDi Ancona only."] },
  { code: "COO", retailer: "Coop Italia", start: "2026-04-01", end: "2027-03-31", factor: 0.98, size: 1.3, notes: ["Contract year April to March.", "Credit notes are deducted on the next remittance (REMADV, adjustment code CN)."] },
  { code: "IPR", retailer: "Iper", start: "2026-01-01", end: "2026-12-31", factor: 1, size: 0.5, notes: ["Shortages must be written on the DDT at unloading; claims raised later need the CeDi's receiving report."] },
  { code: "LID", retailer: "Lidl Italia", start: "2026-02-01", end: "2027-01-31", factor: 0.96, size: 0.9, discounter: true, skip: ["ARB-VAC-1KG", "ARB-1KG-CTN12", "CAR-1KG-CTN12"], notes: ["Branded range only; cartons and the vacuum pack are not listed.", "Contract year February to January."] },
  { code: "EUR", retailer: "Eurospin", start: "2026-01-01", end: "2026-12-31", factor: 0.95, size: 0.8, discounter: true, skip: ["ARB-VAC-1KG", "ARB-1KG-CTN12", "CAR-1KG-CTN12"], notes: ["Branded range only; cartons and the vacuum pack are not listed.", "No promo annex in 2026: the price list below is the only price."] },
  { code: "BEN", retailer: "Bennet", start: "2026-01-01", end: "2026-12-31", factor: 1, size: 0.4, notes: ["Volume tiers apply per ORDERS line."] },
  { code: "PAM", retailer: "Pam Panorama", start: "2026-01-01", end: "2026-12-31", factor: 0.99, size: 0.45, notes: ["Delivery on the day the CeDi books; there is no late-delivery penalty clause in this contract."] },
  { code: "DSP", retailer: "Despar", start: "2026-01-01", end: "2026-12-31", factor: 0.99, size: 0.5, notes: ["Every deduction on a remittance must carry a reason code (AJT) and a reference."] },
  { code: "UNS", retailer: "Unes", start: "2026-01-01", end: "2026-12-31", factor: 1, size: 0.25, skip: ["ARB-1KG-CTN12", "CAR-1KG-CTN12"], notes: ["Damage must be written on the DDT at unloading."] },
];

function priceList(t: Terms) {
  return products
    .filter((p) => !(t.skip ?? []).includes(p.item_code))
    .map((p) => {
      const core = CORE[p.item_code];
      const pallet = p.units_per_pallet;
      const base = core ? core.unit_price : cents(p.list_price * t.factor);
      const tiers = core
        ? core.volume_discounts
        : t.discounter
          ? [{ min_qty: 3 * pallet, unit_price: cents(base * 0.96) }, { min_qty: 10 * pallet, unit_price: cents(base * 0.92) }]
          : [{ min_qty: 5 * pallet, unit_price: cents(base * 0.97) }, { min_qty: 15 * pallet, unit_price: cents(base * 0.94) }];
      return {
        gtin: p.gtin,
        item_code: p.item_code,
        name: p.name,
        unit_price: base,
        volume_discounts: tiers,
        annual_volume_units: Math.round((ANNUAL_BASE[p.item_code] * t.size) / 100) * 100,
      };
    });
}

function priceFor(code: string, itemCode: string, qty: number): number {
  const t = TERMS.find((x) => x.code === code)!;
  const row = priceList(t).find((r) => r.item_code === itemCode)!;
  let price = row.unit_price;
  for (const d of row.volume_discounts) if (qty >= d.min_qty) price = d.unit_price;
  return price;
}

const contractsDir = dataPath("world", "contracts");
mkdirSync(contractsDir, { recursive: true });
for (const t of TERMS) {
  const list = priceList(t);
  const contract = {
    _comment: "Demo data: an invented annual supply contract (scripts/build-demo-world.ts). The order row checks ORDERS prices against products[].",
    id: `CTR-SCOTTI-${t.code}-2026`,
    retailer: { gln: gln(t.retailer), name: t.retailer },
    buyer_gln: gln(t.retailer),
    buyer_name: `${t.retailer} (demo)`,
    supplier_gln: "SUPPLIER001",
    supplier_name: "Riso Scotti S.p.A. (demo)",
    currency: "EUR",
    start: t.start,
    end: t.end,
    billing: "monthly",
    payment_terms_days: 60,
    payment_terms_source: "D.Lgs. 198/2021, art. 4: 60 days for non-perishable agri-food products",
    annual_volume_units: list.reduce((a, r) => a + r.annual_volume_units, 0),
    products: list,
    notes: [...COMMON_NOTES, ...t.notes],
  };
  writeFileSync(join(contractsDir, `${contract.id}.json`), pretty(contract));
}

// The order row's default contract (and the Python row's): Esselunga's price list, same shape as before.
const ess = priceList(TERMS[0]);
writeFileSync(
  dataPath("orders", "contract_scotti_esselunga.json"),
  pretty({
      id: "CTR-SCOTTI-ESS-2026",
      buyer_gln: "BUYER001",
      supplier_gln: "SUPPLIER001",
      buyer_name: "Esselunga (demo)",
      supplier_name: "Riso Scotti S.p.A. (demo)",
      currency: "EUR",
      products: ess.map((r) => ({ gtin: r.gtin, name: r.name.replace(/^Riso Scotti /, "Riso "), unit_price: r.unit_price, volume_discounts: r.volume_discounts })),
  }),
);

// ----- ORDERS of the past orders (agent/lib/demo/history.ts replays them) ----------------------

type HistOrder = { ref: string; code: string; retailer: string; date: string; lines: [string, number][]; price?: Record<string, number>; raw?: string };

const HISTORY_ORDERS: HistOrder[] = [
  { ref: "COO-26-08412", code: "COO", retailer: "Coop Italia", date: "20260824", lines: [["RSP-FUNGHI-210", 4800], ["RSP-ZAFF-210", 4800]] },
  { ref: "LID-40212", code: "LID", retailer: "Lidl Italia", date: "20260827", lines: [["GAL-150G", 14400], ["BAS-1KG", 4800], ["VEN-500G", 3600]] },
  // Paid on 31 Oct with a €300 flyer contribution taken off (history.json, remittance RA-ESS-2026-10-31).
  { ref: "ESS-47390", code: "ESS", retailer: "Esselunga", date: "20260828", lines: [["RIBE-1KG", 7680], ["GAL-150G", 3600]] },
  { ref: "COO-26-08530", code: "COO", retailer: "Coop Italia", date: "20260831", lines: [["RIBE-1KG", 9600], ["PARB-1KG", 4800]] },
  { ref: "PAM-77015", code: "PAM", retailer: "Pam Panorama", date: "20260901", lines: [["SUSHI-500G", 3600], ["JAS-1KG", 1920], ["BAS-500G", 3600]] },
  { ref: "DSP-90233", code: "DSP", retailer: "Despar", date: "20260902", lines: [["CAR-1KG", 4800], ["INT-1KG", 1920]] },
  { ref: "UNS-61190", code: "UNS", retailer: "Unes", date: "20261005", lines: [["BEV-1L", 2160], ["GAL-150G", 7200]] },
  { ref: "EUR-77310", code: "EUR", retailer: "Eurospin", date: "20261012", lines: [["BAS-1KG", 9600], ["RIBE-1KG", 4800]] },
  { ref: "IPR-30577", code: "IPR", retailer: "Iper", date: "20261019", lines: [["VEN-500G", 3600], ["RSP-ZAFF-210", 4800]] },
  { ref: "CON-26-1044", code: "CON", retailer: "Conad Ancona", date: "20261026", lines: [["INT-1KG", 960], ["PARB-1KG", 2880], ["RSP-ASP-210", 2400]] },
  { ref: "ESS-48811", code: "ESS", retailer: "Esselunga", date: "20261102", lines: [["RIBE-1KG", 7680], ["BAS-500G", 3600], ["GAL-150G", 3600]] },
  { ref: "LID-40388", code: "LID", retailer: "Lidl Italia", date: "20261103", lines: [["GAL-150G", 10800], ["BEV-1L", 2160]] },
  // Bennet writes the old list price: the price check stops it for a person.
  { ref: "BEN-31877", code: "BEN", retailer: "Bennet", date: "20261103", lines: [["SUSHI-500G", 3600]], price: { "SUSHI-500G": 2.79 } },
];

function edi(o: HistOrder): string {
  const seg = ["UNH+1+ORDERS:D:96A:UN'", `BGM+220+${o.ref}+9'`, `DTM+137:${o.date}:102'`, `NAD+BY+${gln(o.retailer)}::9'`, "NAD+SU+SUPPLIER001::9'"];
  o.lines.forEach(([code, qty], i) => {
    const p = byCode.get(code)!;
    seg.push(`LIN+${i + 1}++${p.gtin}:EN'`, `QTY+21:${qty}'`, `PRI+AAA:${(o.price?.[code] ?? priceFor(o.code, code, qty)).toFixed(2)}:CT'`);
  });
  seg.push("UNS+S'");
  seg.push(`UNT+${seg.length + 1}+1'`);
  return seg.join("\n") + "\n";
}

const histDir = dataPath("world", "history");
mkdirSync(histDir, { recursive: true });
for (const o of HISTORY_ORDERS) writeFileSync(join(histDir, `ORDERS_${o.ref}.edi`), edi(o));
// Auchan's EDI arrives garbled (date in dd/mm/yyyy, "3.600" with the Italian thousands separator):
// the parser flags it, Grok proposes the fix (grok_recorded.json), and a person confirms.
const venere = byCode.get("VEN-500G")!;
writeFileSync(
  join(histDir, "ORDERS_AUC-55120.edi"),
  [
    "UNH+1+ORDERS:D:96A:UN'",
    "BGM+220+AUC-55120+9'",
    "DTM+137:04/11/2026:102'",
    `NAD+BY+${gln("Auchan")}::9'`,
    "NAD+SU+SUPPLIER001::9'",
    `LIN+1++${venere.gtin}:EN'`,
    "QTY+21:3.600'",
    `PRI+AAA:${priceFor("AUC", "VEN-500G", 3600).toFixed(2)}:CT'`,
    "UNS+S'",
    "UNT+10+1'",
  ].join("\n") + "\n",
);

// ----- weekly demand of the products added for the demo ---------------------------------------

/** mulberry32: a small seeded generator, so the history is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

type Pattern = { base: number; peakDay: number; season: number; trend: number; promoRate: number; promoLift: number; xmas: number; august: number };
/** One pattern per product: day of the seasonal peak, its size, weekly trend, promo weeks, holidays. */
const PATTERNS: Record<string, Pattern> = {
  "RIBE-1KG": { base: 7000, peakDay: 20, season: 0.15, trend: 0.0004, promoRate: 0.1, promoLift: 1.35, xmas: 1.1, august: 0.75 },
  "PARB-1KG": { base: 5000, peakDay: 195, season: 0.28, trend: 0.001, promoRate: 0.1, promoLift: 1.3, xmas: 1, august: 0.95 },
  "INT-1KG": { base: 2500, peakDay: 15, season: 0.15, trend: 0.004, promoRate: 0.08, promoLift: 1.3, xmas: 0.95, august: 0.8 },
  "VEN-500G": { base: 1800, peakDay: 350, season: 0.2, trend: 0.002, promoRate: 0.08, promoLift: 1.4, xmas: 1.8, august: 0.7 },
  "BAS-1KG": { base: 3000, peakDay: 200, season: 0.05, trend: 0.0005, promoRate: 0.2, promoLift: 1.5, xmas: 1, august: 0.9 },
  "JAS-1KG": { base: 1500, peakDay: 1, season: 0, trend: -0.0015, promoRate: 0.06, promoLift: 1.3, xmas: 1, august: 0.85 },
  "SUSHI-500G": { base: 2200, peakDay: 60, season: 0.08, trend: 0.003, promoRate: 0.05, promoLift: 1.3, xmas: 1.1, august: 0.8 },
  "RSP-ZAFF-210": { base: 3500, peakDay: 15, season: 0.35, trend: 0.0008, promoRate: 0.12, promoLift: 1.4, xmas: 1.3, august: 0.6 },
  "RSP-ASP-210": { base: 2500, peakDay: 125, season: 0.6, trend: 0.001, promoRate: 0.1, promoLift: 1.35, xmas: 1, august: 0.8 },
  "GAL-150G": { base: 9000, peakDay: 25, season: 0.12, trend: 0.001, promoRate: 0.15, promoLift: 1.35, xmas: 0.85, august: 1 },
  "BEV-1L": { base: 4000, peakDay: 30, season: 0.1, trend: 0.0025, promoRate: 0.12, promoLift: 1.3, xmas: 1.05, august: 0.85 },
};

const DAY = 86_400_000;
function isoWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d.getTime() + (3 - dow) * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
const dayOfYear = (iso: string) => Math.floor((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(Number(iso.slice(0, 4)), 0, 1)) / DAY) + 1;

const csvPath = dataPath("world", "order_history.csv");
const morePath = dataPath("world", "order_history_more.csv");
const [header, ...rows] = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const added = new Set(Object.keys(PATTERNS).map((c) => byCode.get(c)!.gtin));
const kept = rows.filter((r) => !added.has(r.split(",")[2]));
const weeks = [...new Set(kept.map((r) => r.split(",")[1]))].sort();
const out = [header];
const r = rng(26);
weeks.forEach((wk, i) => {
  for (const [code, p] of Object.entries(PATTERNS)) {
    const season = 1 + p.season * Math.cos((2 * Math.PI * (dayOfYear(wk) - p.peakDay)) / 365);
    const month = Number(wk.slice(5, 7));
    const day = Number(wk.slice(8, 10));
    const holiday = month === 12 && day >= 15 && day <= 24 ? p.xmas : month === 8 ? p.august : 1;
    const promo = r() < p.promoRate;
    const qty = p.base * season * holiday * (1 + p.trend * i) * (promo ? p.promoLift : 1) * (1 + 0.06 * gauss(r));
    out.push([isoWeek(wk), wk, byCode.get(code)!.gtin, code, Math.round(qty), promo ? 1 : 0].join(","));
  }
});
writeFileSync(morePath, out.join("\r\n") + "\r\n"); // CRLF, as Python's csv module writes it
console.log(`${TERMS.length} contracts, ${HISTORY_ORDERS.length + 1} history ORDERS, ${out.length - 1} demand rows`);
