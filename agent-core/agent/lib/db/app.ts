/**
 * The app's Mini ERP: one SQLite file shared by the web UI and the agent's tools.
 * Default `<repo>/data/app.sqlite`; override with BRC_DB. An empty database is filled with the
 * fake world (data/world) and the golden demo run (see agent/lib/demo/golden.ts).
 */
import { Erp } from "../core/erp";
import { loadWorld } from "../core/world";
import { dataPath } from "../paths";

type Seeder = (erp: Erp) => void | Promise<void>;

const g = globalThis as unknown as { __brcErp?: Erp; __brcSeeding?: Promise<void>; __brcSeeder?: Seeder };

export const appDbPath = () => process.env.BRC_DB || dataPath("app.sqlite");

/** Register the function that fills a new database beyond the world (the golden demo). */
export function setSeeder(fn: Seeder) {
  g.__brcSeeder = fn;
}

export function getErp(): Erp {
  if (!g.__brcErp) {
    const erp = new Erp(appDbPath());
    if (erp.products().length === 0) loadWorld(erp);
    g.__brcErp = erp;
  }
  return g.__brcErp;
}

/** The app database, with the seeder run once if the database has no orders yet. */
export async function getReadyErp(): Promise<Erp> {
  const erp = getErp();
  // A new database opens on the golden demo (offline, recorded Grok answers) unless BRC_SEED=none.
  g.__brcSeeder ??= async (e) => {
    if (process.env.BRC_SEED === "none") return;
    const { runGolden } = await import("../demo/golden");
    await runGolden(e);
  };
  if (erp.orders().length === 0) {
    g.__brcSeeding ??= Promise.resolve(g.__brcSeeder(erp)).finally(() => {
      g.__brcSeeding = undefined;
    });
    await g.__brcSeeding;
  }
  return erp;
}

/** Close and forget the open database (used by the reset script and tests). */
export function closeErp() {
  g.__brcErp?.close();
  g.__brcErp = undefined;
}
