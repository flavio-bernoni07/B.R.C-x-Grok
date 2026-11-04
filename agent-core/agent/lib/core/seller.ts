/** Seller and default buyer for FatturaPA documents (from dispute/outcome.py; shared by Shipping TD01 and Dispute TD04). */
export const SELLER = {
  id_paese: "IT",
  id_codice: "01652220180",
  denominazione: "Riso Scotti S.p.A.",
  indirizzo: "Via Angelo Scotti 2",
  cap: "27100",
  comune: "Pavia",
  provincia: "PV",
  nazione: "IT",
  regime_fiscale: "RF01",
} as const;

export const BUYER_DEFAULT = {
  id_paese: "IT",
  id_codice: "09876543210",
  denominazione: "Retailer GDO S.p.A.",
  indirizzo: "Via Demo 1",
  cap: "20100",
  comune: "Milano",
  provincia: "MI",
  nazione: "IT",
  codice_destinatario: "XXXXXXX",
} as const;

/** Food staple / rice uses reduced VAT in the demos; explicit and documented (dispute/outcome.py). */
export const DEMO_ALIQUOTA_IVA = 4.0;
