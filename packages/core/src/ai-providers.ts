/**
 * Client wrappers for AI provider SDKs: each model call becomes a chat (or
 * embeddings) span with the model, tokens, cache tokens and finish reasons,
 * under the active span (an agent run, a request). The wrapped client is a
 * proxy: the original is untouched, and non-streaming calls return the
 * SDK's own promise, so its extras keep working.
 *
 * Token counts follow the OpenTelemetry conventions: input tokens include
 * the cached ones, which are also reported on their own.
 */
import {
  type ChatResponse,
  ChatSpan,
  chatSpanOptions,
  embeddingsSpanOptions,
  failed,
  recording,
  type TokenUsage,
} from "./ai.ts";
import { type StartSpanOptions, startInactiveSpan, withActiveSpan } from "./tracing.ts";

// biome-ignore lint/suspicious/noExplicitAny: SDK payloads are read defensively, field by field
type Json = Record<string, any>;

/** How to read one SDK method's calls. */
interface Spec {
  spanOptions(params: Json, record: boolean): StartSpanOptions;
  streaming(params: Json): boolean;
  response(result: Json): ChatResponse;
  /** Reads a stream's events; returns the response once it ends. */
  stream?(): { observe(event: Json): void; response(): ChatResponse };
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const isAsyncIterable = (v: unknown): v is AsyncIterable<Json> =>
  !!v && typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

/** The same stream; the span ends, with the response, when the stream is consumed, abandoned or fails. */
function traceStream<S extends AsyncIterable<Json>>(
  stream: S,
  call: ChatSpan,
  reader: { observe(event: Json): void; response(): ChatResponse },
): S {
  let ended = false;
  const end = (error?: unknown): void => {
    if (ended) return;
    ended = true;
    try {
      call.setResponse(reader.response());
    } catch {
      // a malformed event must not break the caller's stream
    }
    if (error !== undefined) failed(call.span, error);
    call.span.end();
  };
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop !== Symbol.asyncIterator) return Reflect.get(target, prop, receiver);
      return () => {
        const it = target[Symbol.asyncIterator]();
        return {
          async next() {
            try {
              const r = await it.next();
              if (r.done) end();
              else {
                try {
                  reader.observe(r.value);
                } catch {
                  // keep streaming
                }
              }
              return r;
            } catch (e) {
              end(e);
              throw e;
            }
          },
          async return(value?: unknown) {
            end(); // the consumer stopped early
            return (await it.return?.(value)) ?? { done: true as const, value: undefined };
          },
        };
      };
    },
  });
}

/** Wraps one SDK method so each call is a span. */
function traced(spec: Spec, target: object, method: (...args: unknown[]) => unknown) {
  return (params: Json, ...rest: unknown[]): unknown => {
    const record = recording({});
    const span = startInactiveSpan(spec.spanOptions(params ?? {}, record));
    const call = new ChatSpan(span, record);
    let result: unknown;
    try {
      // Boxed, so no scope strategy wraps (and replaces) the SDK's promise.
      result = withActiveSpan(span, () => ({ r: method.call(target, params, ...rest) })).r;
    } catch (e) {
      failed(span, e);
      span.end();
      throw e;
    }
    const finish = (res: unknown): void => {
      try {
        call.setResponse(spec.response((res ?? {}) as Json));
      } catch {
        // an unexpected response shape is not the caller's problem
      }
      span.end();
    };
    const fail = (e: unknown): never => {
      failed(span, e);
      span.end();
      throw e;
    };
    if (!spec.streaming(params ?? {}) || !spec.stream) {
      // Hand back the SDK's own promise; the span ends on the side.
      Promise.resolve(result)
        .then(finish, fail)
        .catch(() => {});
      return result;
    }
    const reader = spec.stream;
    return Promise.resolve(result).then((res) => {
      if (isAsyncIterable(res)) return traceStream(res, call, reader());
      finish(res);
      return res;
    }, fail);
  };
}

