// What each package's npm tarball contains: the code, its types, the
// license and notice (MIT requires them) and a README. Run after build.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const REQUIRED = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
];
let failed = 0;
for (const dir of readdirSync("packages")) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: `packages/${dir}`,
    encoding: "utf8",
  });
  const [info] = JSON.parse(out);
  const files = new Set(info.files.map((f) => f.path));
  const missing = REQUIRED.filter((f) => !files.has(f));
  if (missing.length) {
    console.log(`FAIL ${info.name}: missing ${missing.join(", ")}`);
    failed++;
  } else
    console.log(
      `ok   ${info.name}: ${info.files.length} files, ${(info.size / 1024).toFixed(1)} KB`,
    );
}
if (failed) process.exit(1);
