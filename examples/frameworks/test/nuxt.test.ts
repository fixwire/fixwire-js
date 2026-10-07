// The Nuxt example (create-nuxt, Nuxt 4), built for production, run on
// Node.js and driven in Chromium: server render, API and browser errors
// reach the ingest once each, named after their routes, with what the
// fixwire.*.config files add; a 404 isn't reported.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { type Json, thrown } from "../../../packages/core/test/helpers.ts";
import { type Ingest, ingest } from "../../test/ingest.ts";
import {
  chromium,
  errors,
  freePort,
  install,
  reported,
  run,
  type Server,
  serve,
  stampedFiles,
} from "./kit.ts";

let sink: Ingest;
let dir: string;
let app: Server;
let browser: Awaited<ReturnType<typeof chromium>>;

before(async () => {
  sink = await ingest();
  dir = await install("nuxt");
  // The module's options in nuxt.config and the config files, type-checked.
  await run("npm", ["run", "typecheck"], { cwd: dir, env: { NUXT_TELEMETRY_DISABLED: "1" } });
  await run("npm", ["run", "build"], { cwd: dir, env: { NUXT_TELEMETRY_DISABLED: "1" } });
  // No fixwire-cli inject: the module stamps the browser files while Nuxt
  // builds, before Nitro records their sizes.
  const port = await freePort();
  // The DSN is runtime config: set when the server starts, not at build time.
  app = await serve("node", [".output/server/index.mjs"], {
    cwd: dir,
    port,
    env: { PORT: String(port), HOST: "127.0.0.1", NUXT_PUBLIC_FIXWIRE_DSN: sink.dsn },
  });
  browser = await chromium();
});

after(async () => {
  await browser?.close();
  await app?.stop();
  sink?.server.close();
});

test("a server render error: reported once from the server, named after the page's route", async () => {
  const page = await browser.newPage();
  const response = await page.goto(`${app.url}/users/crash`);
  assert.equal(response?.status(), 500);
  const event = await reported(sink, "The user service is unavailable");
  const a = event.attributes as Json;
  assert.equal(a["fixwire.transaction"], "/users/:id");
  assert.equal(a["fixwire.tags"].side, "server", "fixwire.server.config's beforeSend ran");
  assert.equal(thrown(event).mechanism.type, "nuxt.vue");
  await new Promise((r) => setTimeout(r, 1000));
  const all = errors(sink, "The user service is unavailable");
  assert.equal(
    all.length,
    1,
    JSON.stringify(all.map((e) => [thrown(e).mechanism, e.attributes["fixwire.tags"]])),
  );
  await page.close();
});

test("an API route error: reported with its route; a 404 isn't", async () => {
  const response = await fetch(`${app.url}/api/orders/7`);
  assert.equal(response.status, 500);
  const event = await reported(sink, "The order store is down (order 7)");
  assert.equal(event.attributes["fixwire.transaction"], "/api/orders/:id");
  assert.equal(thrown(event).mechanism.type, "nuxt.nitro");
  assert.equal((await fetch(`${app.url}/no/such/page`)).status, 404);
  assert.equal((await fetch(`${app.url}/api/no-such-route`)).status, 404);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(
    sink.events().filter((e) => /not found/i.test(thrown(e)?.message ?? "")).length,
    0,
    "404s aren't reported",
  );
});

test("browser errors: an event handler's and a render error's, with the component, the route and debug ids", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("button", { name: "Check out" }).click();
  const checkout = await reported(sink, "Checkout failed: the card was declined");
  const a = checkout.attributes as Json;
  assert.equal(thrown(checkout).mechanism.type, "nuxt.vue");
  assert.equal(a["fixwire.transaction"], "/");
  assert.equal(a["fixwire.tags"].side, "browser", "fixwire.client.config's beforeSend ran");
  assert.ok(a["fixwire.contexts"].vue.componentTrace.length > 0);
  assert.ok(
    (a["fixwire.debug_images"] ?? []).some((i: Json) => i.debug_id),
    "the frames' files carry debug ids",
  );
  // The page keeps working: Nuxt doesn't show its error page for it.
  await page.getByRole("heading", { name: "Shop" }).waitFor();

  await page.getByRole("button", { name: /Empty the cart/ }).click();
  await reported(sink, "Cannot read the cart: items is undefined");
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(errors(sink, "Checkout failed").length, 1);
  assert.equal(errors(sink, "Cannot read the cart").length, 1);
});

test("page loads, navigations and server requests are named after their routes", async () => {
  const page = await browser.newPage();
  await page.goto(`${app.url}/users/2`); // rendered on the server
  await page.getByRole("heading", { name: "User 2" }).waitFor();
  await page.goto(app.url);
  await page.getByRole("link", { name: "User 1" }).click(); // in the browser
  await page.getByRole("heading", { name: "User 1" }).waitFor();
  const op = (s: Json): string => s.attributes["fixwire.op"];
  const spans = await sink.until(() => {
    const got = sink.spans();
    return got.some((s) => op(s) === "navigation") ? got : undefined;
  });
  await page.close();
  assert.ok(spans.some((s) => op(s) === "pageload" && s.name === "/"));
  assert.ok(spans.some((s) => op(s) === "navigation" && s.name === "/users/:id"));
  const server = spans
    .filter((s) => op(s) === "http.server" && !s.attributes["url.path"].startsWith("/_nuxt/"))
    .map((s) => `${s.name} (${s.attributes["url.path"]})`);
  assert.ok(server.includes("GET /users/:id (/users/2)"), server.join(", "));
  assert.ok(server.includes("GET /users/:id (/users/crash)"), server.join(", "));
  assert.ok(server.includes("GET /api/orders/:id (/api/orders/7)"), server.join(", "));
});

test("the build's browser files and maps carry the same debug ids", () => {
  assert.ok(stampedFiles(join(dir, ".output/public")) > 0, "hidden client source maps are on");
});
