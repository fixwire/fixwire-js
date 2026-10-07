import assert from "node:assert/strict";
import { test } from "node:test";

import { ingest } from "../../../examples/test/ingest.ts";
import { thrown } from "../../core/test/helpers.ts";
import * as Fixwire from "../src/index.ts";

test("withFixwireConfig: browser source maps on, an explicit setting kept, config functions too", async () => {
  assert.deepEqual(Fixwire.withFixwireConfig({ reactStrictMode: true }), {
    reactStrictMode: true,
    productionBrowserSourceMaps: true,
  });
  assert.equal(
    Fixwire.withFixwireConfig({ productionBrowserSourceMaps: false }).productionBrowserSourceMaps,
    false,
  );
  const fn = Fixwire.withFixwireConfig(async (phase: string) => ({ env: { phase } }));
  assert.deepEqual(await fn("phase-production-build", { defaultConfig: {} }), {
    env: { phase: "phase-production-build" },
    productionBrowserSourceMaps: true,
  });
});

test("init on Node.js: the DSN from NEXT_PUBLIC_FIXWIRE_DSN; request errors with the route", async () => {
  const sink = await ingest();
  const before = { ...process.env };
  delete process.env.FIXWIRE_DSN;
  process.env.NEXT_PUBLIC_FIXWIRE_DSN = sink.dsn;
  process.env.NEXT_PUBLIC_FIXWIRE_ENVIRONMENT = "preview";
  try {
    const client = Fixwire.init({ defaultIntegrations: false });
    assert.equal(client.options.dsn, sink.dsn);
    assert.equal(client.options.environment, "preview");
  } finally {
    process.env = before;
  }
  await Fixwire.captureRequestError(
    Object.assign(new Error("no such user"), { digest: "1234" }),
    { path: "/users/42?tab=1", method: "GET", headers: {} },
    { routerKind: "App Router", routePath: "/users/[id]", routeType: "render" },
  );
  const [event] = sink.events();
  assert.equal(event?.attributes["fixwire.transaction"], "/users/[id]");
  assert.equal(thrown(event as Record<string, never>).mechanism.type, "nextjs.request");
  await Fixwire.close();
  sink.server.close();
});

test("an explicit DSN wins, and useEnvironment: false reads nothing", () => {
  process.env.NEXT_PUBLIC_FIXWIRE_DSN = "http://other@127.0.0.1:1";
  try {
    assert.equal(
      Fixwire.init({ dsn: "http://mine@127.0.0.1:1", defaultIntegrations: false }).options.dsn,
      "http://mine@127.0.0.1:1",
    );
    assert.equal(
      Fixwire.init({ useEnvironment: false, defaultIntegrations: false }).options.dsn,
      undefined,
    );
  } finally {
    delete process.env.NEXT_PUBLIC_FIXWIRE_DSN;
  }
});

test("onRouterTransitionStart leaves a navigation breadcrumb", () => {
  Fixwire.onRouterTransitionStart("/users/7", "push");
  const crumbs = Fixwire.getIsolationScope().breadcrumbs;
  assert.deepEqual(crumbs.at(-1)?.data, { to: "/users/7", type: "push" });
});
