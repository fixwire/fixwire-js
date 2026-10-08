import assert from "node:assert/strict";
import { test } from "node:test";

import { debugIdFor, fixwireSvelteKit, stampBundle } from "../src/vite.ts";

const map = (mappings: string) => JSON.stringify({ version: 3, sources: ["a.ts"], mappings });

test("stampBundle: chunks with maps get the snippet on a line of their own, their maps one line more", () => {
  const sourceMap = { mappings: "AAAA,SAAS" };
  const bundle = {
    "app.js": { type: "chunk", fileName: "app.js", code: 'import"./b.js";go()', map: sourceMap },
    "app.js.map": { type: "asset", fileName: "app.js.map", source: map("AAAA,SAAS") },
    "b.js": {
      type: "chunk",
      fileName: "b.js",
      code: "export const b=1;\n//# sourceMappingURL=b.js.map",
      map: { mappings: "AAAA" },
    },
    "strict.js": {
      type: "chunk",
      fileName: "strict.js",
      code: '"use strict";x()',
      map: { mappings: "AAAA" },
    },
    "nomap.js": { type: "chunk", fileName: "nomap.js", code: "x()", map: null },
    "style.css": { type: "asset", fileName: "style.css", source: "a{}" },
  } as const;
  const b = structuredClone(bundle) as unknown as Parameters<typeof stampBundle>[0];
  (b["app.js"] as { map: unknown }).map = sourceMap;
  assert.equal(stampBundle(b), 2);
  const id = debugIdFor('import"./b.js";go()');
  const app = b["app.js"] as { code: string };
  const [first, second, third] = app.code.split("\n");
  assert.ok(first?.includes(`g._fixwireDebugIds[s]="${id}"`));
  assert.equal(second, 'import"./b.js";go()');
  assert.equal(third, `//# debugId=${id}`);
  assert.equal(sourceMap.mappings, ";AAAA,SAAS");
  const asset = JSON.parse(String((b["app.js.map"] as { source: string }).source));
  assert.deepEqual([asset.mappings, asset.debug_id], [";AAAA,SAAS", id]);
  // The sourceMappingURL comment stays last.
  assert.match(
    (b["b.js"] as { code: string }).code,
    /\/\/# debugId=[0-9a-f-]{36}\n\/\/# sourceMappingURL=b\.js\.map$/,
  );
  assert.equal((b["strict.js"] as { code: string }).code, '"use strict";x()');
  assert.equal(stampBundle(b), 0, "stamped once");
});

test("the plugin stamps the client build only", () => {
  const chunk = () => ({
    "a.js": { type: "chunk" as const, fileName: "a.js", code: "a()", map: { mappings: "AAAA" } },
  });
  const plugin = fixwireSvelteKit();
  assert.deepEqual(
    [plugin.name, plugin.apply, plugin.enforce],
    ["fixwire:sveltekit", "build", "post"],
  );
  const stamped = (context: unknown, ssr: boolean) => {
    plugin.configResolved({ build: { ssr } });
    const bundle = chunk();
    plugin.generateBundle.call(context, {}, bundle);
    return bundle["a.js"].code.includes("debugId");
  };
  assert.equal(stamped({ environment: { config: { consumer: "client" } } }, false), true);
  assert.equal(stamped({ environment: { config: { consumer: "server" } } }, false), false);
  assert.equal(stamped({}, false), true, "Vite 5's client build");
  assert.equal(stamped({}, true), false, "Vite 5's server build");
  const off = fixwireSvelteKit({ debugIds: false });
  off.configResolved({ build: {} });
  const bundle = chunk();
  off.generateBundle.call({}, {}, bundle);
  assert.equal(bundle["a.js"].code, "a()");
});
