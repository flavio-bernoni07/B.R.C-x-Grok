import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {};
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
