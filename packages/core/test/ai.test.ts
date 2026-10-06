import assert from "node:assert/strict";
import { test } from "node:test";

import { ai, argumentsHash } from "../src/ai.ts";
import { wrapAnthropic } from "../src/ai-providers.ts";
import { startSpan } from "../src/tracing.ts";
import { fakeClient, type Json, spansOf } from "./helpers.ts";

const attr = (s: Json | undefined, key: string): unknown => s?.attributes[key];
const byOp = (spans: Json[], op: string): Json[] =>
  spans.filter((s) => attr(s, "fixwire.op") === op);

/** A stand-in for the Anthropic SDK client: messages.create, plain or streamed. */
function fakeAnthropic() {
  const calls: Json[] = [];
  const message = {
    id: "msg_1",
    model: "claude-opus-5-5-20261001",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_1", name: "lookup_order", input: { id: "ord_1" } }],
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
  };
  async function* events() {
    yield {
      type: "message_start",
      message: {
        id: "msg_2",
        model: "claude-opus-5-5-20261001",
        usage: { input_tokens: 900, output_tokens: 1 },
      },
    };
    yield { type: "content_block_delta", delta: { type: "text_delta", text: "Your order " } };
    yield { type: "content_block_delta", delta: { type: "text_delta", text: "ships today." } };
    yield {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 42 },
    };
    yield { type: "message_stop" };
  }
  const client = {
    other: "untouched",
    messages: {
      create(params: Json) {
        calls.push(params);
        if (params.model === "broken")
          return Object.assign(Promise.reject(new Error("overloaded")), {});
        const result = Promise.resolve(params.stream ? events() : message);
        return Object.assign(result, { withResponse: () => "raw" });
      },
    },
  };
  return { client, calls };
}

test("an agent run: model calls and tool calls as gen_ai spans, content off by default", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  const { client: raw } = fakeAnthropic();
  const anthropic = wrapAnthropic(raw);
  assert.equal(anthropic.other, "untouched");

  await ai.agent(
    {
      name: "support-bot",
      provider: "anthropic",
      model: "claude-opus-5-5",
      input: "where is my order?",
    },
    async (run) => {
      const first = anthropic.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "where is ord_1?" }],
      });
      assert.equal(first.withResponse(), "raw"); // the SDK's own promise comes back
      const msg = await first;
      const block = msg.content[0] as Json;
      await ai.tool({ name: block.name, callId: block.id, arguments: block.input }, (t) =>
        t.setResult({ status: "shipped" }),
      );
      await assert.rejects(
        ai.tool({ name: "refund", arguments: { id: "ord_1", amount: 5 } }, async () => {
          throw new RangeError("amount above the limit");
        }),
      );
      const stream = await anthropic.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        stream: true,
        messages: [],
      });
      let text = "";
      for await (const ev of stream as AsyncIterable<Json>)
        if (ev.type === "content_block_delta") text += ev.delta.text;
      run.setOutput(text);
    },
  );
  assert.ok(await client.flush(2000));

  const spans = spansOf(sent);
  const [agent] = byOp(spans, "gen_ai.invoke_agent");
  assert.equal(agent?.name, "invoke_agent support-bot");
  assert.equal(agent?.parentSpanId, undefined, "the run is the segment");
  assert.equal(attr(agent, "gen_ai.input.messages"), undefined); // content is off
  assert.equal(attr(agent, "gen_ai.output.messages"), undefined);

  const [plain, streamed] = byOp(spans, "gen_ai.chat");
  for (const s of [plain, streamed]) {
    assert.equal(s?.parentSpanId, agent?.spanId);
    assert.equal(s?.name, "chat claude-opus-5-5");
    assert.equal(attr(s, "gen_ai.provider.name"), "anthropic");
    assert.equal(attr(s, "gen_ai.agent.name"), "support-bot");
    assert.equal(attr(s, "gen_ai.response.model"), "claude-opus-5-5-20261001");
    assert.equal(attr(s, "gen_ai.input.messages"), undefined);
  }
  assert.equal(attr(plain, "gen_ai.usage.input_tokens"), 2200); // cache reads included
  assert.equal(attr(plain, "gen_ai.usage.cache_read.input_tokens"), 1000);
  assert.equal(attr(plain, "gen_ai.response.finish_reasons"), '["tool_use"]');
  assert.equal(attr(plain, "gen_ai.request.max_tokens"), 1024);
  assert.equal(attr(streamed, "gen_ai.response.id"), "msg_2");
  assert.equal(attr(streamed, "gen_ai.usage.input_tokens"), 900);
  assert.equal(attr(streamed, "gen_ai.usage.output_tokens"), 42);
  assert.equal(attr(streamed, "gen_ai.response.finish_reasons"), '["end_turn"]');
  assert.ok(BigInt(streamed?.endTimeUnixNano) >= BigInt(streamed?.startTimeUnixNano));

  const tools = byOp(spans, "gen_ai.execute_tool");
  const lookup = tools.find((s) => s.name === "execute_tool lookup_order");
  const refund = tools.find((s) => s.name === "execute_tool refund");
  assert.equal(attr(lookup, "gen_ai.tool.call.id"), "toolu_1");
  assert.equal(attr(lookup, "fixwire.tool.arguments_hash"), argumentsHash({ id: "ord_1" }));
  assert.equal(attr(lookup, "gen_ai.tool.call.arguments"), undefined);
  assert.equal(attr(lookup, "gen_ai.tool.call.result"), undefined);
  assert.equal(refund?.status.code, 2);
  assert.equal(attr(refund, "error.type"), "RangeError");
  assert.equal(attr(refund, "gen_ai.agent.name"), "support-bot");
});

