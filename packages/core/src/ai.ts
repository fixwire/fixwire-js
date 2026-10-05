/**
 * AI agent tracing with the OpenTelemetry GenAI conventions (`gen_ai.*`
 * attributes and ops), which Fixwire reads for agent runs, tool calls,
 * tokens and cost, and agent detectors.
 *
 *   ai.agent → invoke_agent span (one run)
 *     ai.chat → chat span per model call (tokens, finish reasons)
 *     ai.tool → execute_tool span per tool call (errors, arguments hash)
 *
 * Prompts, outputs and tool arguments are recorded only with
 * `recordAiContent` (or `recordContent` per call), bounded, and redacted
 * like everything else. Without it, tool arguments still get a hash, so
 * repeated identical calls (agent loops) are visible.
 */
import { getClient } from "./api.ts";
import { normalize } from "./serialize.ts";
import {
  getActiveSpan,
  type Span,
  type SpanAttributes,
  type StartSpanOptions,
  startSpan,
} from "./tracing.ts";

/** Longest recorded content attribute (characters). */
export const MAX_AI_CONTENT = 16_384;

/** Token counts of a model call. */
export interface TokenUsage {
  /** All input tokens, cached ones included (as the OpenTelemetry conventions count them). */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens read from the provider's prompt cache. */
  cacheReadInputTokens?: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheCreationInputTokens?: number;
}

/** What a model call returned. */
export interface ChatResponse {
  id?: string;
  /** The model that answered (may differ from the one requested). */
  model?: string;
  /** e.g. `["end_turn"]`, `["tool_use"]`, `["max_tokens"]`. */
  finishReasons?: string[];
  /** The output messages; recorded only with content recording on. */
  output?: unknown;
  usage?: TokenUsage;
}

interface ContentOption {
  /** Record content for this call (default: the client's recordAiContent). */
  recordContent?: boolean;
  attributes?: SpanAttributes;
}

/** Options of ai.agent(). */
export interface AgentOptions extends ContentOption {
  /** The agent's name, e.g. `"support-bot"`: runs and detectors group by it. */
  name: string;
  id?: string;
  /** The provider of its main model: `"anthropic"`, `"openai"`, … */
  provider?: string;
  model?: string;
  /** Groups the runs of one conversation or session. */
  conversationId?: string;
  /** The run's input (recorded only with content recording on). */
  input?: unknown;
}

/** Options of ai.chat(). */
export interface ChatOptions extends ContentOption {
  /** `"anthropic"`, `"openai"`, `"google"`, `"aws.bedrock"`, … */
  provider: string;
  /** The model requested, e.g. `"claude-opus-5-5"`. */
  model: string;
  /** The messages sent (recorded only with content recording on). */
  input?: unknown;
  /** The system prompt (recorded only with content recording on). */
  system?: unknown;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

/** Options of ai.tool(). */
export interface ToolOptions extends ContentOption {
  /** The tool's name, as the model calls it. */
  name: string;
  /** The model's id for this call (e.g. a tool_use block's id). */
  callId?: string;
  description?: string;
  /** The arguments: hashed always, recorded only with content recording on. */
  arguments?: unknown;
}

/** Options of ai.embeddings(). */
export interface EmbeddingsOptions extends ContentOption {
  provider: string;
  model: string;
  input?: unknown;
}

/** Whether content is recorded for a call (its option, else the client's recordAiContent). */
export const recording = (o: ContentOption): boolean =>
  o.recordContent ?? getClient()?.options.recordAiContent ?? false;

/** JSON with sorted keys, for stable hashes and readable content. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return JSON.stringify(sort(normalize(value, MAX_AI_CONTENT))) ?? "null";
}

/** FNV-1a 64 of the UTF-8 text, as 16 hex digits (the Python SDK computes the same). */
export function argumentsHash(value: unknown): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(canonical(value))) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const content = (value: unknown): string => {
  const s = typeof value === "string" ? value : canonical(value);
  return s.length > MAX_AI_CONTENT ? `${s.slice(0, MAX_AI_CONTENT - 3)}...` : s;
};

