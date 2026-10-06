// The browser bundles must stay small, minified and gzipped: the errors path
// (init + captureException) under 15.9 KB (16,256 bytes: what fixwire-protocol §13
// asks of every SDK, such as cutting strings by UTF-8 bytes after redaction,
// grew it from 15 KB), and the tracing path (adding browserTracingIntegration
// and startSpan) under 20 KB.

import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const paths = [
  {
    name: "errors path",
    budget: 16_256,
    entry:
      "export { init, captureException, captureMessage, setTag, setUser } from '@fixwire/browser';",
  },
  {
    name: "tracing path",
    budget: 20 * 1024,
    entry:
      "export { init, captureException, captureMessage, setTag, setUser, browserTracingIntegration, startSpan } from '@fixwire/browser';",
  },
];

let failed = false;
for (const p of paths) {
  const result = await build({
    stdin: { contents: p.entry, resolveDir: "packages/browser", loader: "js" },
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
    `@fixwire/browser ${p.name}: ${(code.length / 1024).toFixed(1)} KB min, ${(gz / 1024).toFixed(1)} KB gzip (budget ${p.budget / 1024} KB)`,
  );
  if (gz > p.budget) failed = true;
}
if (failed) process.exit(1);
