/**
 * Sign-off / Disputes deep links — pure helpers safe for client components.
 * Keep Node/fs/sqlite out of this file so SignoffView / SignoffCard can import it.
 *
 * After the redesign, `/actions` redirects to `/signoff`. Customer phone/chat claims
 * live on `/disputes`; their sign-off cases open on `/signoff?case=…`.
 */

/** Legacy desk scheda names kept for SignoffView and search tests. */
export type DeskTab =
  | "board"
  | "sendoff"
  | "price"
  | "quantity"
  | "disputes"
  | "pending"
  | "other"
  | "decided";

const SEND_OFF_KINDS = new Set(["confirm"]);
const PRICE_KINDS = new Set(["price_fix"]);
const QTY_KINDS = new Set(["qty_choice", "stock_short"]);

function isOpenSignoff(c: { status: string; decidedAt?: string | null }): boolean {
  return c.status === "pending" && !c.decidedAt;
}

function isPendingHold(c: { status: string; decidedAt?: string | null }): boolean {
  return (c.status === "pending" && !!c.decidedAt) || c.status === "parked";
}

/** Which legacy Actions tab showed this case’s SignoffCard. */
export function deskTabForSignoff(c: {
  status: string;
  decidedAt?: string | null;
  row: string;
  kind: string;
}): Exclude<DeskTab, "board"> {
  if (c.status === "approved" || c.status === "rejected") return "decided";
  if (isPendingHold(c)) return "pending";
  if (isOpenSignoff(c)) {
    if (c.row === "order" && SEND_OFF_KINDS.has(c.kind)) return "sendoff";
    if (c.row === "order" && PRICE_KINDS.has(c.kind)) return "price";
    if (c.row === "order" && QTY_KINDS.has(c.kind)) return "quantity";
    if (c.row === "dispute" && (c.kind === "customer_dispute" || c.kind === "verdict")) return "disputes";
    return "other";
  }
  return "other";
}

/** Deep link for a sign-off case on the redesigned Sign-off desk. */
export function actionsCaseHref(caseId: string, _tab?: Exclude<DeskTab, "board"> | string): string {
  return `/signoff?case=${encodeURIComponent(caseId)}`;
}

/** Deep link for a claim on the Disputes page. */
export function disputeClaimHref(claimId: string): string {
  return `/disputes?claim=${encodeURIComponent(claimId)}`;
}
