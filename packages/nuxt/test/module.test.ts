import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Nuxt } from "@nuxt/schema";

import { debugIdFor, stampDebugIds } from "../src/debugids.ts";
import fixwire from "../src/index.ts";
import { settings } from "../src/runtime/shared.ts";

/** As much of a Nuxt instance as the module touches. */
function fakeNuxt(rootDir: string, config: Record<string, unknown> = {}) {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  const options = {
    sourcemap: { server: true, client: "hidden" } as unknown,
    rootDir,
    runtimeConfig: { public: {} as Record<string, unknown> },
    build: { transpile: [] as string[] },
    alias: {} as Record<string, string>,
    plugins: [{ src: "/app/plugins/theirs.ts" }] as { src: string; mode?: string }[],
    nitro: { plugins: ["/app/server/plugins/theirs.ts"] as string[] },
    ...config,
  };
  const hook = (name: string, fn: (...args: unknown[]) => unknown) => {
    hooks[name] = fn;
  };
  return { nuxt: { options, hook } as unknown as Nuxt, options, hooks };
}

test("the module: runtime config, plugins on both sides, Nitro's plugin, the runtime built with the app", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixwire-nuxt-"));
  const { nuxt, options } = fakeNuxt(root, {
    fixwire: { dsn: "https://k@ingest.example", tracesSampleRate: 0.5 },
  });
  await fixwire({ environment: "staging" }, nuxt);
  assert.deepEqual(options.runtimeConfig.public.fixwire, {
    dsn: "https://k@ingest.example",
    release: "",
    environment: "staging",
    tracesSampleRate: 0.5,
  });
  assert.deepEqual(
    options.plugins.map((p) => [p.src.split(/[\\/]/).at(-1), p.mode]),
    [
      ["plugin.client.js", "client"],
      ["plugin.server.js", "server"],
      ["theirs.ts", undefined],
    ],
  );
  assert.equal(options.nitro.plugins.length, 2);
  assert.match(options.nitro.plugins[1] as string, /runtime[\\/]nitro\.js$/);
  assert.match(options.build.transpile[0] as string, /runtime$/);
  // Without config files, both aliases lead to the empty one.
  assert.match(options.alias["#fixwire/client-config"] as string, /runtime[\\/]config\.js$/);
  assert.match(options.alias["#fixwire/server-config"] as string, /runtime[\\/]config\.js$/);
  assert.deepEqual(await fixwire.getMeta?.(), {
    name: "@fixwire/nuxt",
    configKey: "fixwire",
    compatibility: { nuxt: ">=3.13.0" },
  });
});

test("config files are found, and runtimeConfig set by the app wins", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixwire-nuxt-"));
  writeFileSync(join(root, "fixwire.client.config.ts"), "export default {}");
  writeFileSync(join(root, "fixwire.server.config.mjs"), "export default {}");
  const { nuxt, options } = fakeNuxt(root);
  options.runtimeConfig.public.fixwire = { dsn: "https://mine@ingest.example" };
  await fixwire({ dsn: "https://module@ingest.example" }, nuxt);
  assert.equal(options.alias["#fixwire/client-config"], join(root, "fixwire.client.config.ts"));
  assert.equal(options.alias["#fixwire/server-config"], join(root, "fixwire.server.config.mjs"));
  assert.equal(
    (options.runtimeConfig.public.fixwire as { dsn: string }).dsn,
    "https://mine@ingest.example",
  );
});

test("settings: empty strings are unset, the config file wins, attachProps apart", () => {
  const beforeSend = () => null;
  const got = settings(
    { dsn: "", release: "shop@1", environment: "", attachProps: true, tracesSampleRate: 1 },
    () => ({ environment: "preview", beforeSend }),
  );
  assert.deepEqual(got, {
    options: { release: "shop@1", tracesSampleRate: 1, environment: "preview", beforeSend },
    attachProps: true,
  });
  assert.deepEqual(settings(undefined, undefined), { options: {}, attachProps: false });
});

const map = (mappings: string) => JSON.stringify({ version: 3, sources: ["a.ts"], mappings });

test("debug ids: stamped during the build, the maps' lines moved down by one, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "fixwire-public-"));
  mkdirSync(join(dir, "_nuxt"));
  const file = (name: string, body: string) => writeFileSync(join(dir, "_nuxt", name), body);
  file("a.js", 'import{x}from"./b.js";x()');
  file("a.js.map", map("AAAA,SAAS"));
  file("b.js", "export const x=1;\n//# sourceMappingURL=b.4f2a.map\n");
  file("b.4f2a.map", map("AAAA;AACA"));
  file("strict.js", '"use strict";a()');
  file("strict.js.map", map("AAAA"));
  file("nomap.js", "a()");
  file("out.js", "a()\n//# sourceMappingURL=../../outside.map\n");
  writeFileSync(join(dir, "..", "outside.map"), map("AAAA"));
  try {
    symlinkSync(join(dir, "_nuxt", "a.js"), join(dir, "_nuxt", "link.js"));
  } catch {
    // no symbolic links here
  }

  assert.equal(stampDebugIds(dir), 2);
  const read = (name: string) => readFileSync(join(dir, "_nuxt", name), "utf8");
  const id = debugIdFor('import{x}from"./b.js";x()');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const [first, second, third] = read("a.js").split("\n");
  assert.ok(first?.includes(`g._fixwireDebugIds[s]="${id}"`));
  assert.equal(second, 'import{x}from"./b.js";x()');
  assert.equal(third, `//# debugId=${id}`);
  const aMap = JSON.parse(read("a.js.map"));
  assert.deepEqual([aMap.mappings, aMap.debug_id, aMap.debugId], [";AAAA,SAAS", id, id]);
  assert.equal(JSON.parse(read("b.4f2a.map")).mappings, ";AAAA;AACA");
  assert.equal(read("strict.js"), '"use strict";a()', "a prologue stays first");
  assert.ok(!read("out.js").includes("debugId"), "a map outside the directory");

  const before = read("a.js") + read("a.js.map");
  assert.equal(stampDebugIds(dir), 0, "a second build step changes nothing");
  assert.equal(read("a.js") + read("a.js.map"), before);
});

test("the module stamps the public files when browser source maps are on, not otherwise", async () => {
  for (const client of ["hidden", false]) {
    const root = mkdtempSync(join(tmpdir(), "fixwire-nuxt-"));
    const { nuxt, options, hooks } = fakeNuxt(root);
    options.sourcemap = { server: true, client };
    await fixwire({}, nuxt);
    const publicDir = join(root, ".output/public");
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, "a.js"), "a()");
    writeFileSync(join(publicDir, "a.js.map"), map("AAAA"));
    await hooks["nitro:build:public-assets"]?.({ options: { output: { publicDir } } });
    assert.equal(
      readFileSync(join(publicDir, "a.js"), "utf8").includes("debugId"),
      client === "hidden",
    );
  }
});
