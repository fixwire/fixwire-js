import { withFixwireConfig } from "@fixwire/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

// Source maps for the browser code, for `fixwire-cli sourcemaps upload`.
export default withFixwireConfig(nextConfig);
