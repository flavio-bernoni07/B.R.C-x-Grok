/**
 * Rebuild the app's Mini ERP: delete data/app.sqlite, load the world (data/world) and replay the
 * golden demo offline with the recorded Grok answers, so the app opens on real cases.
 *
 *   pnpm db:reset            # world + golden demo
 *   pnpm db:reset --empty    # world only
 */
import { freshErp } from "../agent/lib/core/world";
import { appDbPath } from "../agent/lib/db/app";
import { runGolden } from "../agent/lib/demo/golden";

const empty = process.argv.includes("--empty");
const path = appDbPath();
const erp = freshErp(path);
if (!empty) {
  const result = await runGolden(erp, { say: (line) => console.log(line) });
  console.log(`\n${result.auditEvents} actions in the audit log, ${result.pendingSignoffs} sign-offs waiting.`);
}
erp.close();
console.log(`Mini ERP ready at ${path}`);
