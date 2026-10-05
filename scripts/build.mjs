// Builds each package's dist: ES modules, declarations and maps (the maps
// point at src, which is published, so "go to definition" lands on source),
// and copies the license and notice into each package, as its tarball must
// carry them.
// tsc rewrites ".ts" import specifiers in the JavaScript it emits but not in
// declarations, so this rewrites them there.
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g;

// core first: the others are built against its declarations.
for (const pkg of ["core", "browser", "node", "edge", "react"]) {
  const dir = `packages/${pkg}`;
  rmSync(`${dir}/dist`, { recursive: true, force: true });
  for (const f of ["LICENSE", "NOTICE"]) copyFileSync(f, `${dir}/${f}`);
  execFileSync(process.execPath, [tsc, "-p", `${dir}/tsconfig.build.json`], { stdio: "inherit" });
  for (const file of readdirSync(`${dir}/dist`)) {
    if (!file.endsWith(".d.ts")) continue;
    const path = `${dir}/dist/${file}`;
    const source = readFileSync(path, "utf8");
    const out = source.replace(SPECIFIER, "$1$2$3.js$2");
    if (out !== source) writeFileSync(path, out);
  }
}
