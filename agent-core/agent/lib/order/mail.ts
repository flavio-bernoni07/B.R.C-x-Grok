/**
 * Formal English mail drafts for Order human gates (port of order/mail_drafts.py).
 * Code writes every figure; a person reviews and sends.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function cleanName(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  return name.replace(" (demo)", "").replace("(demo)", "").trim() || fallback;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "not indicated";
  const raw = value.trim().replace(/-/g, "");
  if (raw.length === 8 && /^\d+$/.test(raw)) {
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6));
    const day = Number(raw.slice(6, 8));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${MONTHS[month - 1]} ${day}, ${year}`;
  }
  return value;
}

function fmtQty(value: number | null | undefined): string {
  if (value == null) return "not available";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Formal mail: stock short — offer partial now / discuss remainder. */
export function draftQtyShortMail(o: {
  orderNumber: string | null;
  buyerName: string;
  supplierName: string;
  productName: string | null;
  gtin: string | null;
  orderedQty: number | null;
  availableQty: number | null;
  orderDate?: string | null;
}): string {
  const orderRef = o.orderNumber || "not indicated";
  const product = o.productName || "requested item";
  const productCode = o.gtin || "not indicated";
  const date = fmtDate(o.orderDate);
  const buyer = cleanName(o.buyerName, "Dear Customer");
  const supplier = cleanName(o.supplierName, "Supplier");
  const ordered = o.orderedQty || 0;
  const available = o.availableQty || 0;
  const missing = Math.max(ordered - available, 0);
  return (
    `Subject: Order no. ${orderRef} — partial availability notice\n\n` +
    `Dear ${buyer},\n\n` +
    `we are writing with reference to order no. ${orderRef} dated ${date}.\n\n` +
    `Unfortunately, as of today we are unable to fulfil the full quantity ` +
    `requested: warehouse availability is lower than the ordered amount.\n\n` +
    `Technical references for the order:\n` +
    `- Order number: ${orderRef}\n` +
    `- Order date: ${date}\n` +
    `- Product: ${product}\n` +
    `- Product code: ${productCode}\n` +
    `- Quantity ordered: ${fmtQty(ordered)} units\n` +
    `- Quantity currently available: ${fmtQty(available)} units\n` +
    `- Quantity not covered: ${fmtQty(missing)} units\n\n` +
    `We remain available to agree a partial delivery of the quantity ` +
    `available today and a plan for the balance, or a revision of the ` +
    `order quantity.\n\n` +
    `Kind regards,\n` +
    `${supplier}\n` +
    `Order office\n\n` +
    `— Draft — review and send manually —\n`
  );
}
