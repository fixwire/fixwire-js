// The wire: what the SDK sends where (fixwire-protocol).
import assert from "node:assert/strict";
import { test } from "node:test";

import { captureCheckIn } from "../src/api.ts";
import { parseDsn } from "../src/dsn.ts";
import { withIsolationScope } from "../src/scope.ts";
import { startSpan } from "../src/tracing.ts";
import { bodiesOf, fakeClient, type Json, pathOf, recordsOf, thrown } from "./helpers.ts";

test("DSNs: the key, and a base URL without it", () => {
  const d = parseDsn("https://fw_pk_live_4c1f2a@ingest.eu.fixwire.io");
  assert.equal(d.publicKey, "fw_pk_live_4c1f2a");
  assert.equal(d.baseUrl, "https://ingest.eu.fixwire.io");
  assert.equal(
    parseDsn("http://k@localhost:8082/fixwire/").baseUrl,
    "http://localhost:8082/fixwire",
  );
  assert.throws(() => parseDsn("https://ingest.eu.fixwire.io"), /invalid DSN/);
  assert.throws(() => parseDsn("ftp://k@host"), /unsupported/);
});

test("an error is one OTLP log record on /v1/logs, its chain outermost first", async () => {
  const { client, sent } = fakeClient({
    release: "api@2.1.0",
    environment: "staging",
    serverName: "web-1",
  });
  let id: string | undefined;
  let traceId = "";
  withIsolationScope((scope) => {
    scope.setUser({ id: 7, email: "ada@example.com", username: "ada", ip_address: "10.0.0.1" });
    scope.setTag("plan", "team");
    scope.setContext("order", { id: "ord_1", items: 2 });
    scope.setExtra("attempt", 3);
    scope.addBreadcrumb({ category: "cart", message: "checkout started", timestamp: 1791190799.2 });
    scope.setFingerprint(["{{ default }}", "checkout"]);
    scope.addEventProcessor((event) => {
      event.request = {
        method: "POST",
        url: "https://shop.example.com/checkout",
        query_string: "step=2",
        headers: { "user-agent": "Mozilla/5.0", accept: "*/*" },
      };
      event.transaction = "POST /checkout";
      return event;
    });
    const cause = new TypeError("amount 500 exceeds the limit");
    startSpan({ name: "checkout" }, (span) => {
      traceId = span.traceId;
      id = client.captureException(new Error("checkout failed", { cause }), {
        mechanism: { type: "express", handled: false },
      });
    });
  });
  assert.ok(await client.flush(2000));
  const req = sent.find((r) => pathOf(r) === "/v1/logs");
  assert.ok(req);
  assert.equal(req.url, "http://127.0.0.1:1/v1/logs");
  assert.equal(req.headers.Authorization, "Bearer pk");
  assert.equal(req.headers["Content-Type"], "application/json");
  const [r] = recordsOf(sent) as [Json];
  assert.deepEqual(r.resource, {
    "service.version": "api@2.1.0",
    "deployment.environment.name": "staging",
    "host.name": "web-1",
    "telemetry.sdk.name": "fixwire.javascript.test",
    "telemetry.sdk.version": "0.1.2",
    "telemetry.sdk.language": "nodejs",
  });
  assert.equal(r.eventName, "exception");
  assert.equal(r.severityNumber, 21, "unhandled: fatal");
  assert.match(r.timeUnixNano, /^\d{19}$/);
  assert.equal(r.traceId, traceId);
  assert.match(r.spanId, /^[0-9a-f]{16}$/);
  const a = r.attributes;
  assert.equal(a["fixwire.event_id"], id);
  assert.equal(a["exception.type"], "Error");
  assert.equal(a["exception.message"], "checkout failed");
  assert.deepEqual(
    (a["fixwire.exceptions"] as Json[]).map((x) => `${x.type}: ${x.message}`),
    ["Error: checkout failed", "TypeError: amount 500 exceeds the limit"],
  );
  assert.equal(thrown(r).mechanism.type, "express");
  assert.equal(thrown(r).mechanism.handled, false);
  assert.equal(a["fixwire.exceptions"][1].mechanism.source, "cause");
  const last = thrown(r).frames.at(-1) as Json;
  assert.ok(String(last.file).endsWith("protocol.test.ts"), last.file);
  assert.equal(typeof last.line, "number");
  assert.equal(typeof last.column, "number");
  assert.equal(last.in_app, true);
  assert.ok(!("module" in last), "undefined frame fields are left out");
  assert.equal(a["fixwire.handled"], false);
  assert.deepEqual(a["fixwire.tags"], { plan: "team" });
  assert.deepEqual(a["fixwire.contexts"].order, { id: "ord_1", items: 2 });
  assert.equal(a["fixwire.contexts"].trace, undefined, "the trace is the record's");
  assert.deepEqual(a["fixwire.breadcrumbs"], [
    { category: "cart", message: "checkout started", timestamp: 1791190799.2 },
  ]);
  assert.deepEqual(a["fixwire.fingerprint"], ["{{ default }}", "checkout"]);
  assert.equal(a["fixwire.transaction"], "POST /checkout");
  assert.equal(a["user.id"], "7");
  assert.equal(a["user.email"], "[REDACTED:email]", "redacted on the device");
  assert.equal(a["user.name"], "ada");
  assert.equal(a["client.address"], "10.0.0.1");
  assert.equal(a["http.request.method"], "POST");
  assert.equal(a["url.full"], "https://shop.example.com/checkout");
  assert.equal(a["url.query"], "step=2");
  assert.equal(a["user_agent.original"], "Mozilla/5.0");
  assert.equal(a["http.request.header.accept"], "*/*");
  assert.equal(a.attempt, 3);
});

