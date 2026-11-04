/**
 * Rebuild the app's Mini ERP: delete data/app.sqlite, load the world (data/world) and replay the
 * golden demo and the scenarios (ESS-AMB-001) offline with the recorded Grok answers, so the app opens on real cases.
 *
 *   pnpm db:reset            # world + golden demo
 *   pnpm db:reset --empty    # world only
 */
import { freshErp } from "../agent/lib/core/world";
import { appDbPath } from "../agent/lib/db/app";
import { seedDemo } from "../agent/lib/demo/seed";

const empty = process.argv.includes("--empty");
const path = appDbPath();
const erp = freshErp(path);
if (!empty) {
  await seedDemo(erp, { say: (line) => console.log(line) });
  console.log(`\n${erp.auditLog().length} actions in the audit log, ${erp.signoffs({ status: "pending" }).length} sign-offs waiting.`);
}
erp.close();
console.log(`Mini ERP ready at ${path}`);
