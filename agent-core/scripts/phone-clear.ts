/**
 * Wipe phone-channel DSP claims from the local Mini ERP so the next live call
 * is the only Phone badge on Disputes.
 *
 *   pnpm phone:clear
 *
 * Prefers the running dashboard (same open DB). Falls back to opening the SQLite file.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const url = "http://127.0.0.1:3000/api/telephony/clear-phone";
  try {
    const res = await fetch(url, { method: "POST" });
    const body = (await res.json()) as { ok?: boolean; removed?: string[]; error?: string };
    if (!res.ok || !body.ok) {
      console.error("clear-phone via dashboard failed:", res.status, body);
      process.exitCode = 1;
      return;
    }
    console.log("Removed Phone claims:", body.removed?.length ? body.removed.join(", ") : "(none)");
    console.log("Refresh http://127.0.0.1:3000/disputes — next call will be the only Phone row.");
    return;
  } catch {
    // Dashboard not up — open the DB file directly.
  }

  const { Erp } = await import("../agent/lib/core/erp");
  const { appDbPath, closeErp } = await import("../agent/lib/db/app");
  const { clearPhoneClaims } = await import("../agent/lib/dispute/clear_phone");
  closeErp();
  const erp = new Erp(appDbPath());
  const result = clearPhoneClaims(erp);
  erp.close();
  console.log("Removed Phone claims:", result.removed.length ? result.removed.join(", ") : "(none)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
