import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentScope, withIsolationScope } from "../src/scope.ts";
import {
  continueTrace,
  getActiveSpan,
  getTraceData,
  getTraceMetaTags,
  MAX_SPANS_PER_SEGMENT,
  propagationFromHeaders,
  sample,
  setRouteName,
  shouldPropagate,
  startInactiveSpan,
  startSpan,
  traceHeaders,
} from "../src/tracing.ts";

import { fakeClient, type Json, recordsOf, spansOf } from "./helpers.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const PARENT = "b7ad6b7169203331";
/** TRACE's random part: its last 56 bits as a fraction (about 0.28). */
const RAND = Number.parseInt(TRACE.slice(18), 16) / 2 ** 56;

test("incoming trace headers: traceparent, with tracestate and baggage kept to pass on", () => {
  const a = propagationFromHeaders({
    traceparent: `00-${TRACE}-${PARENT}-01`,
    tracestate: "ot=th:8;rv:48eb211c80319c,vendor=x",
    baggage: "userId=alice",
  });
  assert.deepEqual(
    [a.traceId, a.parentSpanId, a.sampled, a.sampleRand, a.continued],
    [TRACE, PARENT, true, RAND, true],
  );
  assert.equal(a.tracestate, "ot=th:8;rv:48eb211c80319c,vendor=x");
  assert.equal(a.baggage, "userId=alice");

  const b = propagationFromHeaders(new Headers({ traceparent: `00-${TRACE}-${PARENT}-00` }));
  assert.deepEqual(
    [b.traceId, b.parentSpanId, b.sampled, b.continued],
    [TRACE, PARENT, false, true],
  );

  for (const traceparent of [
    `00-${"0".repeat(32)}-${PARENT}-01`,
    `00-${TRACE}-${"0".repeat(16)}-01`,
    "garbage",
  ]) {
    const c = propagationFromHeaders({ traceparent, tracestate: "vendor=x" });
    assert.equal(c.continued, false);
    assert.equal(c.tracestate, undefined);
    assert.equal(c.traceId.length, 32);
    // A new trace decides from its own id.
    assert.equal(c.sampleRand, Number.parseInt(c.traceId.slice(18), 16) / 2 ** 56);
  }
});

test("a caller's oversized tracestate and baggage, or with a control character, are not passed on", () => {
  // Passed on, they could oversize the app's own requests, or split them.
  for (const [tracestate, baggage] of [
    ["k=v".padEnd(513, "x"), "k=v".padEnd(8193, "x")],
    // Bytes, not characters: "é" is two.
    ["k=é".padEnd(512, "x"), "k=é".padEnd(8192, "x")],
    ["k=v\r\nInjected: 1", "k=v\nInjected: 1"],
    ["k=v\0", "k=v\x7f"],
  ]) {
    const ctx = propagationFromHeaders({
      traceparent: `00-${TRACE}-${PARENT}-01`,
      tracestate,
      baggage,
    });
    assert.ok(ctx.continued);
    assert.equal(ctx.tracestate, undefined);
    assert.equal(ctx.baggage, undefined);
  }
  // At the limits they go on whole, tabs (W3C's list whitespace) and all.
  const tracestate = "fw=1,\tk=é".padEnd(511, "a");
  const baggage = "k=v,\tu=é".padEnd(8191, "b");
  const ctx = propagationFromHeaders({
    traceparent: `00-${TRACE}-${PARENT}-01`,
    tracestate,
    baggage,
  });
  assert.equal(ctx.tracestate, tracestate);
  assert.equal(ctx.baggage, baggage);
  assert.equal(traceHeaders().tracestate, undefined); // not this scope's trace
});

test("only a well-formed traceparent is continued", () => {
  assert.ok(propagationFromHeaders({ traceparent: ` 00-${TRACE}-${PARENT}-01\t` }).continued);
  for (const bad of [
    `01-${TRACE}-${PARENT}-01`,
    `00-${TRACE}-${PARENT}-01-extra`,
    `00-${TRACE.toUpperCase()}-${PARENT}-01`,
    `00-${TRACE}-${PARENT}-0g`,
    `00-${"0".repeat(32)}-${PARENT}-01`,
    `00-${TRACE}-${"0".repeat(16)}-01`,
    `00-${TRACE}-${PARENT}-01\n`,
  ])
    assert.equal(propagationFromHeaders({ traceparent: bad }).continued, false, bad);
});

