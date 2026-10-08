// The SvelteKit example (sv create: SvelteKit 3, Svelte 5, adapter-node),
// type-checked, built and run on Node.js, driven in Chromium: server and
// browser errors reach the ingest once each, named after their routes; a
// 404 isn't reported.
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
  dir = await install("sveltekit");
  // svelte-check: the hooks against SvelteKit's own types.
  await run("npm", ["run", "check"], { cwd: dir });
  await run("npm", ["run", "build"], { cwd: dir });
  // No fixwire-cli inject: fixwireSvelteKit() stamps the client build while
  // Vite writes it, as adapter-node records the files' sizes when it builds.
  const port = await freePort();
  // One variable for both sides: the server falls back to the public one.
  app = await serve("node", ["build"], {
    cwd: dir,
    port,
    env: { PORT: String(port), HOST: "127.0.0.1", PUBLIC_FIXWIRE_DSN: sink.dsn },
  });
  browser = await chromium();
});

after(async () => {
  await browser?.close();
  await app?.stop();
  sink?.server.close();
});

test("a server load error: reported once, named after its route; a 404 isn't", async () => {
  const page = await browser.newPage();
  const response = await page.goto(`${app.url}/users/crash`);
  assert.equal(response?.status(), 500);
  const event = await reported(sink, "The user service is unavailable");
  assert.equal(event.attributes["fixwire.transaction"], "/users/[id]");
  assert.equal(event.attributes["fixwire.tags"]["sveltekit.kind"], "unknown");
  assert.equal(thrown(event).mechanism.type, "sveltekit.server");
  assert.equal((await page.goto(`${app.url}/no/such/page`))?.status(), 404);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(errors(sink, "The user service is unavailable").length, 1);
  assert.equal(errors(sink, "Not found").length, 0, "404s aren't reported");
  await page.close();
});

test("an endpoint error: reported with its route", async () => {
  const response = await fetch(`${app.url}/api/orders/7`);
  assert.equal(response.status, 500);
  const event = await reported(sink, "The order store is down (order 7)");
  assert.equal(event.attributes["fixwire.transaction"], "/api/orders/[id]");
});

test("browser errors: an event handler's, a render's and a client load's, named after their routes", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("button", { name: "Check out" }).click();
  const checkout = await reported(sink, "Checkout failed: the card was declined");
  assert.equal(checkout.attributes["fixwire.transaction"], "/");
  assert.ok(
    (checkout.attributes["fixwire.debug_images"] ?? []).some((i: Json) => i.debug_id),
    "the frames' files carry debug ids",
  );
  await page.getByRole("button", { name: /Empty the cart/ }).click();
  await reported(sink, "Cannot read the cart: items is undefined");

  await page.getByRole("link", { name: "Reports" }).click();
  const reports = await reported(sink, "Reports are unavailable");
  assert.equal(thrown(reports).mechanism.type, "sveltekit.client");
  assert.equal(reports.attributes["fixwire.transaction"], "/reports");
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  for (const text of ["Checkout failed", "Cannot read the cart", "Reports are unavailable"])
    assert.equal(errors(sink, text).length, 1, text);
});

test("page loads, navigations and server requests are named after their routes", async () => {
  const page = await browser.newPage();
  await page.goto(`${app.url}/users/2`);
  await page.getByRole("heading", { name: "User 2" }).waitFor();
  await page.getByRole("link", { name: "Shop" }).click();
  await page.getByRole("link", { name: "User 1" }).click();
  await page.getByRole("heading", { name: "User 1" }).waitFor();
  const op = (s: Json): string => s.attributes["fixwire.op"];
  const spans = await sink.until(() => {
    const got = sink.spans();
    return got.some((s) => op(s) === "navigation" && s.name === "/users/[id]") ? got : undefined;
  });
  await page.close();
  const pages = spans.filter((s) => op(s) === "pageload").map((s) => s.name);
  assert.ok(pages.includes("/users/[id]"), pages.join(", "));
  const server = spans
    .filter((s) => op(s) === "http.server" && !s.attributes["url.path"].startsWith("/_app/"))
    .map((s) => `${s.name} (${s.attributes["url.path"]})`);
  assert.ok(server.includes("GET /users/[id] (/users/2)"), server.join(", "));
  assert.ok(server.includes("GET /api/orders/[id] (/api/orders/7)"), server.join(", "));
});

test("the build's browser files and maps carry the same debug ids", () => {
  assert.ok(stampedFiles(join(dir, "build/client")) > 0, "hidden source maps are on");
});
