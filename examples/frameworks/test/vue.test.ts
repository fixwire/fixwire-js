// The Vue example (create-vue: Vue 3, vue-router 5, Vite), built for
// production and driven in Chromium: the errors Vue and the router catch
// reach the ingest once each, with their component and route, and pages
// are named after their routes.
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
  dir = await install("vue");
  // The type check (vue-tsc) runs with the build, against the packages' types.
  await run("npm", ["run", "build"], {
    cwd: dir,
    env: { VITE_FIXWIRE_DSN: sink.dsn, VITE_FIXWIRE_RELEASE: "shop@1.0.0" },
  });
  await run("npx", ["fixwire-cli", "sourcemaps", "inject", "dist"], { cwd: dir });
  const port = await freePort();
  app = await serve(
    "npx",
    ["vite", "preview", "--port", String(port), "--host", "127.0.0.1", "--strictPort"],
    { cwd: dir, port },
  );
  browser = await chromium();
});

after(async () => {
  await browser?.close();
  await app?.stop();
  sink?.server.close();
});

const context = (e: Json): Json => e.attributes["fixwire.contexts"].vue;

test("an event handler's error and a render error: reported once, with the component and the route", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("button", { name: "Check out" }).click();
  const checkout = await reported(sink, "Checkout failed: the card was declined");
  assert.equal(thrown(checkout).mechanism.type, "vue");
  assert.equal(context(checkout).componentName, "HomeView");
  // App.vue has no script, so the build gives it no name: the root.
  assert.deepEqual(context(checkout).componentTrace, ["HomeView", "RouterView", "Root"]);
  assert.equal(checkout.attributes["fixwire.transaction"], "/");
  assert.equal(checkout.resource["service.version"], "shop@1.0.0");
  assert.ok(
    (checkout.attributes["fixwire.debug_images"] ?? []).some((i: Json) => i.debug_id),
    "the frames' files carry debug ids",
  );

  await page.getByRole("button", { name: /Empty the cart/ }).click();
  const cart = await reported(sink, "Cannot read the cart: items is undefined");
  assert.equal(context(cart).componentName, "HomeView");
  assert.match(context(cart).lifecycleHook, /render|runtime-1/);
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(errors(sink, "Checkout failed").length, 1);
  assert.equal(errors(sink, "Cannot read the cart").length, 1);
});

test("a page that fails while it's set up: named after its route", async () => {
  const page = await browser.newPage();
  await page.goto(`${app.url}/users/crash`);
  const event = await reported(sink, "The user service is unavailable");
  assert.equal(event.attributes["fixwire.transaction"], "/users/:id");
  assert.equal(context(event).componentName, "UserView");
  await page.close();
});

test("a router guard that throws: reported by the router", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("link", { name: "Reports" }).click();
  const event = await reported(sink, "Reports are unavailable");
  assert.equal(thrown(event).mechanism.type, "vue.router");
  await page.close();
});

test("page loads and navigations are named after their routes", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("link", { name: "User 1" }).click();
  await page.getByRole("heading", { name: "User 1" }).waitFor();
  const op = (s: Json): string => s.attributes["fixwire.op"];
  // A segment ends once its page is idle for a second.
  const spans = await sink.until(() => {
    const got = sink.spans();
    return got.some((s) => op(s) === "navigation") ? got : undefined;
  });
  await page.close();
  assert.ok(spans.some((s) => op(s) === "pageload" && s.name === "/"));
  assert.ok(spans.some((s) => op(s) === "navigation" && s.name === "/users/:id"));
});

test("the build's files and maps carry the same debug ids", () => {
  assert.ok(stampedFiles(join(dir, "dist")) > 0, "hidden source maps are on");
});