test("sampling: the sampler first, then the caller's decision, then the rate against the trace id", () => {
  const ctx = propagationFromHeaders({ traceparent: `00-${TRACE}-${PARENT}-00` });
  assert.equal(sample({ tracesSampleRate: 1 }, ctx, "x", {}), false);
  assert.equal(sample({ tracesSampler: () => 0.9 }, ctx, "x", {}), true);
  assert.equal(
    sample(
      { tracesSampler: (c) => (c.parentSampled ? 1 : undefined), tracesSampleRate: 1 },
      ctx,
      "x",
      {},
    ),
    false,
  );
  // A root keeps the trace when its random part is at least 1 - rate.
  const root = { ...ctx, sampled: undefined, continued: false };
  assert.equal(sample({ tracesSampleRate: 1 - RAND - 0.01 }, root, "x", {}), false);
  assert.equal(sample({ tracesSampleRate: 1 - RAND + 0.01 }, root, "x", {}), true);
  assert.equal(sample({ tracesSampleRate: 0 }, root, "x", {}), false);
  assert.equal(sample({ tracesSampleRate: 1 }, root, "x", {}), true);
  assert.equal(sample({}, root, "x", {}), false);
});

test("spans nest, end with their callbacks and fail with them", async () => {
  fakeClient({});
  const seen: string[] = [];
  const result = await startSpan({ name: "checkout", op: "task" }, async (seg) => {
    assert.equal(getActiveSpan(), seg);
    startSpan({ name: "inner", op: "db.query" }, (child) => {
      assert.equal(child.parentSpanId, seg.spanId);
      assert.equal(child.traceId, seg.traceId);
      assert.equal(child.segment, seg);
      seen.push(child.name);
    });
    await assert.rejects(
      startSpan({ name: "charge" }, async (failing) => {
        seen.push(failing.name);
        await Promise.resolve();
        throw new Error("declined");
      }),
    );
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(seen, ["inner", "charge"]);
  assert.equal(getActiveSpan(), undefined);
  assert.throws(() =>
    startSpan({ name: "sync" }, () => {
      throw new Error("boom");
    }),
  );
});

test("a sampled segment is sent as one OTLP export on /v1/traces, redacted", async () => {
  const { client, sent } = fakeClient({
    tracesSampleRate: 1,
    release: "api@1.0.0",
    environment: "test",
  });
  let failedId = "";
  startSpan(
    { name: "checkout", op: "task", attributes: { "cart.items": 3, ratio: 0.5, paid: true } },
    () => {
      startSpan(
        { name: "SELECT * FROM users WHERE email = 'ada@example.com'", op: "db.query" },
        () => {},
      );
      try {
        startSpan(
          { name: "POST /charge", op: "http.client", attributes: { password: "hunter2" } },
          (s) => {
            failedId = s.spanId;
            throw new Error("declined");
          },
        );
      } catch {
        // the span is marked failed
      }
    },
  );
  assert.ok(await client.flush(2000));
  const exports = sent.filter((r) => r.url === "http://127.0.0.1:1/v1/traces");
  assert.equal(exports.length, 1);
  assert.equal(exports[0]?.headers.Authorization, "Bearer pk");
  const spans = spansOf(sent);
  assert.equal(spans.length, 3);
  const [seg, db, charge] = spans as [Json, Json, Json];
  assert.deepEqual(seg.resource, {
    "service.version": "api@1.0.0",
    "deployment.environment.name": "test",
    "telemetry.sdk.name": "fixwire.javascript.test",
    "telemetry.sdk.version": "0.2.0",
    "telemetry.sdk.language": "nodejs",
  });
  assert.equal(seg.parentSpanId, undefined);
  assert.equal(seg.flags, 0x101, "no parent: a local root, sampled");
  assert.equal(seg.kind, 1);
  assert.deepEqual(seg.status, { code: 1 });
  assert.match(seg.startTimeUnixNano, /^\d{19}$/);
  assert.ok(BigInt(seg.endTimeUnixNano) >= BigInt(seg.startTimeUnixNano));
  // Only the span's own attributes and the operation: release, environment
  // and SDK are the resource's.
  assert.deepEqual(seg.attributes, {
    "cart.items": 3,
    ratio: 0.5,
    paid: true,
    "fixwire.op": "task",
    "fixwire.origin": "manual",
  });
  assert.equal(db.parentSpanId, seg.spanId);
  assert.equal(db.flags, 0x101, "a local parent");
  assert.equal(db.kind, 3, "a database call is a client span");
  assert.ok(!String(db.name).includes("ada@example.com"), db.name);
  assert.equal(charge.spanId, failedId);
  assert.deepEqual(charge.status, { code: 2 });
  assert.equal(charge.attributes.password, "[Filtered]");
  // OTLP's typed values: 64-bit integers as strings.
  const typed = JSON.stringify(
    (JSON.parse(String(exports[0]?.body)) as Json).resourceSpans[0].scopeSpans[0].spans[0]
      .attributes,
  );
  assert.match(typed, /"key":"cart\.items","value":\{"intValue":"3"\}/);
  assert.match(typed, /"key":"ratio","value":\{"doubleValue":0\.5\}/);
});

test("a segment continuing a caller's trace has a remote parent", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 0 });
  withIsolationScope(() => {
    continueTrace({ traceparent: `00-${TRACE}-${PARENT}-01` });
    startSpan({ name: "GET /orders", op: "http.server" }, () => {});
  });
  assert.ok(await client.flush(2000));
  const [seg] = spansOf(sent) as [Json];
  assert.equal(seg.traceId, TRACE);
  assert.equal(seg.parentSpanId, PARENT);
  assert.equal(seg.flags, 0x301, "the caller sampled it; its parent is remote");
  assert.equal(seg.kind, 2);
});

