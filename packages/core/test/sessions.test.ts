import assert from "node:assert/strict";
import { test } from "node:test";

import { getIsolationScope, withIsolationScope } from "../src/scope.ts";
import { SessionAggregates } from "../src/sessions.ts";
import { bodiesOf, fakeClient, type Json } from "./helpers.ts";

/** The /v1/sessions bodies sent: page sessions, or a server's aggregates. */
const bodies = (sent: Parameters<typeof bodiesOf>[0], kind: "sessions" | "aggregates"): Json[] =>
  bodiesOf(sent, "/v1/sessions").filter((b) => b[kind]);
const sessionsOf = (sent: Parameters<typeof bodiesOf>[0]): Json[] =>
  bodies(sent, "sessions").flatMap((b) => b.sessions);

test("a page session starts, counts errors, and ends crashed on an unhandled one", async () => {
  const { client, sent } = fakeClient({ release: "web@1.4.0" });
  getIsolationScope().setUser({ email: "ada@example.com" });
  client.startSession();
  client.captureException(new Error("handled"));
  client.captureException(new Error("boom"), { mechanism: { type: "onerror", handled: false } });
  client.endSession(); // already over: nothing more is sent
  await client.flush(2000);
  const [body] = bodies(sent, "sessions");
  assert.deepEqual(body?.sdk, { name: "fixwire.javascript.test", version: "0.1.0" });
  assert.equal(body?.release, "web@1.4.0");
  assert.equal(body?.environment, "production");
  const updates = sessionsOf(sent);
  assert.equal(updates.length, 2);
  const [start, crash] = updates;
  assert.equal(start?.init, true);
  assert.equal(start?.status, "ok");
  assert.equal(crash?.init, false);
  assert.equal(crash?.status, "crashed");
  assert.equal(crash?.errors, 2);
  assert.equal(crash?.sid, start?.sid);
  // The user is a hash made on the device: the email never leaves it.
  assert.match(String(crash?.did), /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(updates).includes("ada@example.com"));
  getIsolationScope().setUser(null);
  await client.close();
});

test("a page session with handled errors ends exited, counting them", async () => {
  const { client, sent } = fakeClient({ release: "web@1.4.0" });
  client.startSession();
  client.captureMessage("careful", "error");
  client.endSession();
  await client.flush(2000);
  const end = sessionsOf(sent).at(-1);
  assert.equal(end?.status, "exited");
  assert.equal(end?.errors, 1);
  assert.equal(end?.did, undefined, "no user, no did");
  await client.close();
});

test("each request is a session: exited, errored or crashed, counted per minute and user", async () => {
  const { client, sent } = fakeClient({ release: "api@2.0.0", environment: "staging" });
  const request = (user: string | undefined, error?: "handled" | "unhandled") =>
    withIsolationScope((scope) => {
      const end = client.startRequestSession(scope);
      if (user) scope.setUser({ id: user });
      if (error === "handled") client.captureException(new Error("retry"));
      if (error === "unhandled")
        client.captureException(new Error("boom"), { mechanism: { type: "http", handled: false } });
      end();
      end(); // ending twice counts once
    });
  request("u1");
  request("u1", "handled");
  request("u2", "unhandled");
  request(undefined);
  await client.flush(2000);
  const [batch] = bodies(sent, "aggregates");
  assert.equal(batch?.release, "api@2.0.0");
  assert.equal(batch?.environment, "staging");
  const sum = (k: string) =>
    batch?.aggregates.reduce((n: number, a: Record<string, number>) => n + (a[k] ?? 0), 0);
  assert.equal(sum("exited"), 2);
  assert.equal(sum("errored"), 1);
  assert.equal(sum("crashed"), 1);
  const dids = new Set(batch?.aggregates.map((a: { did?: string }) => a.did).filter(Boolean));
  assert.equal(dids.size, 2, "two users, hashed");
  for (const d of dids) assert.match(String(d), /^[0-9a-f]{32}$/);
  await client.close();
});

test("past 5,000 users a minute, requests are counted without one", async () => {
  // User ids may come from anyone: memory and the body stay bounded.
  const aggregates = new SessionAggregates();
  for (let i = 0; i < 6_000; i++) aggregates.record("ok", `user-${i}`, 60);
  aggregates.record("crashed", "user-0", 60);
  assert.equal(aggregates.size, 5_001);
  const counts = await aggregates.take();
  const sum = (k: string) => counts.reduce((n, a) => n + Number(a[k] ?? 0), 0);
  assert.equal(sum("exited"), 6_000);
  assert.equal(sum("crashed"), 1);
  assert.equal(counts.filter((a) => !a.did).length, 1);
});

test("sessions need a release, and can be turned off", async () => {
  for (const options of [{}, { release: "web@1", autoSessionTracking: false }]) {
    const { client, sent } = fakeClient(options);
    client.startSession();
    withIsolationScope((scope) => client.startRequestSession(scope)());
    await client.flush(2000);
    assert.equal(bodiesOf(sent, "/v1/sessions").length, 0);
    await client.close();
  }
});
