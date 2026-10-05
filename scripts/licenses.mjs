// The license gate: published packages may depend only on each other, and
// nothing anywhere in the tree may carry a source-available (FSL, BUSL, SSPL,
// …) or copyleft license.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DENIED_LICENSES = /\b(FSL|BUSL|Business Source|SSPL|Elastic|Commons Clause|A?GPL|LGPL)\b/i;
let failed = 0;
const fail = (msg) => {
  console.log(`FAIL ${msg}`);
  failed++;
};

for (const dir of readdirSync("packages")) {
  const pkg = JSON.parse(readFileSync(join("packages", dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!dep.startsWith("@fixwire/"))
      fail(`${pkg.name} depends on ${dep}: published packages carry no third-party dependencies`);
  }
  console.log(`ok   ${pkg.name} (${pkg.license})`);
}

// Everything installed, dev tools included.
const store = "node_modules/.pnpm";
for (const entry of existsSync(store) ? readdirSync(store) : []) {
  const nm = join(store, entry, "node_modules");
  if (!existsSync(nm)) continue;
  for (const scopeOrName of readdirSync(nm)) {
    const names = scopeOrName.startsWith("@")
      ? readdirSync(join(nm, scopeOrName)).map((n) => `${scopeOrName}/${n}`)
      : [scopeOrName];
    for (const name of names) {
      const file = join(nm, name, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      const license =
        typeof pkg.license === "string"
          ? pkg.license
          : JSON.stringify(pkg.license ?? pkg.licenses ?? "unknown");
      if (DENIED_LICENSES.test(license)) fail(`${name}@${pkg.version}: ${license}`);
    }
  }
}
process.exit(failed ? 1 : 0);
