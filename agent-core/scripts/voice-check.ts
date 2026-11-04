/**
 * Smoke-check Voice readiness without printing secrets.
 * Usage: pnpm voice:check
 */
import { apiKey, hasKey } from "../agent/lib/grok/client";
import { voiceCapabilities } from "../agent/lib/dispute/voice";

async function main() {
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
