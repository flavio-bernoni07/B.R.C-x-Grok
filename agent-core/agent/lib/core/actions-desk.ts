/**
 * Actions desk deep links and scheda mapping — pure helpers safe for client components.
 * Keep Node/fs/sqlite out of this file so SignoffView / SignoffCard can import it.
 */

/** Actions desk scheda for a case (Board is only when no case is open). */
export type DeskTab =
  | "board"
  | "sendoff"
  | "price"
  | "quantity"
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

/** Which Actions tab shows this case’s SignoffCard. */
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
    return "other";
  }
  return "other";
}

/** Deep link that SSR-mounts SignoffCard on the right scheda. */
export function actionsCaseHref(caseId: string, tab?: Exclude<DeskTab, "board"> | string): string {
  const q = new URLSearchParams();
  if (tab && tab !== "board") q.set("tab", tab);
  q.set("case", caseId);
  return `/actions?${q.toString()}`;
}