/** A proxy of `root` whose methods at the given paths ("chat.completions.create") are traced. */
function instrument<C extends object>(root: C, routes: Record<string, Spec>): C {
  const cache = new Map<string, object>();
  const wrap = (obj: object, prefix: string): object =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string") return value;
        const path = prefix ? `${prefix}.${prop}` : prop;
        const spec = routes[path];
        if (spec && typeof value === "function")
          return traced(spec, target, value as (...args: unknown[]) => unknown);
        if (
          value &&
          typeof value === "object" &&
          Object.keys(routes).some((r) => r.startsWith(`${path}.`))
        ) {
          let p = cache.get(path);
          if (!p) {
            p = wrap(value, path);
            cache.set(path, p);
          }
          return p;
        }
        return value;
      },
    });
  return wrap(root, "") as C;
}

// Anthropic.

const anthropicUsage = (u: Json | undefined): TokenUsage => {
  const read = num(u?.cache_read_input_tokens);
  const written = num(u?.cache_creation_input_tokens);
  const input = num(u?.input_tokens);
  return {
    // Anthropic counts cache reads and writes apart from input_tokens.
    inputTokens: input === undefined ? undefined : input + (read ?? 0) + (written ?? 0),
    outputTokens: num(u?.output_tokens),
    cacheReadInputTokens: read,
    cacheCreationInputTokens: written,
  };
};

const anthropicMessages: Spec = {
  spanOptions: (p, record) =>
    chatSpanOptions(
      {
        provider: "anthropic",
        model: str(p.model) ?? "unknown",
        input: p.messages,
        system: p.system,
        maxTokens: num(p.max_tokens),
        temperature: num(p.temperature),
        topP: num(p.top_p),
      },
      record,
      "auto.ai.anthropic",
    ),
  streaming: (p) => p.stream === true,
  response: (m) => ({
    id: str(m.id),
    model: str(m.model),
    finishReasons: m.stop_reason ? [m.stop_reason] : undefined,
    output: m.content,
    usage: anthropicUsage(m.usage),
  }),
  stream: () => {
    const r: ChatResponse = {};
    let usage: Json = {};
    const texts: string[] = [];
    return {
      observe(ev) {
        if (ev.type === "message_start" && ev.message) {
          r.id = str(ev.message.id);
          r.model = str(ev.message.model);
          usage = { ...ev.message.usage };
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) r.finishReasons = [ev.delta.stop_reason];
          if (num(ev.usage?.output_tokens) !== undefined)
            usage.output_tokens = ev.usage.output_tokens;
        } else if (ev.type === "content_block_delta" && typeof ev.delta?.text === "string") {
          texts.push(ev.delta.text);
        }
      },
      response: () => ({
        ...r,
        usage: anthropicUsage(usage),
        output: texts.length ? [{ role: "assistant", content: texts.join("") }] : undefined,
      }),
    };
  },
};

/** The part of an Anthropic client that wrapAnthropic() instruments. */
export interface AnthropicLike {
  messages: { create(...args: never[]): unknown };
}

/**
 * Traces an Anthropic SDK client: each `messages.create` call, streaming or
 * not, becomes a chat span with the model, tokens (cache tokens too) and
 * stop reason. Returns the client wrapped; the original is untouched. A
 * streamed call's span ends when the stream is consumed.
 *
 * @example
 * const anthropic = wrapAnthropic(new Anthropic());
 */
export function wrapAnthropic<C extends AnthropicLike>(client: C): C {
  return instrument(client, { "messages.create": anthropicMessages });
}

// OpenAI.

const openaiChatUsage = (u: Json | undefined): TokenUsage => ({
  inputTokens: num(u?.prompt_tokens),
  outputTokens: num(u?.completion_tokens),
  cacheReadInputTokens: num(u?.prompt_tokens_details?.cached_tokens),
  cacheCreationInputTokens: num(u?.prompt_tokens_details?.cache_write_tokens),
});