const maybe = (record: boolean, value: unknown): string | undefined =>
  record && value !== undefined ? content(value) : undefined;

/** The agent a span runs under, from the nearest invoke_agent span. */
function currentAgent(): string | undefined {
  const name = getActiveSpan()?.attributes["gen_ai.agent.name"];
  return typeof name === "string" ? name : undefined;
}

const errorType = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** Marks a span failed with the error's class (the tool_error detector groups by it). */
export function failed(span: Span, e: unknown): void {
  span.setStatus("error").setAttribute("error.type", errorType(e));
}

/** Runs cb in a span; a throw or rejection sets error.type and is passed on. */
function run<T, H>(options: StartSpanOptions, handle: (span: Span) => H, cb: (h: H) => T): T {
  return startSpan(options, (span) => {
    const fail = (e: unknown): never => {
      failed(span, e);
      throw e;
    };
    try {
      const out = cb(handle(span));
      if (out && typeof (out as { then?: unknown }).then === "function")
        return (out as unknown as Promise<unknown>).then(undefined, fail) as T;
      return out;
    } catch (e) {
      return fail(e);
    }
  });
}

/** A model call in progress: report what it returned. */
export class ChatSpan {
  readonly span: Span;
  private readonly record: boolean;

  constructor(span: Span, record: boolean) {
    this.span = span;
    this.record = record;
  }

  /** Token counts (also accepted inside setResponse). */
  setUsage(u: TokenUsage): this {
    this.span.setAttributes({
      "gen_ai.usage.input_tokens": u.inputTokens,
      "gen_ai.usage.output_tokens": u.outputTokens,
      "gen_ai.usage.cache_read.input_tokens": u.cacheReadInputTokens,
      "gen_ai.usage.cache_creation.input_tokens": u.cacheCreationInputTokens,
    });
    return this;
  }

  /** The response: id, model, finish reasons, usage, and the output (with content recording on). */
  setResponse(r: ChatResponse): this {
    this.span.setAttributes({
      "gen_ai.response.id": r.id,
      "gen_ai.response.model": r.model,
      "gen_ai.response.finish_reasons": r.finishReasons
        ? JSON.stringify(r.finishReasons)
        : undefined,
      "gen_ai.output.messages": maybe(this.record, r.output),
    });
    if (r.usage) this.setUsage(r.usage);
    return this;
  }
}

/** A tool call in progress: report its result. */
export class ToolSpan {
  readonly span: Span;
  private readonly record: boolean;

  constructor(span: Span, record: boolean) {
    this.span = span;
    this.record = record;
  }

  /** The tool's result (recorded only with content recording on). */
  setResult(result: unknown): this {
    this.span.setAttribute("gen_ai.tool.call.result", maybe(this.record, result));
    return this;
  }
}

/** An agent run in progress. */
export class AgentSpan {
  readonly span: Span;
  private readonly record: boolean;

  constructor(span: Span, record: boolean) {
    this.span = span;
    this.record = record;
  }

  /** The run's final output (recorded only with content recording on). */
  setOutput(output: unknown): this {
    this.span.setAttribute("gen_ai.output.messages", maybe(this.record, output));
    return this;
  }
}

/** A chat span's options (the wrappers pass their origin). */
export function chatSpanOptions(
  o: ChatOptions,
  record: boolean,
  origin = "manual.ai",
): StartSpanOptions {
  return {
    name: `chat ${o.model}`,
    op: "gen_ai.chat",
    origin,
    attributes: {
      ...o.attributes,
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": o.provider,
      "gen_ai.system": o.provider,
      "gen_ai.request.model": o.model,
      "gen_ai.request.max_tokens": o.maxTokens,
      "gen_ai.request.temperature": o.temperature,
      "gen_ai.request.top_p": o.topP,
      "gen_ai.agent.name": currentAgent(),
      "gen_ai.input.messages": maybe(record, o.input),
      "gen_ai.system_instructions": maybe(record, o.system),
    },
  };
}

