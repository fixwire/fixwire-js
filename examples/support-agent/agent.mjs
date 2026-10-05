// A customer-support agent on Claude, traced with Fixwire.
//
//   ANTHROPIC_API_KEY=... FIXWIRE_DSN=https://<key>@<host> npm start -- "Refund ord_1, it arrived broken"
//
// Each question is one agent run in Fixwire: its model calls (model,
// tokens, cache tokens, stop reason) and tool calls (arguments hash,
// failures by error class), with totals and cost per run. Without
// FIXWIRE_DSN the agent still works; nothing is sent.
import { fileURLToPath } from "node:url";

import * as Fixwire from "@fixwire/node";

// Any Claude model works; this is just the example's default.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const MAX_STEPS = 8;

Fixwire.init({
  dsn: process.env.FIXWIRE_DSN,
  release: process.env.RELEASE ?? "support-agent@1.0.0",
  tracesSampleRate: 1,
  // Prompts and answers stay out of Fixwire unless this is on (they're
  // redacted on this machine when it is).
  recordAiContent: process.env.RECORD_AI_CONTENT === "1",
});

const orders = new Map([
  ["ord_1", { status: "shipped", carrier: "DHL", eta: "2026-10-06", total: "49.00 EUR" }],
  ["ord_2", { status: "processing", total: "14.90 EUR" }],
]);

const SYSTEM =
  "You are the support agent of a small coffee shop. Look orders up before answering. " +
  "Refunds are possible only before an order ships; explain that kindly when it has.";

export const TOOLS = [
  {
    name: "lookup_order",
    description: "Look up an order's status, carrier and total by its id.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string", description: "The order id, e.g. ord_1." } },
      required: ["order_id"],
    },
  },
  {
    name: "refund_order",
    description: "Refund an order that has not shipped yet.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "The order id, e.g. ord_2." },
        reason: { type: "string", description: "Why the customer wants a refund." },
      },
      required: ["order_id", "reason"],
    },
  },
];

/** A tool refused: the model is told and can recover. */
class ToolError extends Error {
  name = "ToolError";
}
class OrderNotFound extends ToolError {
  name = "OrderNotFound";
}
class AlreadyShipped extends ToolError {
  name = "AlreadyShipped";
}

const handlers = {
  lookup_order({ order_id }) {
    const order = orders.get(order_id);
    if (!order) throw new OrderNotFound(`no order ${order_id}`);
    return order;
  },
  refund_order({ order_id, reason }) {
    const order = handlers.lookup_order({ order_id });
    if (order.status === "shipped")
      throw new AlreadyShipped(
        `order ${order_id} has shipped; refunds are possible only before shipping`,
      );
    order.status = "refunded";
    return { order_id, status: "refunded", reason };
  },
};

/** Runs the agent on one question and returns its reply. */
export function answer(client, question) {
  return Fixwire.ai.agent(
    { name: "support-agent", provider: "anthropic", model: MODEL, input: question },
    async (run) => {
      const messages = [{ role: "user", content: question }];
      for (let step = 0; step < MAX_STEPS; step++) {
        // A chat span per call: wrapAnthropic() records model, tokens and stop reason.
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          system: SYSTEM,
          tools: TOOLS,
          messages,
        });
        if (response.stop_reason !== "tool_use") {
          const reply = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          run.setOutput(reply);
          return reply;
        }
        messages.push({ role: "assistant", content: response.content });
        const results = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          try {
            // An execute_tool span; a ToolError marks it failed with its class.
            const result = await Fixwire.ai.tool(
              { name: block.name, callId: block.id, arguments: block.input },
              (call) => {
                const out = handlers[block.name](block.input);
                call.setResult(out);
                return out;
              },
            );
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            if (!(err instanceof ToolError)) throw err;
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: err.message,
              is_error: true,
            });
          }
        }
        messages.push({ role: "user", content: results });
      }
      run.span.setAttribute("gen_ai.agent.max_steps_reached", true);
      return "";
    },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = Fixwire.wrapAnthropic(new Anthropic());
  const question = process.argv.slice(2).join(" ") || "Where is my order ord_1?";
  console.log(await answer(client, question));
  await Fixwire.flush(5000);
}
