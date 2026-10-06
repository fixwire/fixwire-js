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

test("templates take linear time on hostile messages", () => {
  const started = performance.now();
  // "@@@…" took cubic time: a minute at 4,096 characters.
  for (const text of ["@", "a@", "a@b.", "1.", "0x", "a"])
    template(text.repeat(Math.ceil(65_536 / text.length)));
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
  assert.equal(
    template("user 42 is ada@example.com\nid=7 mail=bob@ex.org"),
    "user <*> is <*>\nid=<*> <*>",
  );
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
  // A 429 pauses everything for Retry-After (a minute at least), then goes again.
  d.offer(request("busy"));
  assert.ok(d.onResponse(take(0), 429, (n) => (n === "retry-after" ? "30" : null), 0).retry);
  assert.equal(d.next(59), undefined);
  assert.equal(d.next(60)?.body, "busy");
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

test("a request is sent 4 times at most, about 1 s, 2 s and 4 s apart", () => {
  const d = new Delivery(100, 8 << 20, () => 1); // no jitter: the full backoff
  d.offer(request("x"));
  const waits: number[] = [];
  let now = 0;
  for (let sends = 1; ; sends++) {
    const item = d.next(now) as Outbound;
    const dec = d.onResponse(item, 502, () => null, now);
    if (dec.dropped) {
      assert.equal(sends, MAX_ATTEMPTS);
      break;
    }
    waits.push((d.wakeAt() as number) - now);
    now = d.wakeAt() as number;
  }
  assert.deepEqual(waits, [1, 2, 4]);
  // A 429's pause counts as a send too.
  d.offer(request("busy"));
  now = 1000;
  const busy = (n: string) => (n === "retry-after" ? "1" : null);
  for (let sends = 1; sends < MAX_ATTEMPTS; sends++) {
    assert.ok(d.onResponse(d.next(now) as Outbound, 429, busy, now).retry);
    now = d.wakeAt() as number;
  }
  assert.ok(d.onResponse(d.next(now) as Outbound, 429, busy, now).dropped);
});

test("a server can pause delivery for a day at most, and a request waits 5 minutes at most", () => {
  // Past 24.8 days a timer fires at once: a huge pause was a busy loop.
  const d = new Delivery(100, 8 << 20, () => 0);
  const header = (retryAfter: string | null, limits: string | null) => (n: string) =>
    n === "retry-after" ? retryAfter : n === "fixwire-rate-limits" ? limits : null;
  // 86,401 s is a day; the request would wait that long: it is dropped.
  d.offer(request("busy"));
  const dec = d.onResponse(d.next(0) as Outbound, 429, header("86401", null), 0);
  assert.ok(dec.dropped, dec.reason);
  assert.equal(d.limits[""], 86_400);
  // Requests queued meanwhile would wait past 5 minutes too: dropped, not kept.
  d.offer(request("later"));
  assert.equal(d.next(10), undefined);
  assert.equal(d.queue.length, 0);

  // A 5xx with Retry-After pauses everything for that long; an HTTP date counts from now.
  const e = new Delivery(100, 8 << 20, () => 0);
  const now = Date.parse("2026-10-06T10:00:00Z") / 1000;
  e.offer(request("x"));
  assert.ok(
    e.onResponse(e.next(now) as Outbound, 503, header("Tue, 06 Oct 2026 10:02:00 GMT", null), now)
      .retry,
  );
  assert.equal(e.limits[""], now + 120);
  assert.equal(e.wakeAt(), now + 120);
  // Broken values are ignored: no pause, the backoff alone.
  const f = new Delivery(100, 8 << 20, () => 0);
  f.offer(request("z"));
  assert.ok(f.onResponse(f.next(0) as Outbound, 503, header("1e12", "soon:error"), 0).retry);
  assert.deepEqual(f.limits, {});
  assert.equal(f.wakeAt(), 0.5);
  // Fixwire-Rate-Limits: a day at most, and only the protocol's categories.
  assert.deepEqual(
    parseRateLimits("99999999:error, 1e300:log, -60:span, x:file, 60:metric;session", 0),
    {
      error: 86_400,
      session: 60,
    },
  );
});

test("at most maxQueue requests wait to be sent, and as many for a retry", () => {
  const d = new Delivery(2, 8 << 20, () => 0);
  assert.ok(d.offer(request("a")) && d.offer(request("b")));
  assert.equal(d.offer(request("c")), false); // new data is dropped, the queued kept
  assert.deepEqual(
    d.queue.map((i) => i.body),
    ["a", "b"],
  );
  const a = d.next(0) as Outbound;
  const b = d.next(0) as Outbound;
  assert.ok(d.offer(request("c")) && d.offer(request("e")));
  assert.ok(d.onError(a, 0).retry && d.onError(b, 0).retry);
  const c = d.next(0) as Outbound;
  assert.ok(d.offer(request("f")));
  assert.ok(d.onError(c, 0).dropped); // two wait for a retry already
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

test("a message's lines are not read as frames", () => {
  // Input in a message must not fake a frame (a file to read context lines from).
  const err = new Error("bad input:\n    at evil (/dev/zero:1:1)\n    at more (/etc/passwd:2:2)");
  const [ex] = exceptionsFromError(parser, err, { type: "generic" });
  const files = (ex?.stacktrace?.frames ?? []).map((f) => f.filename);
  assert.ok(files.length > 0);
  assert.ok(!files.includes("/dev/zero") && !files.includes("/etc/passwd"), String(files));
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

test("normalize stays bounded on shared references, buffers and hostile objects", () => {
  // Each level refers to the next ten times: 10^9 paths, walked to a budget.
  let shared: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 9; i++)
    shared = Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`k${k}`, shared]));
  const bytes = new Uint8Array(20_000_000).fill(7);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const started = performance.now();
  const json = JSON.stringify(normalize(shared));
  const out = normalize({ bytes, revoked: revoked.proxy }) as Record<string, unknown>;
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
  assert.ok(json.length < 2_000_000 && json.includes('"[Object]"'), `${json.length} characters`);
  assert.deepEqual(Object.keys(out.bytes as object).length, 100);
  assert.equal((out.bytes as Record<string, number>)["99"], 7);
  assert.equal(out.revoked, "[Unreadable]");
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