const openaiChat: Spec = {
  spanOptions: (p, record) =>
    chatSpanOptions(
      {
        provider: "openai",
        model: str(p.model) ?? "unknown",
        input: p.messages,
        maxTokens: num(p.max_completion_tokens) ?? num(p.max_tokens),
        temperature: num(p.temperature),
        topP: num(p.top_p),
      },
      record,
      "auto.ai.openai",
    ),
  streaming: (p) => p.stream === true,
  response: (c) => ({
    id: str(c.id),
    model: str(c.model),
    finishReasons: Array.isArray(c.choices)
      ? c.choices.map((ch: Json) => ch.finish_reason).filter(Boolean)
      : undefined,
    output: Array.isArray(c.choices) ? c.choices.map((ch: Json) => ch.message) : undefined,
    usage: openaiChatUsage(c.usage),
  }),
  stream: () => {
    const r: ChatResponse = {};
    const reasons = new Set<string>();
    const texts: string[] = [];
    let usage: Json | undefined;
    return {
      observe(chunk) {
        r.id ??= str(chunk.id);
        r.model ??= str(chunk.model);
        for (const ch of Array.isArray(chunk.choices) ? chunk.choices : []) {
          if (typeof ch.delta?.content === "string") texts.push(ch.delta.content);
          if (ch.finish_reason) reasons.add(ch.finish_reason);
        }
        // Present on the last chunk with stream_options: { include_usage: true }.
        if (chunk.usage) usage = chunk.usage;
      },
      response: () => ({
        ...r,
        finishReasons: reasons.size ? [...reasons] : undefined,
        usage: openaiChatUsage(usage),
        output: texts.length ? [{ role: "assistant", content: texts.join("") }] : undefined,
      }),
    };
  },
};

const openaiResponse = (res: Json): ChatResponse => {
  const u = res.usage as Json | undefined;
  const reason = str(res.incomplete_details?.reason) ?? str(res.status);
  return {
    id: str(res.id),
    model: str(res.model),
    finishReasons: reason ? [reason] : undefined,
    output: res.output,
    usage: {
      inputTokens: num(u?.input_tokens),
      outputTokens: num(u?.output_tokens),
      cacheReadInputTokens: num(u?.input_tokens_details?.cached_tokens),
      cacheCreationInputTokens: num(u?.input_tokens_details?.cache_write_tokens),
    },
  };
};

const openaiResponses: Spec = {
  spanOptions: (p, record) =>
    chatSpanOptions(
      {
        provider: "openai",
        model: str(p.model) ?? "unknown",
        input: p.input,
        system: p.instructions,
        maxTokens: num(p.max_output_tokens),
        temperature: num(p.temperature),
        topP: num(p.top_p),
      },
      record,
      "auto.ai.openai",
    ),
  streaming: (p) => p.stream === true,
  response: openaiResponse,
  stream: () => {
    let last: Json | undefined;
    return {
      observe(ev) {
        // response.created … response.completed / .failed / .incomplete carry the response.
        if (ev.response && typeof ev.type === "string" && ev.type.startsWith("response."))
          last = ev.response;
      },
      response: () => (last ? openaiResponse(last) : {}),
    };
  },
};

const openaiEmbeddings: Spec = {
  spanOptions: (p, record) =>
    embeddingsSpanOptions(
      { provider: "openai", model: str(p.model) ?? "unknown", input: p.input },
      record,
      "auto.ai.openai",
    ),
  streaming: () => false,
  response: (e) => ({ model: str(e.model), usage: { inputTokens: num(e.usage?.prompt_tokens) } }),
};

/** The parts of an OpenAI client that wrapOpenAI() instruments (any of them). */
export interface OpenAILike {
  chat?: { completions?: { create(...args: never[]): unknown } };
  responses?: { create(...args: never[]): unknown };
  embeddings?: { create(...args: never[]): unknown };
}

/**
 * Traces an OpenAI SDK client (or an OpenAI-compatible one): each
 * `chat.completions.create`, `responses.create` and `embeddings.create`
 * call, streaming or not, becomes a span with the model, tokens (cached
 * ones too) and finish reasons. For token counts on streamed chat
 * completions, ask for them with `stream_options: { include_usage: true }`.
 * Returns the client wrapped; the original is untouched.
 *
 * @example
 * const openai = wrapOpenAI(new OpenAI());
 */
export function wrapOpenAI<C extends OpenAILike>(client: C): C {
  return instrument(client, {
    "chat.completions.create": openaiChat,
    "responses.create": openaiResponses,
    "embeddings.create": openaiEmbeddings,
  });
}
