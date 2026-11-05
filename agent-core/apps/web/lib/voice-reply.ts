/** What to say aloud, and which page to open, from one voice turn. */

const PAGES = /(?:https?:\/\/[^/\s)]+)?(\/(?:orders|shipping|stock|disputes|signoff)(?:\?[^\s)"']*)?)/g;
const ORDER_REF = /\b(?:[A-Z]{2,5}-[A-Z0-9]+-\d{2,}|[A-Z]{2,5}-\d{3,})\b/g;

type Part = { readonly type: string; readonly text?: string; readonly state?: string };

/** Prose the person can hear. Drops markdown and keeps the first few sentences. */
export function spokenAnswer(parts: readonly Part[]): string {
  const raw = parts
    .filter((part) => part.type === "text" && part.text && part.state !== "streaming")
    .map((part) => part.text ?? "")
    .join(" ");
  const plain = raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const sentences = plain.split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
  return sentences.slice(0, 700);
}

/** The page this answer is about. The first app link wins; otherwise the question's section. */
export function pageFor(answer: string, question: string): string | null {
  const link = [...answer.matchAll(PAGES)][0]?.[1]?.replace(/[.,]$/, "");
  if (link) return link;
  const ref = answer.match(ORDER_REF)?.[0];
  if (ref) return `/orders?ref=${encodeURIComponent(ref)}`;
  const q = question.toLowerCase();
  if (/\b(truck|shipping|route|diesel|pallet)\b/.test(q)) return "/shipping";
  if (/\b(stock|silo|paddy|inventory)\b/.test(q)) return "/stock";
  if (/\b(claim|dispute)\b/.test(q)) return "/disputes";
  if (/\bsign[- ]?off\b/.test(q)) return "/signoff";
  if (/\border\b/.test(q)) return "/orders";
  return null;
}