test("a message is a fixwire.message record with its body and level", async () => {
  const { client, sent } = fakeClient({});
  client.captureMessage("disk usage above 90%", "warning");
  client.captureMessage("hello");
  assert.ok(await client.flush(2000));
  const [warn, info] = recordsOf(sent) as [Json, Json];
  assert.equal(warn.eventName, "fixwire.message");
  assert.equal(warn.body, "disk usage above 90%");
  assert.equal(warn.severityNumber, 13);
  assert.equal(warn.attributes["exception.type"], undefined);
  assert.equal(info.severityNumber, 9);
  assert.equal(warn.resource["deployment.environment.name"], "production");
});

test("capturing never throws into the app, whatever was thrown", async () => {
  const { client, sent } = fakeClient({});
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = [
    revoked.proxy,
    Object.defineProperty(new Error("x"), "stack", {
      get: () => {
        throw new Error("no stack");
      },
    }),
    Object.assign(Object.create(Error.prototype), { message: "m", stack: 42 }),
    new Proxy(
      { message: "m", stack: "s" },
      {
        get: () => {
          throw new Error("trap");
        },
      },
    ),
    {
      get constructor(): never {
        throw new Error("getter");
      },
      a: 1,
    },
  ];
  // Their getters and traps threw out of captureException; now they're dropped.
  for (const value of hostile) assert.doesNotThrow(() => client.captureException(value));
  client.captureException(new Error("still reporting"));
  assert.ok(await client.flush(2000));
  assert.deepEqual(
    recordsOf(sent).map((r) => r.attributes["exception.message"]),
    ["still reporting"],
  );
});

test("captures waiting to be encoded are bounded", async () => {
  // Check-ins, feedback and spans have no budget: a burst outran encoding without limit.
  // As many wait as the delivery queue holds (maxQueue, default 100).
  const { client } = fakeClient({});
  for (let i = 0; i < 5_000; i++) client.captureCheckIn({ monitorSlug: "job", status: "ok" });
  assert.equal((client as unknown as { queue: unknown[] }).queue.length, 100);
  await client.close(2000);
  const small = fakeClient({ maxQueue: 7 }).client;
  for (let i = 0; i < 50; i++) small.captureCheckIn({ monitorSlug: "job", status: "ok" });
  assert.equal((small as unknown as { queue: unknown[] }).queue.length, 7);
  await small.close(2000);
});

