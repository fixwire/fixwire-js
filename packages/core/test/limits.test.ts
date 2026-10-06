// What every Fixwire SDK guarantees (sdks/PROTOCOL.md §13): the bounds on
// what is sent, and that capturing never gets in the app's way.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ai } from "../src/ai.ts";
import { getClient } from "../src/api.ts";
import { fingerprint } from "../src/limiter.ts";
import { Scope, withIsolationScope } from "../src/scope.ts";
import { clip } from "../src/serialize.ts";
import type { SessionAggregates } from "../src/sessions.ts";
import { MAX_ATTRIBUTES, startInactiveSpan, startSpan } from "../src/tracing.ts";
import { bodiesOf, fakeClient, type Json, recordsOf, spansOf, thrown } from "./helpers.ts";

const bytes = (s: string): number => new TextEncoder().encode(s).length;
const BEGIN = "-----BEGIN "; // split, so no scanner sees a whole key
const KEY = `${BEGIN}RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA".repeat(20)}\n-----END RSA PRIVATE KEY-----`;

test("strings are cut to maxValueLength bytes of UTF-8, on a character boundary, ending in ...", () => {
  assert.equal(clip("é".repeat(512), 1024), "é".repeat(512)); // 1,024 bytes: kept
  const cut = clip(`${"é".repeat(512)}a`, 1024); // 1,025 bytes
  assert.equal(cut, `${"é".repeat(510)}...`);
  assert.ok(bytes(cut) <= 1024);
  // Never inside a character: a surrogate pair is one 4-byte character.
  assert.equal(clip("😀".repeat(256), 1024), "😀".repeat(256));
  assert.equal(clip(`${"😀".repeat(256)}a`, 1024), `${"😀".repeat(255)}...`);
  assert.equal(clip("abcdef", 5), "ab...");
  assert.equal(clip("abcdef", 2), "..");
  assert.equal(clip("abcdef", 0), "abcdef"); // no limit
});

test("every string sent is cut after redaction, which reads the part kept and the next 16 kB", async () => {
  const { client, sent } = fakeClient({ release: "api@1" });
  // The cut goes through a private key: masked whole, none of it is sent.
  client.captureMessage(`${"a".repeat(1010)} ${KEY}`);
  client.captureMessage(`${"é".repeat(600)}`);
  withIsolationScope((scope) => {
    scope.setContext("order", { note: `${"b".repeat(1010)} ${KEY}`, [`${"k".repeat(2000)}`]: 1 });
    scope.addBreadcrumb({ message: `${"c".repeat(1015)} ${KEY}` });
    client.captureException(new Error(`${"d".repeat(1000)} ${KEY}`));
  });
  assert.ok(await client.flush(2000));
  const [key, accents, error] = recordsOf(sent) as [Json, Json, Json];
  assert.equal(key.body, `${"a".repeat(1010)} [REDACTED:...`);
  assert.equal(accents.body, `${"é".repeat(510)}...`);
  const json = JSON.stringify(error);
  assert.ok(!json.includes("MIIE"), "a part of the key was sent");
  assert.ok(bytes(thrown(error).message) <= 1024);
  const order = error.attributes["fixwire.contexts"].order as Json;
  assert.equal(order.note, `${"b".repeat(1010)} [REDACTED:...`);
  assert.ok(Object.keys(order).every((k) => bytes(k) <= 1024)); // keys too
  const crumb = (error.attributes["fixwire.breadcrumbs"] as Json[]).at(-1) as Json;
  assert.equal(crumb.message, `${"c".repeat(1015)} [REDA...`);
});

test("maxValueLength is the option's, and AI content gets 16 kB, masked before the cut", async () => {
  const { client, sent } = fakeClient({ maxValueLength: 100, tracesSampleRate: 1 });
  client.captureMessage("x".repeat(500));
  ai.tool(
    { name: "lookup", recordContent: true, arguments: { q: `${"y".repeat(16_350)} ${KEY}` } },
    (call) => {
      call.setResult("z".repeat(20_000));
      call.span.setAttribute("note", "n".repeat(500));
    },
  );
  assert.ok(await client.flush(2000));
  assert.equal(recordsOf(sent)[0]?.body, `${"x".repeat(97)}...`);
  const span = spansOf(sent).find((s) => s.name === "execute_tool lookup") as Json;
  const args = span.attributes["gen_ai.tool.call.arguments"] as string;
  assert.ok(args.startsWith(`{"q":"${"y".repeat(16_350)} [REDACTED:`), args.slice(16_350));
  assert.ok(!args.includes("MIIE") && bytes(args) <= 16_384);
  assert.equal(span.attributes["gen_ai.tool.call.result"], `${"z".repeat(16_381)}...`);
  assert.equal(span.attributes.note, `${"n".repeat(97)}...`);
});

