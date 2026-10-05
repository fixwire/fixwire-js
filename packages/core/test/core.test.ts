import assert from "node:assert/strict";
import { test } from "node:test";

import { type Integration, resolveIntegrations } from "../src/client.ts";
import { Delivery, MAX_ATTEMPTS, type Outbound, parseRateLimits } from "../src/delivery.ts";
import { exceptionsFromError } from "../src/eventbuilder.ts";
import { fingerprint, Limiter, template } from "../src/limiter.ts";
import { nodeStackLineParser } from "../src/node-stack-trace.ts";
import { applyScopes, Scope, stackStrategy } from "../src/scope.ts";
import { normalize } from "../src/serialize.ts";
import { createStackParser } from "../src/stacktrace.ts";

const parser = createStackParser(nodeStackLineParser());

test("budgets count what they suppress", () => {
  const lim = new Limiter({ perIssueBurst: 3, perIssuePerMinute: 1 }, 600);
  const results = Array.from({ length: 10 }, (_, i) => lim.allow("fp", 1000 + i * 0.01)[0]);
  assert.deepEqual(results, [true, true, true, ...Array(7).fill(false)]);
  const [ok, suppressed] = lim.allow("fp", 1061);
  assert.ok(ok);
  assert.equal(suppressed?.count, 7);
  assert.ok(lim.allow("other", 1061)[0]);
});

test("fingerprints ignore lines, numbers and bundle hashes", () => {
  const ev = (line: number, value: string, file: string) => ({
    exception: {
      values: [
        {
          type: "TypeError",
          value,
          stacktrace: {
            frames: [{ filename: file, function: "charge", lineno: line, in_app: true }],
          },
        },
      ],
    },
  });
  assert.equal(
    fingerprint(ev(10, "amount 500", "https://a.com/assets/app-3f9a2c1d.js")),
    fingerprint(ev(42, "amount 7", "https://b.com/assets/app-77aa88bb.js?v=2")),
  );
  assert.equal(template("order 123 for a@b.io"), "order <*> for <*>");
});

const request = (body: string, category = "error"): Outbound => ({
  path: "/v1/logs",
  contentType: "application/json",
  body,
  category,
  attempts: 0,
  notBefore: 0,
});

test("delivery retries with backoff, honours Retry-After and pauses rate-limited kinds", () => {
  const d = new Delivery(64, 8 << 20, () => 0);
  d.offer(request("x"));
  const sent = d.next(0);
  assert.ok(sent && d.onError(sent, 0).retry);
  assert.equal(d.next(0.1), undefined);
  assert.equal(d.wakeAt(), 0.5);
  const take = (now: number) => {
    const item = d.next(now);
    assert.ok(item);
    return item;
  };
  let dec: ReturnType<Delivery["onResponse"]> | undefined;
  for (let a = 1; a < MAX_ATTEMPTS; a++) {
    const now = 1000 * a;
    dec = d.onResponse(take(now), 503, () => null, now);
  }
  assert.ok(dec?.dropped);
  // Other 4xx answers drop the request at once.
  d.offer(request("bad"));
  assert.ok(d.onResponse(take(0), 400, () => null, 0).dropped);
  assert.equal(d.queue.length, 0);
  // A 429 waits out Retry-After, then goes again.
  d.offer(request("busy"));
  assert.ok(d.onResponse(take(0), 429, (n) => (n === "retry-after" ? "30" : null), 0).retry);
  assert.equal(d.next(29), undefined);
  assert.equal(d.next(30)?.body, "busy");
  // Fixwire-Rate-Limits pauses its kinds; the rest keeps flowing.
  d.offer(request("z"));
  const limits = (n: string) => (n === "fixwire-rate-limits" ? "60:error;log" : null);
  assert.ok(d.onResponse(take(100), 200, limits, 100).sent);
  d.offer(request("w"));
  d.offer(request("s", "span"));
  assert.equal(d.next(110)?.body, "s");
  assert.equal(d.next(110), undefined);
  assert.equal(d.wakeAt(), 160);
  assert.equal(d.next(160)?.body, "w");
  assert.deepEqual(parseRateLimits("60:error;span, 10:, bad", 100), {
    error: 160,
    span: 160,
    "": 110,
  });
});

test("errors with causes and AggregateErrors", () => {
  const root = new TypeError("socket closed");
  const err = new Error("charge failed", { cause: root });
  const values = exceptionsFromError(parser, err, { type: "generic", handled: true });
  assert.deepEqual(
    values.map((v) => v.type),
    ["TypeError", "Error"],
  );
  assert.equal(values[0]?.mechanism?.source, "cause");
  assert.equal(values[1]?.mechanism?.exception_id, 0);
  const frames = values[1]?.stacktrace?.frames ?? [];
  assert.equal(frames.at(-1)?.function, "TestContext.?");
  assert.ok(frames.at(-1)?.filename?.endsWith("core.test.ts"));

  const group = new AggregateError([new RangeError("a"), new SyntaxError("b")], "batch");
  const g = exceptionsFromError(parser, group, { type: "generic" });
  assert.deepEqual(g.map((v) => v.type).sort(), ["AggregateError", "RangeError", "SyntaxError"]);
  assert.ok(g.find((v) => v.type === "AggregateError")?.mechanism?.is_exception_group);
});

test("scope layers and the browser stack strategy", async () => {
  const acs = stackStrategy();
  acs.getIsolationScope().setTag("app", "web");
  await acs.withIsolationScope(async (iso) => {
    iso.setTag("request", "r1");
    await Promise.resolve();
    assert.equal(acs.getIsolationScope().tags.request, "r1");
  });
  assert.equal(acs.getIsolationScope().tags.request, undefined);
  const s = new Scope();
  s.maxBreadcrumbs = 2;
  for (const m of ["a", "b", "c"]) s.addBreadcrumb({ message: m });
  assert.deepEqual(
    s.breadcrumbs.map((b) => b.message),
    ["b", "c"],
  );
  const event = { tags: { own: "x" } };
  applyScopes(event, 100);
  assert.equal(event.tags.own, "x");
});

test("normalize bounds and describes values", () => {
  const cyclic: Record<string, unknown> = { n: 1n, f() {}, d: new Date(0), s: "x".repeat(50) };
  cyclic.self = cyclic;
  assert.deepEqual(normalize(cyclic, 10), {
    n: "1n",
    f: "[Function: f]",
    d: "1970-01-01T00:00:00.000Z",
    s: "xxxxxxx...",
    self: "[Circular ~]",
  });
});

test("a custom integration replaces the default of the same name", () => {
  const make = (name: string, tag: string): Integration & { tag: string } => ({
    name,
    tag,
    setup() {},
  });
  const resolved = resolveIntegrations(
    [make("GlobalHandlers", "default"), make("Breadcrumbs", "default")],
    [make("Breadcrumbs", "custom"), make("Audit", "custom")],
  ) as (Integration & { tag: string })[];
  assert.deepEqual(
    resolved.map((i) => `${i.name}:${i.tag}`),
    ["GlobalHandlers:default", "Breadcrumbs:custom", "Audit:custom"],
  );
});