test("unsampled segments send nothing; a full segment drops and counts", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 0 });
  startSpan({ name: "quiet" }, () => {
    startSpan({ name: "child" }, () => {});
  });
  assert.ok(await client.flush(2000));
  assert.equal(sent.length, 0);

  fakeClient({ tracesSampleRate: 1 });
  const seg = startInactiveSpan({ name: "big" });
  for (let i = 0; i < MAX_SPANS_PER_SEGMENT + 5; i++)
    startInactiveSpan({ name: `c${i}`, forceSegment: false }).end();
  assert.equal(seg.droppedSpans, 0); // not active: those were segments of their own
  startSpan({ name: "big2" }, (s) => {
    for (let i = 0; i < MAX_SPANS_PER_SEGMENT + 5; i++) startInactiveSpan({ name: `c${i}` }).end();
    assert.equal(s.spans().length, MAX_SPANS_PER_SEGMENT + 1);
    assert.equal(s.droppedSpans, 5);
  });
  seg.end();
});

test("errors carry the active span, else the continued trace", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  let ownSpan = "";
  withIsolationScope(() => {
    const ctx = continueTrace({ traceparent: `00-${TRACE}-${PARENT}-01` });
    ownSpan = ctx.spanId;
    client.captureMessage("outside a span");
    startSpan({ name: "job", op: "task" }, (s) => {
      client.captureMessage("inside a span");
      assert.equal(s.traceId, TRACE);
      assert.equal(s.parentSpanId, PARENT);
    });
  });
  assert.ok(await client.flush(2000));
  const records = recordsOf(sent);
  const outside = records.find((r) => r.body === "outside a span") as Json;
  const inside = records.find((r) => r.body === "inside a span") as Json;
  assert.equal(outside.traceId, TRACE);
  assert.equal(outside.spanId, ownSpan);
  assert.equal(outside.attributes["fixwire.transaction"], undefined);
  assert.equal(inside.traceId, TRACE);
  assert.equal(inside.attributes["fixwire.transaction"], "job");
});

test("setRouteName names the request's segment and the errors after it", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  withIsolationScope(() => {
    const request = startInactiveSpan({
      name: "GET /users/42",
      op: "http.server",
      forceSegment: true,
      attributes: { "http.request.method": "GET" },
    });
    getCurrentScope().span = request;
    setRouteName("/users/:id");
    client.captureMessage("in the route");
    request.end();
  });
  withIsolationScope(() => {
    startSpan({ name: "/orders/7", op: "navigation", forceSegment: true }, () => {
      setRouteName("/orders/[id]");
      client.captureMessage("on the page");
    });
    setRouteName("");
  });
  assert.ok(await client.flush(2000));
  const records = recordsOf(sent);
  const inRoute = records.find((r) => r.body === "in the route") as Json;
  const onPage = records.find((r) => r.body === "on the page") as Json;
  assert.equal(inRoute.attributes["fixwire.transaction"], "/users/:id");
  assert.equal(onPage.attributes["fixwire.transaction"], "/orders/[id]");
  const segments = spansOf(sent).filter((s) => !s.parentSpanId);
  const request = segments.find((s) => s.attributes["http.route"] === "/users/:id") as Json;
  const page = segments.find((s) => s.attributes["http.route"] === "/orders/[id]") as Json;
  assert.equal(request.name, "GET /users/:id");
  assert.equal(page.name, "/orders/[id]");
});