test("with recordAiContent, content is recorded, bounded and redacted", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1, recordAiContent: true });
  await ai.agent(
    { name: "triage", input: { email: "ada@example.com", text: "refund please" } },
    async (run) => {
      await ai.chat(
        {
          provider: "anthropic",
          model: "claude-opus-5-5",
          input: [{ role: "user", content: "x".repeat(40_000) }],
        },
        (call) =>
          call.setResponse({
            output: [{ role: "assistant", content: "card 4111 1111 1111 1111 refunded" }],
          }),
      );
      ai.tool(
        { name: "notify", arguments: { to: "ada@example.com" }, recordContent: false },
        () => {},
      );
      run.setOutput("done");
    },
  );
  assert.ok(await client.flush(2000));
  const spans = spansOf(sent);
  const [agent] = byOp(spans, "gen_ai.invoke_agent");
  const [chat] = byOp(spans, "gen_ai.chat");
  const [notify] = byOp(spans, "gen_ai.execute_tool");
  const input = String(attr(agent, "gen_ai.input.messages"));
  assert.ok(input.includes("refund please") && !input.includes("ada@example.com"), input);
  assert.equal(attr(agent, "gen_ai.output.messages"), "done");
  assert.ok(String(attr(chat, "gen_ai.input.messages")).length <= 16_384);
  assert.ok(!String(attr(chat, "gen_ai.output.messages")).includes("4111"));
  assert.equal(attr(notify, "gen_ai.tool.call.arguments"), undefined); // per-call override
});

test("argument hashes ignore key order and match the Python SDK", () => {
  assert.equal(
    argumentsHash({ b: 2, a: [1, { y: "é", x: true }] }),
    argumentsHash({ a: [1, { x: true, y: "é" }], b: 2 }),
  );
  assert.notEqual(argumentsHash({ id: 1 }), argumentsHash({ id: 2 }));
  // FNV-1a 64 of '{"id":"ord_1"}' (the Python SDK's test checks the same value).
  assert.equal(argumentsHash({ id: "ord_1" }), "e665776feba25695");
  // Values from the Python SDK's arguments_hash: strings cut at 16 kB of
  // UTF-8, keys in code point order, NaN and the infinities as strings,
  // small numbers with Python's exponent.
  for (const [value, hash] of [
    ["é".repeat(9000), "64715d9755826399"],
    ["😀".repeat(5000), "34cdd5172f496434"],
    [{ "￿": 1, "😀": 2, a: 3, Z: 4, é: 5, "": 6 }, "4861fa96bf28595f"],
    [
      [
        0,
        -1,
        2 ** 53,
        1.5,
        0.1,
        1e-5,
        1.5e-7,
        -2.5e-10,
        123456.789,
        1e-4,
        0.0001234,
        3.14159e-100,
        -7,
      ],
      "ac7f6ce6ab7edfe7",
    ],
    [[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], "e3b44446d407a015"],
    [{ ["k".repeat(17_000)]: "long key" }, "f1b57e73eb9fb945"],
  ] as const)
    assert.equal(argumentsHash(value), hash, JSON.stringify(value).slice(0, 40));
});

test("a failed or abandoned model call still ends its span", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  const anthropic = wrapAnthropic(fakeAnthropic().client);
  await startSpan({ name: "job" }, async () => {
    await assert.rejects(
      anthropic.messages.create({ model: "broken", max_tokens: 1, messages: [] }),
    );
    const stream = await anthropic.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1,
      stream: true,
      messages: [],
    });
    for await (const _ of stream as AsyncIterable<Json>) break; // the consumer stops at the first event
  });
  assert.ok(await client.flush(2000));
  const chats = byOp(spansOf(sent), "gen_ai.chat");
  assert.equal(chats.length, 2);
  const broken = chats.find((s) => s.name === "chat broken");
  assert.equal(broken?.status.code, 2);
  assert.equal(attr(broken, "error.type"), "Error");
  const abandoned = chats.find((s) => s.name === "chat claude-opus-5-5");
  assert.equal(attr(abandoned, "gen_ai.response.id"), "msg_2");
});

test("a tool call outside a recorded trace doesn't serialize or hash its arguments", async () => {
  // The hash walks the whole arguments: work wasted on a span nobody sends.
  let reads = 0;
  const args = {
    get document() {
      reads++;
      return "x".repeat(1_000);
    },
  };
  fakeClient({}); // tracing off
  assert.equal(
    ai.tool({ name: "save", arguments: args }, () => "saved"),
    "saved",
  );
  assert.equal(reads, 0);
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  ai.tool({ name: "save", arguments: args }, () => "saved");
  assert.ok(await client.flush(2000));
  assert.equal(reads, 1);
  const [tool] = byOp(spansOf(sent), "gen_ai.execute_tool");
  assert.match(String(attr(tool, "fixwire.tool.arguments_hash")), /^[0-9a-f]{16}$/);
});

test("a streamed answer is kept for its output only when content is recorded, and only as much", async () => {
  const long = "word ".repeat(10_000); // 50,000 characters
  async function* events() {
    yield { type: "message_start", message: { id: "msg_3", model: "m", usage: {} } };
    for (let i = 0; i < 10; i++) yield { type: "content_block_delta", delta: { text: long } };
  }
  const anthropic = wrapAnthropic({ messages: { create: async (_: Json) => events() } });
  const { client, sent } = fakeClient({ tracesSampleRate: 1, recordAiContent: true });
  for await (const _ of (await anthropic.messages.create({ stream: true })) as AsyncIterable<Json>);
  assert.ok(await client.flush(2000));
  const [chat] = byOp(spansOf(sent), "gen_ai.chat");
  const output = String(attr(chat, "gen_ai.output.messages"));
  assert.ok(output.startsWith('[{"content":"word word') && output.endsWith("..."));
  assert.ok(output.length <= 16_384);
});
