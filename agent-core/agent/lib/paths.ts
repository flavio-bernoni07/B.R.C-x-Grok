import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Packed by scripts/pack-hosted-root.mjs so the eve agent on Vercel has a repo
// root even though its service bundle does not include the monorepo checkout.
import hostedRootJson from "./hosted-root.json" with { type: "json" };

const HOSTED_TMP = join(process.env.TMPDIR || "/tmp", "brc-repo-root");

function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, "DECISIONS.md")) && existsSync(join(dir, "data"));
}

function walkForRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Write the packed demo tree to /tmp so dataPath() keeps working on Vercel. */
function materializeHostedRoot(): string | undefined {
  const files = hostedRootJson as Record<string, string>;
  if (!files || typeof files !== "object" || files["DECISIONS.md"] === undefined) return undefined;
  if (!isRepoRoot(HOSTED_TMP)) {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(HOSTED_TMP, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (body.startsWith("base64:")) writeFileSync(abs, Buffer.from(body.slice(7), "base64"));
      else writeFileSync(abs, body);
    }
  }
  return isRepoRoot(HOSTED_TMP) ? HOSTED_TMP : undefined;
}

/**
 * The repo root: RICE_REPO_ROOT, or the first parent of the working directory /
 * this module that holds DECISIONS.md, or the packed hosted tree on Vercel.
 */
export function repoRoot(): string {
  const fromEnv = process.env.RICE_REPO_ROOT;
  if (fromEnv) return resolve(fromEnv);

  // Tests / Vercel agent cold start: skip the checkout walk and use the pack.
  if (process.env.BRC_FORCE_HOSTED_ROOT === "1") {
    const forced = materializeHostedRoot();
    if (forced) return forced;
  }

  const fromCwd = walkForRoot(process.cwd());
  if (fromCwd) return fromCwd;

  // agent/lib/paths.ts → repo root when running from source / Next NFT layout.
  try {
    const fromModule = walkForRoot(fileURLToPath(new URL("../../..", import.meta.url)));
    if (fromModule) return fromModule;
  } catch {
    // import.meta.url can be opaque inside some bundles.
  }

  const hosted = materializeHostedRoot();
  if (hosted) return hosted;

  throw new Error("Cannot find the repo root (DECISIONS.md); set RICE_REPO_ROOT.");
}

export const dataPath = (...parts: string[]) => join(repoRoot(), "data", ...parts);
