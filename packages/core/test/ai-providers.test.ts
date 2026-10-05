// The wrappers against the real provider SDKs: their own promise and stream
// classes, fed canned responses through a custom fetch.
import assert from "node:assert/strict";
import { test } from "node:test";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { wrapAnthropic, wrapOpenAI } from "../src/ai-providers.ts";
import { startSpan } from "../src/tracing.ts";
import { fakeClient, type Json, spansOf } from "./helpers.ts";

const attr = (s: Json | undefined, key: string): unknown => s?.attributes[key];
const byOp = (spans: Json[], op: string): Json[] =>
  spans.filter((s) => attr(s, "fixwire.op") === op);

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sse = (events: { event?: string; data: unknown }[]): Response =>
  new Response(
    events
      .map(
        (e) =>
          `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const chatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-x-2026-09-01",
  choices: [
    { index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null } },
  ],
  usage: {
    prompt_tokens: 500,
    completion_tokens: 40,
    total_tokens: 540,
    prompt_tokens_details: { cached_tokens: 400 },
  },
};
const chunk = (delta: Json, extra: Json = {}) => ({
  id: "chatcmpl-2",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-x-2026-09-01",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});
const response = (status: string, extra: Json = {}) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-x-2026-09-01",
  status,
  output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Shipped." }] },
  ],
  usage: {
    input_tokens: 300,
    output_tokens: 12,
    total_tokens: 312,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  ...extra,
});

function openai(): OpenAI {
  return new OpenAI({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (path.endsWith("/chat/completions") && body.model === "broken")
        return new Response(
          JSON.stringify({ error: { message: "overloaded", type: "server_error" } }),
          { status: 500 },
        );
      if (path.endsWith("/chat/completions") && body.stream)
        return sse([
          { data: chunk({ role: "assistant", content: "Your order " }) },
          { data: chunk({ content: "ships today." }) },
          { data: { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
          {
            data: {
              ...chunk({}),
              choices: [],
              usage: { prompt_tokens: 80, completion_tokens: 6, total_tokens: 86 },
            },
          },
          { data: "[DONE]" },
        ]);
      if (path.endsWith("/chat/completions")) return json(chatCompletion);
      if (path.endsWith("/responses") && body.stream)
        return sse([
          {
            event: "response.created",
            data: {
              type: "response.created",
              sequence_number: 0,
              response: response("in_progress", { usage: null }),
            },
          },
          {
            event: "response.output_text.delta",
            data: { type: "response.output_text.delta", sequence_number: 1, delta: "Shipped." },
          },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              sequence_number: 2,
              response: response("completed"),
            },
          },
        ]);
      if (path.endsWith("/responses"))
        return json(
          response("incomplete", { incomplete_details: { reason: "max_output_tokens" } }),
        );
      if (path.endsWith("/embeddings"))
        return json({
          object: "list",
          model: "embed-x",
          data: [{ object: "embedding", index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        });
      return new Response("not found", { status: 404 });
    },
  });
}

test("OpenAI: chat completions (plain and streamed), the Responses API and embeddings", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1, recordAiContent: true });
  const traced = wrapOpenAI(openai());
  await startSpan({ name: "job" }, async () => {
    const promise = traced.chat.completions.create({
      model: "gpt-x",
      max_completion_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(typeof promise.withResponse, "function"); // the SDK's own promise
    const completion = await promise;
    assert.equal(completion.id, "chatcmpl-1");

    const stream = await traced.chat.completions.create({
      model: "gpt-x",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "where is my order?" }],
    });
    let text = "";
    for await (const c of stream) text += c.choices[0]?.delta?.content ?? "";
    assert.equal(text, "Your order ships today.");

    await traced.responses.create({
      model: "gpt-x",
      input: "status?",
      instructions: "Be brief.",
      max_output_tokens: 16,
    });
    const events = await traced.responses.create({
      model: "gpt-x",
      input: "status?",
      stream: true,
    });
    for await (const _ of events) {
      // consume
    }
    const vectors = await traced.embeddings.create({ model: "embed-x", input: "beans" });
    assert.equal(vectors.data.length, 1);
    await assert.rejects(traced.chat.completions.create({ model: "broken", messages: [] }));
  });
  assert.ok(await client.flush(2000));

  const chats = byOp(spansOf(sent), "gen_ai.chat");
  assert.equal(chats.length, 5);
  for (const s of chats) {
    assert.equal(attr(s, "gen_ai.provider.name"), "openai");
    assert.equal(attr(s, "fixwire.origin"), "auto.ai.openai");
  }
  const [plain, streamed, resp, respStream, broken] = chats;
  assert.equal(attr(plain, "gen_ai.request.max_tokens"), 256);
  assert.equal(attr(plain, "gen_ai.response.model"), "gpt-x-2026-09-01");
  assert.equal(attr(plain, "gen_ai.usage.input_tokens"), 500);
  assert.equal(attr(plain, "gen_ai.usage.cache_read.input_tokens"), 400);
  assert.equal(attr(plain, "gen_ai.response.finish_reasons"), '["tool_calls"]');
  assert.equal(attr(streamed, "gen_ai.usage.input_tokens"), 80);
  assert.equal(attr(streamed, "gen_ai.usage.output_tokens"), 6);
  assert.equal(attr(streamed, "gen_ai.response.finish_reasons"), '["stop"]');
  assert.match(String(attr(streamed, "gen_ai.output.messages")), /Your order ships today/);
  assert.equal(attr(resp, "gen_ai.system_instructions"), "Be brief.");
  assert.equal(attr(resp, "gen_ai.response.finish_reasons"), '["max_output_tokens"]');
  assert.equal(attr(resp, "gen_ai.usage.cache_read.input_tokens"), 200);
  assert.equal(attr(respStream, "gen_ai.response.id"), "resp_1");
  assert.equal(attr(respStream, "gen_ai.usage.output_tokens"), 12);
  assert.equal(attr(respStream, "gen_ai.response.finish_reasons"), '["completed"]');
  assert.equal(broken?.status.code, 2);
  const [embed] = byOp(spansOf(sent), "gen_ai.embeddings");
  assert.equal(embed?.name, "embeddings embed-x");
  assert.equal(attr(embed, "gen_ai.usage.input_tokens"), 7);
});

test("Anthropic: the real SDK, plain and streamed, cache tokens counted in the input", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
  };
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5-20261001",
    content: [{ type: "text", text: "Shipped." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
  const anthropic = wrapAnthropic(
    new Anthropic({
      apiKey: "test",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (!body.stream) return json(message);
        return sse([
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: {
                ...message,
                content: [],
                stop_reason: null,
                usage: { ...usage, output_tokens: 1 },
              },
            },
          },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Shipped." },
            },
          },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]);
      },
    }),
  );
  await startSpan({ name: "job" }, async () => {
    const promise = anthropic.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "status?" }],
    });
    assert.equal(typeof promise.withResponse, "function");
    await promise;
    const stream = await anthropic.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 64,
      stream: true,
      messages: [],
    });
    for await (const _ of stream) {
      // consume
    }
  });
  assert.ok(await client.flush(2000));
  const chats = byOp(spansOf(sent), "gen_ai.chat");
  assert.equal(chats.length, 2);
  for (const s of chats) {
    assert.equal(attr(s, "gen_ai.usage.input_tokens"), 1050); // 100 + 900 read + 50 written
    assert.equal(attr(s, "gen_ai.usage.cache_read.input_tokens"), 900);
    assert.equal(attr(s, "gen_ai.usage.cache_creation.input_tokens"), 50);
    assert.equal(attr(s, "gen_ai.usage.output_tokens"), 20);
    assert.equal(attr(s, "gen_ai.response.finish_reasons"), '["end_turn"]');
  }
});