test("trace headers follow the active span and pass the caller's tracestate and baggage on", () => {
  fakeClient({
    tracesSampleRate: 1,
    release: "api@1",
    tracePropagationTargets: ["api.internal", /^https:\/\/pay\./],
  });
  startSpan({ name: "outgoing" }, (s) => {
    assert.deepEqual(traceHeaders(), { traceparent: `00-${s.traceId}-${s.spanId}-01` });
  });
  withIsolationScope(() => {
    continueTrace({
      traceparent: `00-${TRACE}-${PARENT}-01`,
      tracestate: "vendor=x",
      baggage: "userId=alice",
    });
    startSpan({ name: "continued" }, (s) => {
      assert.deepEqual(traceHeaders(), {
        traceparent: `00-${TRACE}-${s.spanId}-01`,
        tracestate: "vendor=x",
        baggage: "userId=alice",
      });
      assert.deepEqual(getTraceData(), {
        traceparent: `00-${TRACE}-${s.spanId}-01`,
        tracestate: "vendor=x",
      });
      assert.equal(
        getTraceMetaTags(),
        `<meta name="traceparent" content="00-${TRACE}-${s.spanId}-01"/>\n<meta name="tracestate" content="vendor=x"/>`,
      );
    });
  });
  assert.ok(shouldPropagate("https://api.internal/orders"));
  assert.ok(shouldPropagate("https://pay.example/charge"));
  assert.ok(!shouldPropagate("https://evil.example/?u=https://pay.example"));
  fakeClient({});
  assert.ok(!shouldPropagate("https://api.internal/orders")); // no targets, no browser origin
  // In a browser, by default: the page's own origin, and paths (not "//host" or "/\host").
  const g = globalThis as { location?: unknown };
  g.location = { origin: "https://shop.example" };
  try {
    assert.ok(shouldPropagate("https://shop.example/api") && shouldPropagate("/api"));
    for (const other of ["//evil.example/x", "/\\evil.example/x", "https://shop.example.evil/x"])
      assert.ok(!shouldPropagate(other), other);
  } finally {
    delete g.location;
  }
});

test("tracePropagationTargets: URL prefixes, hosts with their subdomains, paths and patterns", () => {
  fakeClient({
    tracePropagationTargets: [
      "example.com",
      "internal.test:8443",
      "https://api.partner.io/v2",
      "/same-origin",
      "[::1]:8080",
      /\/graphql$/,
    ],
  });
  for (const [url, want] of [
    ["https://example.com/x", true],
    ["https://API.Example.COM/x", true],
    ["http://example.com:8080/x", true],
    ["https://badexample.com/x", false],
    ["https://example.com.evil.net/x", false],
    ["https://evil.net/?next=example.com", false],
    ["https://evil.net/#example.com", false],
    ["https://example.com@evil.net/", false],
    ["https://internal.test:8443/", true],
    ["https://svc.internal.test:8443/", true],
    ["https://internal.test/", false],
    ["https://internal.test:9000/", false],
    ["https://api.partner.io/v2/orders?id=1", true],
    ["https://user:pw@api.partner.io/v2/x", true],
    ["https://api.partner.io/v1/orders", false],
    ["https://evil.net/https://api.partner.io/v2", false],
    ["https://evil.net/same-origin", false],
    ["/same-origin/x", false], // no page: nothing is same-origin
    ["http://[::1]:8080/", true],
    ["https://evil.net/graphql", true],
    ["https://evil.net/x?q=/graphql", false], // the query isn't compared
    ["not a url", false],
  ] as const)
    assert.equal(shouldPropagate(url), want, url);
  // In a browser, a path is a prefix of the page's own origin's paths.
  const g = globalThis as { location?: unknown };
  g.location = { origin: "https://shop.example" };
  try {
    assert.ok(shouldPropagate("/same-origin/x"));
    assert.ok(shouldPropagate("https://shop.example/same-origin"));
    assert.ok(!shouldPropagate("https://other.example/same-origin"));
    assert.ok(!shouldPropagate("/other"));
  } finally {
    delete g.location;
  }
});