test("an error has at most maxStackFrames frames, the newest", async () => {
  const deep = (n: number): Error => {
    const err = new Error("deep");
    // V8's order: the newest call first.
    const lines = Array.from({ length: n }, (_, i) => `    at f${i} (/app/deep.js:${i + 1}:1)`);
    err.stack = `Error: deep\n${lines.join("\n")}`;
    return err;
  };
  const { client, sent } = fakeClient({});
  client.captureException(deep(101));
  assert.ok(await client.flush(2000));
  const frames = thrown(recordsOf(sent)[0] as Json).frames as Json[];
  assert.equal(frames.length, 100);
  // Oldest first on the wire: f99 … f0, the frame that threw last.
  assert.equal(frames[0]?.function, "f99");
  assert.equal(frames.at(-1)?.function, "f0");

  const small = fakeClient({ maxStackFrames: 5 });
  small.client.captureException(deep(50));
  assert.ok(await small.client.flush(2000));
  const few = thrown(recordsOf(small.sent)[0] as Json).frames as Json[];
  assert.deepEqual(
    few.map((f) => f.function),
    ["f4", "f3", "f2", "f1", "f0"],
  );
});

test("a chain of at most 10 exceptions, cut where it comes back", async () => {
  const { client, sent } = fakeClient({});
  let err = new Error("e10");
  for (let i = 9; i >= 0; i--) err = new Error(`e${i}`, { cause: err });
  client.captureException(err);
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  client.captureException(a);
  const group = new AggregateError(
    Array.from({ length: 50 }, (_, i) => new Error(`g${i}`)),
    "group",
  );
  client.captureException(group);
  assert.ok(await client.flush(2000));
  const [chain, cycle, grouped] = recordsOf(sent).map(
    (r) => (r.attributes["fixwire.exceptions"] as Json[]).map((x) => x.message) as string[],
  ) as [string[], string[], string[]];
  assert.deepEqual(
    chain,
    Array.from({ length: 10 }, (_, i) => `e${i}`),
  );
  assert.deepEqual(cycle, ["a", "b"]);
  assert.equal(grouped.length, 10);
});

test("an error over 1 MB leaves out its breadcrumbs, then its contexts, then is dropped", async () => {
  const { client, sent } = fakeClient({ maxValueLength: 30_000 });
  const big = (c: string): string => c.repeat(30_000);
  withIsolationScope((scope) => {
    for (let i = 0; i < 40; i++) scope.addBreadcrumb({ message: big("c") });
    scope.setContext("small", { ok: true });
    client.captureMessage("crumbs");
  });
  withIsolationScope((scope) => {
    for (let i = 0; i < 40; i++) scope.addBreadcrumb({ message: big("c") });
    scope.setContext(
      "big",
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, big("x")])),
    );
    client.captureMessage("contexts");
  });
  withIsolationScope((scope) => {
    for (let i = 0; i < 40; i++) scope.setExtra(`e${i}`, big("e"));
    client.captureMessage("extras");
  });
  assert.ok(await client.flush(5000));
  const records = recordsOf(sent);
  assert.deepEqual(
    records.map((r) => r.body),
    ["crumbs", "contexts"],
  );
  const [crumbs, contexts] = records as [Json, Json];
  assert.equal(crumbs.attributes["fixwire.breadcrumbs"], undefined);
  assert.deepEqual(crumbs.attributes["fixwire.contexts"], { small: { ok: true } });
  assert.equal(contexts.attributes["fixwire.breadcrumbs"], undefined);
  assert.equal(contexts.attributes["fixwire.contexts"], undefined);
  for (const r of sent) assert.ok(bytes(String(r.body)) <= 1 << 20);
});

test("spans go 100 to a request of at most 5 MB; a span that can't fit is dropped alone", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1, maxValueLength: 100_000 });
  startSpan({ name: "batch" }, () => {
    for (let i = 0; i < 250; i++) startInactiveSpan({ name: `child ${i}` }).end();
  });
  assert.ok(await client.flush(2000));
  const counts = (bodies: Json[]) =>
    bodies.map((b) => (b.resourceSpans[0].scopeSpans[0].spans as Json[]).length);
  assert.deepEqual(counts(bodiesOf(sent, "/v1/traces")), [100, 100, 51]);

  sent.length = 0;
  startSpan({ name: "large" }, () => {
    for (let i = 0; i < 8; i++) {
      const s = startInactiveSpan({ name: `part ${i}` });
      for (let k = 0; k < 10; k++) s.setAttribute(`a${k}`, String(k).repeat(90_000));
      s.end();
    }
    const huge = startInactiveSpan({ name: "huge" });
    for (let k = 0; k < 60; k++) huge.setAttribute(`a${k}`, "h".repeat(90_000));
    huge.end();
  });
  assert.ok(await client.flush(5000));
  const bodies = bodiesOf(sent, "/v1/traces");
  assert.ok(bodies.length > 1);
  for (const r of sent) assert.ok(bytes(String(r.body)) <= 5 << 20);
  const names = spansOf(sent).map((s) => s.name);
  assert.equal(names.length, 9);
  assert.ok(!names.includes("huge"));
});

