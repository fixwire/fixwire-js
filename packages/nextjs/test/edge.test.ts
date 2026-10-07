import assert from "node:assert/strict";
import { test } from "node:test";

import { ingest } from "../../../examples/test/ingest.ts";
import { thrown } from "../../core/test/helpers.ts";
import * as Fixwire from "../src/edge.ts";

test("edge runtime: request errors with the route, delivered before it returns", async () => {
  const sink = await ingest();
  process.env.NEXT_PUBLIC_FIXWIRE_DSN = sink.dsn;
  try {
    assert.equal(Fixwire.init({ defaultIntegrations: false }).options.dsn, sink.dsn);
  } finally {
    delete process.env.NEXT_PUBLIC_FIXWIRE_DSN;
  }
  await Fixwire.captureRequestError(
    Object.assign(new Error("proxy failed"), { digest: "99" }),
    { path: "/admin/settings?x=1", method: "POST", headers: { cookie: "sid=1" } },
    { routerKind: "App Router", routePath: "/admin/[[...slug]]", routeType: "proxy" },
  );
  const [event] = sink.events(); // no waiting: captureRequestError flushed
  const a = event?.attributes ?? {};
  assert.equal(a["fixwire.transaction"], "/admin/[[...slug]]");
  assert.equal(a["url.full"], "/admin/settings");
  assert.equal(a["url.query"], "x=1");
  assert.equal(a["fixwire.tags"]["nextjs.route_type"], "proxy");
  assert.equal(a["fixwire.contexts"].nextjs.digest, "99");
  assert.equal(thrown(event as Record<string, never>).mechanism.type, "nextjs.request");
  await Fixwire.close();
  sink.server.close();
});