/**
 * Runs an agent: an invoke_agent span that its model calls and tool calls
 * join. Fixwire shows it as one run, with totals, cost and detectors.
 *
 * @example
 * await ai.agent({ name: "support-bot", provider: "anthropic", model: "claude-opus-5-5" }, async (run) => {
 *   const reply = await ai.chat({ provider: "anthropic", model: "claude-opus-5-5" }, async (call) => …);
 *   run.setOutput(reply);
 * });
 */
function agent<T>(options: AgentOptions, cb: (run: AgentSpan) => T): T {
  const record = recording(options);
  return run(
    {
      name: `invoke_agent ${options.name}`,
      op: "gen_ai.invoke_agent",
      origin: "manual.ai",
      attributes: {
        ...options.attributes,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": options.name,
        "gen_ai.agent.id": options.id,
        "gen_ai.provider.name": options.provider,
        "gen_ai.system": options.provider,
        "gen_ai.request.model": options.model,
        "gen_ai.conversation.id": options.conversationId,
        "gen_ai.input.messages": maybe(record, options.input),
      },
    },
    (span) => new AgentSpan(span, record),
    cb,
  );
}

/**
 * A model call: a chat span with the model, tokens and finish reasons
 * (report them with `call.setResponse`). For Anthropic clients,
 * wrapAnthropic() does this for you.
 *
 * @example
 * const res = await ai.chat({ provider: "openai", model: "gpt-x", input: messages }, async (call) => {
 *   const r = await openai.chat.completions.create({ model: "gpt-x", messages });
 *   call.setResponse({ id: r.id, model: r.model, finishReasons: r.choices.map((c) => c.finish_reason),
 *     usage: { inputTokens: r.usage?.prompt_tokens, outputTokens: r.usage?.completion_tokens } });
 *   return r;
 * });
 */
function chat<T>(options: ChatOptions, cb: (call: ChatSpan) => T): T {
  const record = recording(options);
  return run(chatSpanOptions(options, record), (span) => new ChatSpan(span, record), cb);
}

/**
 * A tool call: an execute_tool span. A throw marks it failed with the
 * error's class (the tool_error detector groups by agent, tool and class).
 *
 * @example
 * const order = await ai.tool({ name: "lookup_order", callId: block.id, arguments: block.input }, () =>
 *   orders.find(block.input.id),
 * );
 */
function tool<T>(options: ToolOptions, cb: (call: ToolSpan) => T): T {
  const record = recording(options);
  return run(
    {
      name: `execute_tool ${options.name}`,
      op: "gen_ai.execute_tool",
      origin: "manual.ai",
      attributes: {
        ...options.attributes,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": options.name,
        "gen_ai.tool.call.id": options.callId,
        "gen_ai.tool.description": options.description,
        "gen_ai.agent.name": currentAgent(),
        "fixwire.tool.arguments_hash":
          options.arguments !== undefined ? argumentsHash(options.arguments) : undefined,
        "gen_ai.tool.call.arguments": maybe(record, options.arguments),
      },
    },
    (span) => new ToolSpan(span, record),
    cb,
  );
}

/** An embeddings call: report usage with `call.setUsage`. */
/** An embeddings span's options (the wrappers pass their origin). */
export function embeddingsSpanOptions(
  o: EmbeddingsOptions,
  record: boolean,
  origin = "manual.ai",
): StartSpanOptions {
  return {
    name: `embeddings ${o.model}`,
    op: "gen_ai.embeddings",
    origin,
    attributes: {
      ...o.attributes,
      "gen_ai.operation.name": "embeddings",
      "gen_ai.provider.name": o.provider,
      "gen_ai.system": o.provider,
      "gen_ai.request.model": o.model,
      "gen_ai.agent.name": currentAgent(),
      "gen_ai.input.messages": maybe(record, o.input),
    },
  };
}

function embeddings<T>(options: EmbeddingsOptions, cb: (call: ChatSpan) => T): T {
  const record = recording(options);
  return run(embeddingsSpanOptions(options, record), (span) => new ChatSpan(span, record), cb);
}

/** AI agent tracing helpers: agent runs, model calls, tool calls, embeddings. */
export const ai = { agent, chat, tool, embeddings };
