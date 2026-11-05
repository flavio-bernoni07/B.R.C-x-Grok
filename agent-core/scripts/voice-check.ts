/**
 * Smoke-check Voice readiness without printing secrets.
 * Usage: pnpm voice:check
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { apiKey, hasKey } from "../agent/lib/grok/client";
import { voiceCapabilities } from "../agent/lib/dispute/voice";

/** Load agent-core/.env.local into process.env without printing values (tsx does not load it alone). */
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] == null) process.env[k] = v;
  }
}

async function main() {
  loadEnvLocal();
  const caps = voiceCapabilities();
  console.log("voice_capabilities:", caps);

  if (!hasKey()) {
    console.log("result: FAIL — set XAI_API_KEY (or GROK_API_KEY) in .env.local");
    process.exitCode = 1;
    return;
  }

  const key = apiKey()!;
  console.log("api_key_present: true (length", key.length, ")");

  try {
    const res = await fetch("https://api.x.ai/v2/phone-numbers?limit=5", {
      headers: { Authorization: `Bearer ${key}` },
    });
    console.log("phone_numbers_list_status:", res.status);
    if (res.ok) {
      const body = (await res.json()) as { phone_numbers?: unknown[] };
      console.log("phone_numbers_count:", Array.isArray(body.phone_numbers) ? body.phone_numbers.length : "n/a");
    } else {
      const text = await res.text();
      console.log("phone_numbers_body:", text.slice(0, 200));
    }
  } catch (err) {
    console.log("phone_numbers_error:", (err as Error).message);
  }

  console.log("webhook_secret_set:", Boolean(process.env.XAI_VOICE_WEBHOOK_SECRET || process.env.XAI_WEBHOOK_SECRET));
  console.log("public_base_url:", process.env.BRC_PUBLIC_BASE_URL || "(unset)");
  console.log("result: OK — key loaded; use docs/phone-voice.md for number + tunnel");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
