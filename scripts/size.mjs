// The browser bundles must stay small, minified and gzipped: the errors path
// (init + captureException) under 16 KB (what fixwire-protocol §13 asks of
// every SDK, such as cutting strings by UTF-8 bytes after redaction, grew it
// from 15 KB; Node versions' zlib differ by tens of bytes, so the budget isn't
// set to the byte), and the tracing path (adding browserTracingIntegration and
// startSpan) under 20 KB. The framework packages' browser entries add their
// glue to the tracing path (the app has the framework itself).

import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const paths = [
  {
    name: "errors path",
    budget: 16 * 1024,
    entry:
      "export { init, captureException, captureMessage, setTag, setUser } from '@fixwire/browser';",
  },
  {
    name: "tracing path",
    budget: 20 * 1024,
    entry:
      "export { init, captureException, captureMessage, setTag, setUser, browserTracingIntegration, startSpan } from '@fixwire/browser';",
  },
  {
    name: "Next.js browser",
    pkg: "@fixwire/nextjs",
    budget: 21 * 1024,
    entry:
      "export { init, captureException, useCaptureException, onRouterTransitionStart } from '@fixwire/nextjs';",
    external: ["react"],
  },
];

let failed = false;
for (const p of paths) {
  const result = await build({
    stdin: {
      contents: p.entry,
      resolveDir: `packages/${(p.pkg ?? "@fixwire/browser").slice(9)}`,
      loader: "js",
    },
    external: p.external,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["fixwire-source"],
    write: false,
  });
  const code = result.outputFiles[0].contents;
  const gz = gzipSync(code, { level: 9 }).length;
  console.log(
    `${p.pkg ?? "@fixwire/browser"} ${p.name}: ${(code.length / 1024).toFixed(1)} KB min, ${(gz / 1024).toFixed(1)} KB gzip, ${gz} bytes (budget ${p.budget} bytes)`,
  );
  if (gz > p.budget) failed = true;
}
if (failed) process.exit(1);
