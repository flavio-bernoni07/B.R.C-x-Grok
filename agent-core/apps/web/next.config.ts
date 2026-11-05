import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

// No dev badge: it sat on top of the sidebar in demos.
const nextConfig: NextConfig = { devIndicators: false };
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