test("budgets fold repeats into the next event's fixwire.suppressed", async () => {
  // One event, then one each 200 ms: the first three take far less (a cold
  // first capture took over 10 ms on Windows), and the fourth comes after.
  const { client, sent } = fakeClient({ rateLimit: { perIssueBurst: 1, perIssuePerMinute: 300 } });
  const boom = () => new Error("boom");
  client.captureException(boom());
  client.captureException(boom());
  client.captureException(boom());
  await new Promise((r) => setTimeout(r, 300));
  client.captureException(boom());
  assert.ok(await client.flush(2000));
  const records = recordsOf(sent);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.attributes["fixwire.suppressed"], undefined);
  assert.equal(records[1]?.attributes["fixwire.suppressed"], 2);
});

test("bundles registered in _fixwireDebugIds become fixwire.debug_images", async () => {
  const { client, sent } = fakeClient({});
  const g = globalThis as { _fixwireDebugIds?: Record<string, string> };
  // What fixwire-cli injects: the stack at a line of the bundle, and its debug id.
  g._fixwireDebugIds = { [new Error().stack as string]: "c941d872-7c3a-4f1e-8d6c-1b0b1e1ea3f5" };
  try {
    client.captureException(new Error("from the bundle"));
    assert.ok(await client.flush(2000));
  } finally {
    delete g._fixwireDebugIds;
  }
  const [r] = recordsOf(sent) as [Json];
  const [image] = r.attributes["fixwire.debug_images"] as Json[];
  assert.equal(image?.type, "sourcemap");
  assert.equal(image?.debug_id, "c941d872-7c3a-4f1e-8d6c-1b0b1e1ea3f5");
  assert.ok(String(image?.code_file).endsWith("protocol.test.ts"));
});

test("check-ins go to /v1/check-ins/{monitor}", async () => {
  const { client, sent } = fakeClient({ environment: "prod" });
  const id = captureCheckIn(
    { monitorSlug: "nightly-report", status: "in_progress" },
    {
      schedule: { type: "crontab", value: "0 3 * * *" },
      checkinMargin: 5,
      timezone: "Europe/Berlin",
    },
  );
  assert.match(String(id), /^[0-9a-f]{32}$/);
  captureCheckIn({ monitorSlug: "nightly-report", status: "ok", checkInId: id, duration: 42.5 });
  assert.ok(await client.flush(2000));
  const [start, end] = bodiesOf(sent, "/v1/check-ins/nightly-report") as [Json, Json];
  assert.deepEqual(start, {
    check_in_id: id,
    status: "in_progress",
    environment: "prod",
    monitor_config: {
      schedule: { type: "crontab", value: "0 3 * * *" },
      checkin_margin: 5,
      timezone: "Europe/Berlin",
    },
  });
  assert.deepEqual(end, { check_in_id: id, status: "ok", duration: 42.5, environment: "prod" });
});

test("a 429 pauses the kind it names, and its request waits to go again", async () => {
  const { client, sent } = fakeClient({});
  const statuses = [429];
  const seen: number[] = [];
  (client as unknown as { transport: { send: (r: unknown) => Promise<unknown> } }).transport = {
    send: async (req) => {
      const status = statuses.shift() ?? 200;
      seen.push(status);
      sent.push(req as never);
      return {
        status,
        header: (n: string) => (status === 429 && n === "fixwire-rate-limits" ? "60:error" : null),
      };
    },
  };
  client.captureMessage("first");
  assert.equal(await client.flush(300), false, "the 429'd request waits");
  assert.ok((client.delivery.limits.error ?? 0) > Date.now() / 1000);
  assert.equal(client.delivery.queue.length, 1);
  client.captureMessage("second"); // waits behind the pause too
  await client.flush(100);
  assert.deepEqual(seen, [429]);
  await client.close(10);
});
