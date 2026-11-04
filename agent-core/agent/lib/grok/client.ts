/**
 * One Grok client for every row (port of agent/grok.py; see grok-agent-dec.md).
 *
 * - JSON answers only, parsed here.
 * - `validate` returns a list of problems; the answer goes back once with them, and a second
 *   bad answer throws GrokAnswerRejected so the case goes to a person.
 * - Model per task: XAI_MODEL_<TASK> (dots and dashes become underscores, e.g.
 *   XAI_MODEL_DISPUTE_VERDICT), then XAI_MODEL, then GROK_MODEL, then the default.
 * - Key from XAI_API_KEY or GROK_API_KEY.
 * - `caller` replaces the network in tests and offline demos (recorded answers).
 *
 * Grok proposes; code checks; a person decides when it is unclear. Nothing here writes a
 * document or an amount.
 */
import { createXai } from "@ai-sdk/xai";
import { generateText, type ModelMessage } from "ai";

export const DEFAULT_MODEL = "grok-4.7";

export type Message = { role: "system" | "user" | "assistant"; content: string };
export type Caller = (messages: Message[]) => unknown | Promise<unknown>;
export type Validator = (payload: Record<string, unknown>) => string[];

export class MissingApiKeyError extends Error {}

export class GrokAnswerRejected extends Error {
  constructor(readonly problems: string[]) {
    super(`Grok answer rejected: ${problems.join("; ")}`);
  }
}

export function apiKey(): string | null {
  for (const name of ["XAI_API_KEY", "GROK_API_KEY"]) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

export const hasKey = () => apiKey() !== null;

export function modelFor(task?: string | null): string {
  if (task) {
    const specific = process.env[`XAI_MODEL_${task.toUpperCase().replace(/[.-]/g, "_")}`]?.trim();
    if (specific) return specific;
  }
  for (const name of ["XAI_MODEL", "GROK_MODEL"]) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return DEFAULT_MODEL;
}

/** Parse the first JSON object in a model reply (tolerates ``` fences). */
export function extractJsonObject(text: string): Record<string, unknown> {
  let t = text.trim();
  if (t.startsWith("```")) {
    const lines = t.split("\n").slice(1);
    if (lines.at(-1)?.trim() === "```") lines.pop();
    t = lines.join("\n").trim();
  }
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch (err) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) throw err;
    data = JSON.parse(t.slice(start, end + 1));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Grok response JSON must be an object");
  return data as Record<string, unknown>;
}

/** One call to xAI; returns the message text. */
export async function postChat(messages: Message[], opts: { task?: string; temperature?: number; timeoutMs?: number } = {}): Promise<string> {
  const key = apiKey();
  if (!key) throw new MissingApiKeyError("Missing API key. Set XAI_API_KEY or GROK_API_KEY.");
  const xai = createXai({ apiKey: key, baseURL: process.env.XAI_BASE_URL || undefined });
  const { text } = await generateText({
    model: xai.responses(modelFor(opts.task)),
    temperature: opts.temperature ?? 0,
    messages: messages as ModelMessage[],
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  return text;
}

/** Ask Grok for a JSON object, check it, retry once with the problems found. */
export async function chatJson(
  messages: Message[],
  opts: { task: string; validate?: Validator; caller?: Caller | null; retries?: number; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  let convo = [...messages];
  let problems: string[] = [];
  const retries = opts.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const reply = opts.caller ? await opts.caller(convo) : await postChat(convo, { task: opts.task, timeoutMs: opts.timeoutMs });
    let payload: Record<string, unknown> | null = null;
    let text: string;
    if (reply && typeof reply === "object") {
      payload = reply as Record<string, unknown>;
      text = JSON.stringify(reply);
    } else {
      text = String(reply);
      try {
        payload = extractJsonObject(text);
      } catch (err) {
        problems = [`the reply is not a JSON object (${(err as Error).message})`];
      }
    }
    if (payload) {
      problems = opts.validate ? opts.validate(payload) : [];
      if (!problems.length) return payload;
    }
    if (attempt < retries) {
      convo = [
        ...convo,
        { role: "assistant", content: text },
        { role: "user", content: `Your answer was rejected by the checks: ${problems.join("; ")}. Return the corrected JSON object only.` },
      ];
    }
  }
  throw new GrokAnswerRejected(problems);
}
