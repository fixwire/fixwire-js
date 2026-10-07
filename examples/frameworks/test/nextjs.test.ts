// The Next.js example, built for production and driven in Chromium: server
// render errors, route handler errors and browser errors reach the ingest
// with route names, each once, and the browser's carry debug ids.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Json } from "../../../packages/core/test/helpers.ts";
import { thrown } from "../../../packages/core/test/helpers.ts";
import { type Ingest, ingest } from "../../test/ingest.ts";
import { chromium, freePort, install, run, type Server, serve } from "./kit.ts";

let sink: Ingest;
let dir: string;
let app: Server;
let browser: Awaited<ReturnType<typeof chromium>>;

const message = (e: Json): string => thrown(e)?.message;
const errors = (text: string): Json[] =>
  sink.events().filter((e) => e.eventName === "exception" && message(e)?.includes(text));

before(async () => {
  sink = await ingest();
  dir = await install("nextjs");
  const env = { NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_FIXWIRE_DSN: sink.dsn };
  await run("npm", ["run", "build"], { cwd: dir, env });
  await run("npx", ["fixwire-cli", "sourcemaps", "inject", ".next/static"], { cwd: dir });
  const port = await freePort();
  app = await serve("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: dir,
    port,
    env: { ...env, FIXWIRE_DSN: sink.dsn },
  });
  browser = await chromium();
});

after(async () => {
  await browser?.close();
  await app?.stop();
  sink?.server.close();
});

test("a server render error: reported once, with the route and the router's context", async () => {
  const page = await browser.newPage();
  const response = await page.goto(`${app.url}/users/crash`);
  assert.equal(response?.status(), 500);
  await page.getByText("Something went wrong").waitFor();
  const [event] = await sink.until(() => {
    const got = errors("The user service is unavailable");
    return got.length ? got : undefined;
  });
  const a = event?.attributes as Json;
  assert.equal(a["fixwire.transaction"], "/users/[id]");
  assert.equal(new URL(a["url.full"]).pathname, "/users/crash");
  assert.equal(a["fixwire.tags"]["nextjs.route_type"], "render");
  assert.equal(a["fixwire.tags"]["user.id"], "crash");
  assert.equal(a["fixwire.contexts"].nextjs.routerKind, "App Router");
  assert.equal(thrown(event as Json).mechanism.type, "nextjs.request");
  // The error page got it with a digest, so the browser didn't report it again.
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(errors("Server Components render").length, 0);
  assert.equal(errors("The user service is unavailable").length, 1);
  await page.close();
});

test("a route handler error: reported with the route", async () => {
  const response = await fetch(`${app.url}/api/orders/7`);
  assert.equal(response.status, 500);
  const [event] = await sink.until(() => {
    const got = errors("The order store is down (order 7)");
    return got.length ? got : undefined;
  });
  const a = event?.attributes as Json;
  assert.equal(a["fixwire.transaction"], "/api/orders/[id]");
  assert.equal(a["fixwire.tags"]["nextjs.route_type"], "route");
  assert.equal(a["http.request.method"], "GET");
});

test("browser errors: an event handler's and a render error's, with debug ids and navigations", async () => {
  const page = await browser.newPage();
  await page.goto(app.url);
  // Through the client router, so onRouterTransitionStart leaves a breadcrumb.
  await page.getByRole("link", { name: "User 1" }).click();
  await page.getByRole("heading", { name: "User 1" }).waitFor();
  await page.getByRole("link", { name: "Shop" }).click();
  await page.getByRole("button", { name: "Check out" }).click();
  const [checkout] = await sink.until(() => {
    const got = errors("Checkout failed: the card was declined");
    return got.length ? got : undefined;
  });
  const a = checkout?.attributes as Json;
  assert.equal(thrown(checkout as Json).mechanism.handled, false);
  assert.ok(
    (a["fixwire.debug_images"] ?? []).some((i: Json) => i.type === "sourcemap" && i.debug_id),
    "the frames' files carry debug ids",
  );
  assert.ok(
    (a["fixwire.breadcrumbs"] ?? []).some(
      (b: Json) => b.category === "navigation" && b.data?.to === "/users/1",
    ),
    "the navigation to /users/1 is a breadcrumb",
  );

  await page.getByRole("button", { name: /Empty the cart/ }).click();
  await page.getByText("Something went wrong").waitFor();
  const [cart] = await sink.until(() => {
    const got = errors("Cannot read the cart: items is undefined");
    return got.length ? got : undefined;
  });
  assert.equal(thrown(cart as Json).mechanism.type, "nextjs.error_page");
  await page.close();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(errors("Cannot read the cart").length, 1, "reported once");
  assert.equal(errors("Checkout failed").length, 1, "reported once");
});

test("the page load is traced in the browser, the requests on the server", async () => {
  const op = (s: Json): string => s.attributes["fixwire.op"];
  const spans = await sink.until(() => {
    const got = sink.spans();
    return got.some((s) => op(s) === "pageload") && got.some((s) => op(s) === "http.server")
      ? got
      : undefined;
  });
  assert.ok(spans.some((s) => op(s) === "pageload" && s.name === "/"));
  assert.ok(spans.some((s) => op(s) === "navigation" && s.name === "/users/1"));
  // The failed render's segment is named after its route.
  assert.ok(spans.some((s) => op(s) === "http.server" && s.name === "GET /users/[id]"));
});

test("the build's browser files and maps carry the same debug ids", () => {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else files.push(join(d, e.name));
    }
  };
  walk(join(dir, ".next/static"));
  // Turbopack names a map by its own hash: the file's sourceMappingURL says which.
  const stamped = files
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ f, code: readFileSync(f, "utf8") }))
    .filter(({ code }) => code.includes("//# sourceMappingURL="));
  assert.ok(stamped.length > 0, "productionBrowserSourceMaps is on");
  for (const { f, code } of stamped) {
    const id = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1];
    const map = /\/\/# sourceMappingURL=(\S+)/.exec(code)?.[1] as string;
    assert.ok(id, `${f} carries a debug id`);
    assert.equal(JSON.parse(readFileSync(join(f, "..", map), "utf8")).debug_id, id);
  }
});