test("a span keeps 128 attributes", () => {
  fakeClient({ tracesSampleRate: 1 });
  const span = startInactiveSpan({ name: "wide" });
  for (let i = 0; i < 200; i++) span.setAttribute(`a${i}`, i);
  span.setAttribute("a0", "changed"); // a kept one still changes
  assert.equal(Object.keys(span.attributes).length, MAX_ATTRIBUTES);
  assert.equal(span.attributes.a0, "changed");
  assert.equal(span.attributes.a128, undefined);
});

test("a sessions request holds 5,000 aggregates at most", async () => {
  const { client, sent } = fakeClient({ release: "api@1" });
  const aggregates = (client as unknown as { aggregates: SessionAggregates }).aggregates;
  for (let i = 0; i < 5000; i++) aggregates.record("ok", `user${i}`, 0);
  // Past 5,000 users, a request counts without its user, in its minute.
  for (let m = 1; m <= 3; m++) aggregates.record("ok", "late", m * 60);
  assert.ok(await client.flush(10_000));
  const sizes = bodiesOf(sent, "/v1/sessions").map((b) => (b.aggregates as Json[]).length);
  assert.deepEqual(sizes, [5000, 3]);
});

test("a broken DSN or option never stops the app: the SDK stays off, and says so", () => {
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    const { client } = fakeClient({ dsn: "https://ingest.example/no-key" });
    assert.equal(client.enabled, false);
    assert.equal(client.captureMessage("x"), undefined);
    const odd = fakeClient({ sensitiveKeys: 42 as unknown as string[] }).client;
    assert.equal(odd.enabled, false);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 2);
  assert.match(String(warned[0]?.join(" ")), /not started: invalid DSN/);
  assert.ok(!String(warned[0]?.join(" ")).includes("ingest.example"), "the DSN was echoed");
});

test("what is logged while the SDK captures, and its own lines, are no breadcrumbs", async () => {
  // A logging integration: every console.warn line becomes a breadcrumb.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => getClient()?.addBreadcrumb({ message: String(args[0]) });
  try {
    const { client, sent } = fakeClient({
      debug: true,
      beforeBreadcrumb: (crumb) => {
        console.warn("from beforeBreadcrumb"); // would recurse
        return crumb;
      },
      beforeSend: (event) => {
        console.warn("from beforeSend");
        return event;
      },
    });
    withIsolationScope((scope) => {
      scope.addEventProcessor(() => {
        throw new Error("a processor fails"); // the SDK says so in its debug log
      });
      console.warn("the app's line");
      client.captureMessage("boom");
    });
    assert.ok(await client.flush(2000));
    const [record] = recordsOf(sent) as [Json];
    const crumbs = (record.attributes["fixwire.breadcrumbs"] as Json[]).map((c) => c.message);
    assert.deepEqual(crumbs.slice(-1), ["the app's line"]);
    assert.ok(!crumbs.some((m) => /fixwire|beforeBreadcrumb|beforeSend/.test(m)), String(crumbs));
  } finally {
    console.warn = warn;
  }
});

test("the duplicate budget reads a message's first 1,024 characters", () => {
  const head = "x".repeat(1024);
  assert.equal(
    fingerprint({ message: `${head} once` }),
    fingerprint({ message: `${head} and a different tail` }),
  );
  const started = performance.now();
  fingerprint({ message: "@".repeat(10_000_000) });
  assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
});

test("adding a breadcrumb takes constant time", () => {
  const s = new Scope();
  s.maxBreadcrumbs = 10_000;
  const started = performance.now();
  for (let i = 0; i < 1_000_000; i++) s.addBreadcrumb({ message: String(i) });
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
  assert.equal(s.breadcrumbs.length, 10_000);
  assert.equal(s.breadcrumbs.at(-1)?.message, "999999");
  assert.equal(s.breadcrumbs[0]?.message, "990000");
});

test("feedback is redacted and cut; the app's configuration is cut but sent as given", async () => {
  const { client, sent } = fakeClient({
    release: "api@1.2.3.example", // an address to the email detector
    environment: "e".repeat(2000),
  });
  client.captureFeedback({ message: `ada@example.com ${"é".repeat(600)}`, score: -1 });
  client.captureMessage("released api@1.2.3.example");
  client.captureCheckIn({ monitorSlug: "s".repeat(2000), status: "ok" });
  assert.ok(await client.flush(2000));
  const [feedback] = bodiesOf(sent, "/v1/feedback") as [Json];
  assert.equal(feedback.message, `[REDACTED:email] ${"é".repeat(502)}...`);
  assert.equal(feedback.release, "api@1.2.3.example");
  assert.equal(feedback.environment, `${"e".repeat(1021)}...`);
  const [record] = recordsOf(sent) as [Json];
  assert.equal(record.body, "released [REDACTED:email]");
  assert.equal(record.resource["service.version"], "api@1.2.3.example");
  assert.equal(record.resource["deployment.environment.name"], `${"e".repeat(1021)}...`);
  const checkIn = sent.find((r) => r.url.includes("/v1/check-ins/"));
  assert.ok(checkIn?.url.endsWith(`/v1/check-ins/${"s".repeat(1021)}...`));
});
