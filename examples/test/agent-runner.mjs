// Runs the support agent with a scripted stand-in for the Claude API: it
// looks an order up, tries a refund the tool refuses, then answers. Prints
// the reply and the requests it got as JSON.
//
//   FIXWIRE_DSN=… node --conditions=fixwire-source agent-runner.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The SDK as the example resolves it (this folder has no dependencies of its own).
const sdk = createRequire(new URL("../support-agent/package.json", import.meta.url)).resolve(
  "@fixwire/node",
);
const Fixwire = await import(pathToFileURL(sdk).href);
const { answer } = await import("../support-agent/agent.mjs");

const reply = (stop, content, tokens = [900, 60]) => ({
  id: `msg_${stop}`,
  model: "claude-opus-5-5-20261001",
  stop_reason: stop,
  content,
  usage: {
    input_tokens: tokens[0],
    output_tokens: tokens[1],
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 0,
  },
});
const script = [
  reply("tool_use", [
    { type: "tool_use", id: "toolu_1", name: "lookup_order", input: { order_id: "ord_1" } },
  ]),
  reply("tool_use", [
    {
      type: "tool_use",
      id: "toolu_2",
      name: "refund_order",
      input: { order_id: "ord_1", reason: "broken" },
    },
  ]),
  reply(
    "end_turn",
    [{ type: "text", text: "Your order has shipped, so I can't refund it." }],
    [1400, 30],
  ),
];
const requests = [];
const client = Fixwire.wrapAnthropic({
  messages: {
    create: async (params) => {
      requests.push(params);
      return script[requests.length - 1];
    },
  },
});
const text = await answer(client, "Refund ord_1, it arrived broken");
const ok = await Fixwire.flush(5000);
console.log(
  JSON.stringify({ text, models: requests.map((r) => r.model), tools: requests[0].tools.length }),
);
process.exit(ok ? 0 : 1);
