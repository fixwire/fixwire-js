// Builds each package's dist: ES modules, declarations and maps (the maps
// point at src, which is published, so "go to definition" lands on source),
// and copies the license and notice into each package, as its tarball must
// carry them.
// tsc rewrites ".ts" import specifiers in the JavaScript it emits but not in
// declarations, so this rewrites them there.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g;

// Each package after the ones it's built against: core, then the runtimes,
// then the frameworks (nuxt builds on vue).
const ORDER = [
  "core",
  "browser",
  "node",
  "edge",
  "react",
  "vue",
  "nextjs",
  "nuxt",
  "sveltekit",
  "angular",
];

for (const pkg of ORDER) {
  const dir = `packages/${pkg}`;
  if (!existsSync(dir)) continue;
  rmSync(`${dir}/dist`, { recursive: true, force: true });
  for (const f of ["LICENSE", "NOTICE"]) copyFileSync(f, `${dir}/${f}`);
  execFileSync(process.execPath, [tsc, "-p", `${dir}/tsconfig.build.json`], { stdio: "inherit" });
  for (const file of readdirSync(`${dir}/dist`, { recursive: true })) {
    if (!String(file).endsWith(".d.ts")) continue;
    const path = `${dir}/dist/${file}`;
    const source = readFileSync(path, "utf8");
    const out = source.replace(SPECIFIER, "$1$2$3.js$2");
    if (out !== source) writeFileSync(path, out);
  }
}
const unknown = readdirSync("packages").filter((p) => !ORDER.includes(p));
if (unknown.length) throw new Error(`build.mjs doesn't know where to build ${unknown.join(", ")}`);
