import assert from "node:assert/strict";
import { test } from "node:test";

import { captureFeedback, setUser } from "../src/api.ts";
import { startSpan } from "../src/tracing.ts";
import { bodiesOf, fakeClient, type Json } from "./helpers.ts";

test("feedback goes to /v1/feedback with its rating, trace and event", async () => {
  const { client, sent } = fakeClient({ release: "web@2", sampleRate: 0, tracesSampleRate: 1 });
  setUser({ id: "u1", username: "ada" });
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const rated = captureFeedback({
    score: -1,
    traceId,
    message: "  Wrong order refunded ",
    source: "thumbs",
  });
  const crash = captureFeedback({
    message: "It crashed on save",
    eventId: "9ec79c33ec9942ab8353589fcb2e04dc",
    score: 7,
  });
  let current = "";
  startSpan({ name: "chat", op: "gen_ai.chat" }, (span) => {
    current = span.traceId;
    captureFeedback({ score: 1 });
  });
  // Nothing to say: nothing is sent.
  assert.equal(captureFeedback({ message: "  " }), undefined);
  assert.equal(captureFeedback({ score: Number.NaN }), undefined);
  assert.ok(rated && crash);
  assert.ok(await client.flush(2000));

  const bodies = bodiesOf(sent, "/v1/feedback");
  assert.equal(bodies.length, 3, "feedback isn't sampled");
  const [first, second, third] = bodies as [Json, Json, Json];
  assert.equal(first.feedback_id, rated);
  assert.equal(first.message, "Wrong order refunded");
  assert.equal(first.source, "thumbs");
  assert.equal(first.score, -1);
  assert.equal(first.trace_id, traceId);
  assert.equal(first.release, "web@2");
  assert.equal(first.environment, "production");
  assert.equal(first.name, "ada");
  assert.deepEqual(first.sdk, { name: "fixwire.javascript.test", version: "0.1.1" });
  assert.equal(second.event_id, "9ec79c33ec9942ab8353589fcb2e04dc");
  assert.equal(second.score, 1, "scores are clamped to [-1, 1]");
  assert.equal(second.source, "api");
  assert.equal(third.trace_id, current, "the current trace by default");
  assert.equal(third.message, "");
  setUser(null);
});
