import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // No dev badge: it sat on top of the sidebar in demos.
  devIndicators: false,
  // Cursor preview / curl often hit 127.0.0.1; without this, HMR websocket is blocked and client onClick dies.
  allowedDevOrigins: ["127.0.0.1", "localhost", "**.trycloudflare.com"],
};
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
