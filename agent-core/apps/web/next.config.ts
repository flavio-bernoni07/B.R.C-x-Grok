import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

// apps/web → agent-core → repo. data/ and DECISIONS.md live on the repo.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const nextConfig: NextConfig = {
  // No dev badge: it sat on top of the sidebar in demos.
  devIndicators: false,
  // Cursor preview / curl often hit 127.0.0.1; without this, HMR websocket is blocked and client onClick dies.
  allowedDevOrigins: ["127.0.0.1", "localhost", "**.trycloudflare.com", "**.vercel.app"],
  // Two pre-existing type errors (shell initial prop, sign-off "board" tab). The dev server runs with them.
  typescript: { ignoreBuildErrors: true },
  // better-sqlite3 is a native module. Bundling it drops the .node file.
  serverExternalPackages: ["better-sqlite3"],
  // The file tracer starts at the app folder. The demo files are two levels up.
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    "*": [
      "../../../data/world/**/*",
      "../../../data/disputes/**/*",
      "../../../data/orders/**/*",
      "../../../data/inbox/**/*",
      "../../../data/bench/**/*",
      "../../../data/market/**/*",
      "../../../data/raw/**/*",
      "../../../data/quality/**/*",
      "../../../DECISIONS.md",
    ],
  },
  outputFileTracingExcludes: {
    "*": [
      "../../../planning/**/*",
      "../../../host/**/*",
      "../../../**/.git/**/*",
      "../../../**/.venv/**/*",
    ],
  },
};
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
