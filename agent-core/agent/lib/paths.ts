import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The repo root: RICE_REPO_ROOT, or the first parent of the working directory that holds
 * DECISIONS.md (works from agent-core, apps/web and eve's dev snapshots alike).
 */
export function repoRoot(): string {
  const fromEnv = process.env.RICE_REPO_ROOT;
  if (fromEnv) return resolve(fromEnv);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "DECISIONS.md")) && existsSync(join(dir, "data"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot find the repo root (DECISIONS.md); set RICE_REPO_ROOT.");
    dir = parent;
  }
}

export const dataPath = (...parts: string[]) => join(repoRoot(), "data", ...parts);
