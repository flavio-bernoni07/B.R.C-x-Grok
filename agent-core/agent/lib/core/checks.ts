/** Checks code runs on anything Grok writes (port of agent/checks.py). */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Digits only, so 12.000, 12000 and 12,000 compare equal; 2.20 and 220 too. */
export function numbersIn(text: string | null | undefined): Set<string> {
  return new Set((text ?? "").match(NUMBER)?.map((n) => n.replace(/[.,]/g, "").replace(/^0+/, "") || "0") ?? []);
}

/** Figures in `text` that do not appear anywhere in `allowedText`. */
export function unknownNumbers(text: string, allowedText: string): Set<string> {
  const allowed = numbersIn(allowedText);
  return new Set([...numbersIn(text)].filter((n) => !allowed.has(n)));
}
