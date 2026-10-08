// The Angular example (ng new: Angular 22, zoneless, standalone), built
// for production and driven in Chromium: the errors Angular catches,
// HttpClient's failures, @boundary blocks' and the Router's reach the
// ingest once each, and pages are named after their routes.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { type Json, thrown } from "../../../packages/core/test/helpers.ts";
import { type Ingest, ingest } from "../../test/ingest.ts";
import {
  chromium,
  cli,
  errors,
  freePort,
  install,
  reported,
  run,
  type Server,
  serveStatic,
  stampedFiles,
} from "./kit.ts";

let sink: Ingest;
let dir: string;
let app: Server;
let browser: Awaited<ReturnType<typeof chromium>>;

before(async () => {
  sink = await ingest();
  dir = await install("angular");
  // The DSN goes into the bundle at build time; ng build type-checks the app.
  await run("npx", ["ng", "build", "--define", `FIXWIRE_DSN="${sink.dsn}"`], {
    cwd: dir,
    env: { NG_CLI_ANALYTICS: "false" },
  });
  await cli(dir, ["sourcemaps", "inject", "dist/angular/browser"]);
  app = await serveStatic(
    join(dir, "dist/angular/browser"),
    await freePort(),
    (request, response) => {
      if (!request.url?.startsWith("/api/")) return false;
      response
        .writeHead(503, { "content-type": "application/json" })
        .end('{"detail":"store down"}');
      return true;
    },
  );
  browser = await chromium();
});

after(async () => {
  await browser?.close();
  await app?.stop();
  sink?.server.close();
});

test("an event handler's error: from Angular's ErrorHandler, once, with debug ids", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("button", { name: "Check out" }).click();
  const checkout = await reported(sink, "Checkout failed: the card was declined");
  assert.equal(thrown(checkout).mechanism.type, "angular");
  assert.equal(checkout.attributes["fixwire.transaction"], "/");
  assert.ok(
    (checkout.attributes["fixwire.debug_images"] ?? []).some((i: Json) => i.debug_id),
    "the frames' files carry debug ids",
  );
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(errors(sink, "Checkout failed").length, 1);
});

test("a failed HttpClient request nobody handles: once, with its status and URL, without the body", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("button", { name: "Load order 7" }).click();
  const event = await reported(sink, "Http failure response for");
  assert.equal(thrown(event).type, "HttpErrorResponse");
  assert.equal(event.attributes["fixwire.contexts"].http.status, 503);
  assert.match(event.attributes["fixwire.contexts"].http.url, /\/api\/orders\/7$/);
  assert.ok(!JSON.stringify(event).includes("store down"), "no response body");
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  const all = errors(sink, "Http failure response for");
  assert.equal(all.length, 1, JSON.stringify(all.map((e) => thrown(e).mechanism)));
});

test("a render error a @boundary block caught: handled, with its component", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("button", { name: "Empty the cart" }).click();
  await page.getByText("The cart couldn't be shown.").waitFor();
  const event = await reported(sink, "Cannot read the cart: items is undefined");
  assert.equal(thrown(event).mechanism.handled, true);
  assert.equal(event.attributes["fixwire.contexts"].angular.component, "app-cart-summary");
  await page.close();
});

test("a guard that throws: the failed navigation is reported once", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.getByRole("link", { name: "Reports" }).click();
  const event = await reported(sink, "Reports are unavailable");
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  const all = errors(sink, "Reports are unavailable");
  assert.equal(all.length, 1, JSON.stringify(all.map((e) => thrown(e).mechanism)));
  assert.equal(thrown(event).mechanism.type, "angular.router");
});

test("page loads and navigations are named after their routes", async () => {
  const page = await browser.newPage();
  await page.goto(`${app.url}/users/2`);
  await page.getByRole("heading", { name: "User 2" }).waitFor();
  await page.getByRole("link", { name: "Shop" }).click();
  await page.getByRole("link", { name: "User 1" }).click();
  await page.getByRole("heading", { name: "User 1" }).waitFor();
  const op = (s: Json): string => s.attributes["fixwire.op"];
  const spans = await sink.until(() => {
    const got = sink.spans();
    return got.some((s) => op(s) === "navigation" && s.name === "/users/:id") ? got : undefined;
  });
  await page.close();
  const pages = spans.filter((s) => op(s) === "pageload").map((s) => s.name);
  assert.ok(pages.includes("/users/:id"), pages.join(", "));
});

test("the build's files and maps carry the same debug ids", () => {
  assert.ok(stampedFiles(join(dir, "dist/angular/browser")) > 0, "hidden source maps are on");
});
