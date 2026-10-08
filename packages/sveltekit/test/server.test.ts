import assert from "node:assert/strict";
import { test } from "node:test";

import { ingest } from "../../../examples/test/ingest.ts";
import { thrown } from "../../core/test/helpers.ts";
import * as Fixwire from "../src/index.ts";

const event = (route: string | null) => ({
  route: { id: route },
  url: new URL("http://localhost/users/42"),
  request: new Request("http://localhost/users/42"),
});

test("handleError: SvelteKit 3's unknown errors and SvelteKit 2's 5xx, named after the route", async () => {
  const sink = await ingest();
  process.env.PUBLIC_FIXWIRE_DSN = sink.dsn;
  try {
    assert.equal(Fixwire.init({ defaultIntegrations: false }).options.dsn, sink.dsn);
  } finally {
    delete process.env.PUBLIC_FIXWIRE_DSN;
  }
  const seen: string[] = [];
  const handleError = Fixwire.handleErrorWithFixwire(({ error }: Fixwire.HandleErrorInput) => {
    seen.push((error as Error).message);
    return { message: "Sorry, that broke" };
  });
  const bug = new Error("the user service is unavailable");
  assert.deepEqual(handleError({ kind: "unknown", error: bug, event: event("/users/[id]") }), {
    message: "Sorry, that broke",
  });
  handleError({ kind: "app", error: new Error("thrown with error(500)"), event: event("/") });
  handleError({ kind: "framework", error: new Error("Not found: /nope"), event: event(null) });
  handleError({ kind: "validation", error: new Error("bad input"), event: event("/"), issues: [] });
  handleError({
    error: new Error("v2: a 404"),
    event: event(null),
    status: 404,
    message: "Not Found",
  });
  handleError({
    error: new Error("v2: a bug"),
    event: event("/v2/[slug]"),
    status: 500,
    message: "Internal Error",
  });
  assert.equal(seen.length, 6, "your handler sees every error");
  // Without a handler, SvelteKit keeps its defaults.
  assert.equal(
    Fixwire.handleErrorWithFixwire()({ kind: "framework", error: null, event: event(null) }),
    undefined,
  );

  await Fixwire.flush();
  const got = sink.events().map((e) => [thrown(e).message, e.attributes["fixwire.transaction"]]);
  assert.deepEqual(got, [
    ["the user service is unavailable", "/users/[id]"],
    ["v2: a bug", "/v2/[slug]"],
  ]);
  assert.equal(sink.events()[0]?.attributes["fixwire.tags"]["sveltekit.kind"], "unknown");
  assert.equal(
    thrown(sink.events()[0] as Record<string, never>).mechanism.type,
    "sveltekit.server",
  );
  await Fixwire.close();
  sink.server.close();
});

test("fixwireHandle names the request after its route and the page's head after it too", async () => {
  const handle = Fixwire.fixwireHandle();
  const e = event("/users/[id]");
  let transform: ((input: { html: string; done: boolean }) => unknown) | undefined;
  const response = await handle({
    event: e,
    resolve: async (got, options) => {
      transform = options?.transformPageChunk;
      return new Response(got === e ? "same" : "other");
    },
  });
  assert.equal(await response.text(), "same");
  assert.equal(Fixwire.getIsolationScope().transactionName, "/users/[id]");
  const head = await transform?.({
    html: "<html><head><title>Shop</title></head><body>",
    done: false,
  });
  // The request's trace, for the browser to continue, and the route.
  assert.match(
    String(head),
    /^<html><head><title>Shop<\/title><meta name="traceparent" content="00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]"\/><meta name="fixwire-route" content="\/users\/\[id\]"\/><\/head><body>$/,
  );
  assert.equal(
    await transform?.({ html: "</head> in a later chunk", done: true }),
    "</head> in a later chunk",
  );
  // A route id is escaped as an attribute.
  let escaped: unknown;
  await handle({
    event: event('/a/"<b>"'),
    resolve: async (_got, options) => {
      escaped = await options?.transformPageChunk?.({ html: "</head>", done: true });
      return new Response("");
    },
  });
  assert.ok(
    String(escaped).endsWith(
      '<meta name="fixwire-route" content="/a/&#34;&#60;b&#62;&#34;"/></head>',
    ),
  );
});
