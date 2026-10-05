import assert from "node:assert/strict";
import { test } from "node:test";

import { withIsolationScope } from "../src/scope.ts";
import {
  continueTrace,
  getActiveSpan,
  getTraceData,
  getTraceMetaTags,
  MAX_SPANS_PER_SEGMENT,
  propagationFromHeaders,
  sample,
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
    "telemetry.sdk.version": "0.1.0",
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
});
