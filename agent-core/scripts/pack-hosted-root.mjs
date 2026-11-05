#!/usr/bin/env node
/**
 * Pack DECISIONS.md + the demo data tree into agent/lib/hosted-root.json so the
 * eve agent bundle on Vercel can materialize a repo root without the monorepo
 * checkout (Next.js file tracing covers the web routes; eve's service does not).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const agentCore = dirname(scriptsDir);
const repoRoot = dirname(agentCore);
const outFile = join(agentCore, "agent", "lib", "hosted-root.json");

const INCLUDE_DIRS = [
  "data/world",
  "data/disputes",
  "data/orders",
  "data/inbox",
  "data/bench",
  "data/market",
  "data/raw",
  "data/quality",
];

const SKIP_NAMES = new Set(["app.sqlite", "app.sqlite-wal", "app.sqlite-shm", ".DS_Store"]);

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    if (SKIP_NAMES.has(name) || name.startsWith(".")) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, files);
    else files.push(abs);
  }
}

const packed = {};

const decisions = join(repoRoot, "DECISIONS.md");
if (!existsSync(decisions)) {
  console.error(`pack-hosted-root: missing ${decisions}`);
  process.exit(1);
}
packed["DECISIONS.md"] = readFileSync(decisions, "utf8");

for (const relDir of INCLUDE_DIRS) {
  const absDir = join(repoRoot, relDir);
  if (!existsSync(absDir)) continue;
  const files = [];
  walk(absDir, files);
  for (const abs of files) {
    const rel = relative(repoRoot, abs).split("\\").join("/");
    const buf = readFileSync(abs);
    // Text is utf8; binaries (e.g. sample_tray.png) as base64.
    const isText = /\.(json|md|txt|csv|edi|xml|gitkeep)$/i.test(rel) || rel.endsWith("gitkeep");
    packed[rel] = isText ? buf.toString("utf8") : `base64:${buf.toString("base64")}`;
  }
}

mkdirSync(dirname(outFile), { recursive: true });
const body = `${JSON.stringify(packed)}\n`;
writeFileSync(outFile, body);
const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
console.log(
  `pack-hosted-root: ${Object.keys(packed).length} files → ${relative(agentCore, outFile)} (${(body.length / 1024).toFixed(0)} KiB, ${digest})`,
);
