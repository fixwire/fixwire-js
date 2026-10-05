import { defineConfig } from "vite";

export default defineConfig({
  // Resolve the SDK from its TypeScript source inside this repo; outside it,
  // the published package needs nothing special.
  resolve: { conditions: ["fixwire-source"] },
  // Source maps for Fixwire: uploaded by `npm run sourcemaps`, never served.
  build: { sourcemap: "hidden" },
  define: {
    "import.meta.env.FIXWIRE_DSN": JSON.stringify(process.env.FIXWIRE_DSN ?? ""),
  },
});
