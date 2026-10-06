/**
 * Tracing: spans, sampling and trace propagation, as in the Python SDK. A
 * span started with no active span is a segment: the root of what this
 * process does for one request, task or page. Spans ended under a segment
 * are buffered with it and sent together when it ends, as one OTLP export
 * (fixwire-protocol §3). Traces cross services through the W3C
 * `traceparent` and `tracestate` headers (fixwire-protocol §9); `baggage`
 * passes through untouched, so a fleet mixing OpenTelemetry and Fixwire
 * shares one trace. Sampling follows the caller's decision; a new trace
 * decides from its id, alike in every service.
 *
 * The active span lives on the current scope, so it follows the runtime's
 * async context (AsyncLocalStorage on Node).
 */
import { getClient } from "./api.ts";
import type { ClientOptions } from "./client.ts";
import { keyValues, nanos } from "./otlp.ts";
import type { Redactor } from "./redact.ts";
import { getCurrentScope, getIsolationScope, withScope } from "./scope.ts";
import { ahead, clip } from "./serialize.ts";

/** Spans kept per segment; past it they're dropped and counted. */
export const MAX_SPANS_PER_SEGMENT = 1000;
/** Attributes kept per span; past it new ones are dropped. */
export const MAX_ATTRIBUTES = 128;
/** Recorded AI content: these attributes are kept to MAX_AI_CONTENT bytes instead of maxValueLength. */
export const MAX_AI_CONTENT = 16_384;
export const AI_CONTENT = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);
/** Spans in one request. */
const MAX_SPANS_PER_REQUEST = 100;

/** Attributes' keys and string values cut to `size(limit)`, AI content to `size(MAX_AI_CONTENT)`. */
function cut(a: Record<string, unknown>, limit: number, size: (limit: number) => number): void {
  for (const k of Object.keys(a)) {
    const v = a[k];
    delete a[k];
    a[clip(k, size(limit))] =
      typeof v === "string" ? clip(v, size(AI_CONTENT.has(k) ? MAX_AI_CONTENT : limit)) : v;
  }
}

/** What a span attribute may hold. */
export type SpanAttributeValue = string | number | boolean;
/** Span attributes; null and undefined values are ignored. */
export type SpanAttributes = Record<string, SpanAttributeValue | null | undefined>;
/** A span failed ("error") or not ("ok"). */
export type SpanStatus = "ok" | "error";

/** Options of startSpan() and startInactiveSpan(). */
export interface StartSpanOptions {
  /** What the span does, e.g. `"GET /orders/:id"` or `"SELECT orders"`. */
  name: string;
  /** Its kind: `"http.server"`, `"http.client"`, `"db.query"`, `"task"`, … */
  op?: string;
  attributes?: SpanAttributes;
  /** What created it (default `"manual"`); integrations use `"auto.<area>.<name>"`. */
  origin?: string;
  /** Unix seconds (default: now). */
  startTime?: number;
  /** Start a new segment even inside an active span (a background job, a page load). */
  forceSegment?: boolean;
}

/** What tracesSampler receives. */
export interface SamplingContext {
  /** The segment's name, e.g. `"GET /orders/:id"`. */
  name: string;
  attributes: Record<string, SpanAttributeValue>;
  /** The caller's decision, when the trace was continued. */
  parentSampled: boolean | undefined;
}

/** The trace a request, task or page belongs to: continued from incoming headers, or new. */
export interface PropagationContext {
  traceId: string;
  /** The caller's span, when continued. */
  parentSpanId?: string;
  /** The caller's sampling decision, if it made one. */
  sampled?: boolean;
  /**
   * The trace id's random part (its last 56 bits) as a fraction of 1: a
   * rate r keeps the trace when this is at least 1 − r, as OpenTelemetry's
   * consistent probability sampling does, so every service decides alike.
   */
  sampleRand: number;
  /** Our own span id for errors outside any span. */
  spanId: string;
  /** The caller's `tracestate`, passed on unchanged. */
  tracestate?: string;
  /** The caller's `baggage`, passed on unchanged. */
  baggage?: string;
  /** Joined from incoming headers: segments in this scope belong to that trace. */
  continued: boolean;
}

/** Headers to read a trace from: a plain object (Node's `req.headers`) or anything with `get` (fetch `Headers`). */
export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

/** W3C's traceparent, version 00: exactly four fields, lower-case hex. */
const TRACEPARENT = /^[ \t]*00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})[ \t]*$/;

const perf = (globalThis as { performance?: { timeOrigin?: number; now(): number } }).performance;
/** Unix seconds with sub-millisecond precision where the runtime has a monotonic clock. */
const now = (): number =>
  perf?.timeOrigin ? (perf.timeOrigin + perf.now()) / 1000 : Date.now() / 1000;

function randomHex(bytes: number): string {
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  const a = new Uint8Array(bytes);
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = (Math.random() * 256) | 0;
  let s = "";
  for (const b of a) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A new 32-hex-digit trace id. */
export const newTraceId = (): string => randomHex(16);
/** A new 16-hex-digit span id. */
export const newSpanId = (): string => randomHex(8);

/** A trace id's random part (its last 56 bits) as a fraction of 1. */
const randOf = (traceId: string): number => Number.parseInt(traceId.slice(18), 16) / 2 ** 56;

/** A trace of its own (nothing continued). */
export function newPropagationContext(): PropagationContext {
  const traceId = newTraceId();
  return { traceId, sampleRand: randOf(traceId), spanId: newSpanId(), continued: false };
}

function header(headers: HeaderSource, name: string): string | undefined {
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const v: unknown = get.call(headers, name);
    return typeof v === "string" ? v : undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    const first: unknown = Array.isArray(v) ? v[0] : v;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

/**
 * A caller's tracestate (at most 512 bytes) or baggage (8192), to pass on
 * whole: a longer one, or one with a control character but tab (W3C's list
 * whitespace), is not passed on at all, so it can't oversize or break
 * outgoing requests.
 */
const passable = (v: string | undefined, limit: number): string | undefined =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
  v && new TextEncoder().encode(v).length <= limit && !/[\0-\b\n-\x1f\x7f-\x9f]/.test(v)
    ? v
    : undefined;

/** The trace of incoming headers (traceparent, tracestate, baggage), or a new one. */
export function propagationFromHeaders(headers: HeaderSource): PropagationContext {
  const ctx = newPropagationContext();
  const m = TRACEPARENT.exec(header(headers, "traceparent") ?? "");
  if (m && !/^0+$/.test(m[1] as string) && !/^0+$/.test(m[2] as string)) {
    ctx.continued = true;
    ctx.traceId = m[1] as string;
    ctx.parentSpanId = m[2];
    ctx.sampled = (Number.parseInt(m[3] as string, 16) & 1) === 1;
    ctx.sampleRand = randOf(ctx.traceId);
    ctx.tracestate = passable(header(headers, "tracestate"), 512);
  }
  ctx.baggage = passable(header(headers, "baggage"), 8192);
  return ctx;
}

/** OTLP span kinds, from the operation: server, client, producer, consumer, else internal. */
const kindOf = (op = ""): number =>
  /^(http|rpc)\.server/.test(op)
    ? 2
    : /^(http|rpc)\.client|^db|^cache|^gen_ai\.(chat|embeddings)/.test(op)
      ? 3
      : op.startsWith("queue.publish")
        ? 4
        : op.startsWith("queue.process")
          ? 5
          : 1;

/** A span as OTLP JSON, its attributes still a plain map (the client redacts, then encodes them). */
export interface SpanJSON {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, SpanAttributeValue>;
  status: { code: number };
  flags: number;
}

/** How a span is made: startSpan() and startInactiveSpan() fill it in. */
export interface SpanInit extends StartSpanOptions {
  traceId: string;
  parentSpanId?: string;
  sampled: boolean;
  /** The segment it belongs to; none: it is a segment. */
  segment?: Span;
  /** Called with a sampled segment when it ends (the client queues it). */
  onSegmentEnd?: (segment: Span) => void;
}

/** A unit of work. Make one with startSpan() or startInactiveSpan(), not directly. */
export class Span {
  readonly traceId: string;
  readonly spanId: string = newSpanId();
  readonly parentSpanId: string | undefined;
  /** The root of this process's part of the trace (itself, for a segment). */
  readonly segment: Span;
  readonly sampled: boolean;
  name: string;
  op: string | undefined;
  origin: string;
  status: SpanStatus = "ok";
  readonly startTime: number;
  endTime: number | undefined;
  readonly attributes: Record<string, SpanAttributeValue> = {};
  private attributeCount = 0;
  private readonly buffer: Span[] = [];
  private dropped = 0;
  private open = 0;
  private idleListener: (() => void) | undefined;
  private readonly onSegmentEnd: ((segment: Span) => void) | undefined;

  constructor(init: SpanInit) {
    this.traceId = init.traceId;
    this.parentSpanId = init.parentSpanId;
    this.sampled = init.sampled;
    this.segment = init.segment ?? this;
    this.name = init.name;
    this.op = init.op;
    this.origin = init.origin ?? "manual";
    this.startTime = init.startTime ?? now();
    this.onSegmentEnd = init.onSegmentEnd;
    if (init.attributes) this.setAttributes(init.attributes);
    if (this.segment !== this) this.segment.open++;
  }

  /** True for a segment (no parent in this process). */
  get isSegment(): boolean {
    return this.segment === this;
  }

  /** Child spans not kept because the segment was full. */
  get droppedSpans(): number {
    return this.dropped;
  }

  /** Children started and not yet ended (segments only). */
  get openChildren(): number {
    return this.open;
  }

  /** Sampled and not ended: attributes still matter. */
  isRecording(): boolean {
    return this.sampled && this.endTime === undefined;
  }

  /** An attribute (null and undefined are ignored; past MAX_ATTRIBUTES, new keys are). */
  setAttribute(key: string, value: SpanAttributeValue | null | undefined): this {
    if (
      value !== null &&
      value !== undefined &&
      (Object.hasOwn(this.attributes, key) || this.attributeCount++ < MAX_ATTRIBUTES)
    )
      this.attributes[key] = value;
    return this;
  }

  setAttributes(values: SpanAttributes): this {
    for (const [k, v] of Object.entries(values)) this.setAttribute(k, v);
    return this;
  }

  /** Marks the span failed or not. Spans whose callback throws are marked failed already. */
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  updateName(name: string): this {
    this.name = name;
    return this;
  }

  /**
   * Called when a segment's last open child ends; integrations that end a
   * segment once its work is done (a page load) use it.
   */
  setIdleListener(fn: (() => void) | undefined): void {
    this.idleListener = fn;
  }

  /** Ends the span (default: now). Ending twice does nothing. */
  end(endTime?: number): void {
    if (this.endTime !== undefined) return;
    this.endTime = endTime ?? now();
    const seg = this.segment;
    if (seg !== this) {
      seg.open--;
      if (this.sampled) {
        if (seg.buffer.length < MAX_SPANS_PER_SEGMENT) seg.buffer.push(this);
        else seg.dropped++;
      }
      if (seg.open === 0) seg.idleListener?.();
      return;
    }
    if (this.sampled) this.onSegmentEnd?.(this);
  }

  /** A finished segment's spans, itself first. */
  spans(): Span[] {
    return [this, ...this.buffer];
  }

  /**
   * A finished segment's spans as OTLP, itself first, in batches of at most
   * MAX_SPANS_PER_REQUEST spans and `room` bytes of JSON; a span that can't
   * fit is left out. Names and attributes (URLs, queries, messages, and
   * their keys) are cut to what redaction reads, masked, then cut to `limit`
   * bytes, AI content to MAX_AI_CONTENT. (Here rather than in the client,
   * so pages that don't trace don't ship it.)
   */
  batches(limit: number, redactor: Redactor | undefined, room: number): object[][] {
    const out: object[][] = [];
    let batch: object[] = [];
    let bytes = 0;
    for (const s of this.spans()) {
      const j = s.toJSON();
      cut(j.attributes, limit, ahead);
      if (redactor) {
        redactor.walk(j.attributes);
        j.name = redactor.mask(clip(j.name, ahead(limit)))[0];
      }
      cut(j.attributes, limit, (n) => n);
      const span = { ...j, name: clip(j.name, limit), attributes: keyValues(j.attributes) };
      const n = new TextEncoder().encode(JSON.stringify(span)).length + 1;
      if (n > room) continue;
      if (batch.length === MAX_SPANS_PER_REQUEST || bytes + n > room) {
        out.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(span);
      bytes += n;
    }
    if (batch.length) out.push(batch);
    return out;
  }

  /** W3C `traceparent` value for this span. */
  toTraceparent(): string {
    return `00-${this.traceId}-${this.spanId}-${this.sampled ? "01" : "00"}`;
  }

  /**
   * The OTLP span. Flags: bit 8 says whether the parent is remote is known,
   * bit 9 that it is (a segment continuing a caller's trace), bit 0 sampled.
   */
  toJSON(): SpanJSON {
    const out: SpanJSON = {
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      kind: kindOf(this.op),
      startTimeUnixNano: nanos(this.startTime),
      endTimeUnixNano: nanos(this.endTime ?? now()),
      attributes: { ...this.attributes, "fixwire.origin": this.origin },
      status: { code: this.status === "error" ? 2 : 1 },
      flags: 0x100 | (this.isSegment && this.parentSpanId ? 0x200 : 0) | (this.sampled ? 1 : 0),
    };
    if (this.op) out.attributes["fixwire.op"] = this.op;
    if (this.parentSpanId) out.parentSpanId = this.parentSpanId;
    return out;
  }
}

/** Whether the options turn tracing on (a rate or a sampler). */
export function hasTracingEnabled(options: ClientOptions | undefined): boolean {
  return !!options && (options.tracesSampleRate !== undefined || !!options.tracesSampler);
}

/**
 * Whether to record a trace. A sampler decides first (it sees the caller's
 * decision as parentSampled); then the caller's decision; then the rate.
 * Rates are applied against the trace's sampleRand, so every service
 * decides alike.
 */
export function sample(
  options: ClientOptions,
  ctx: PropagationContext,
  name: string,
  attributes: Record<string, SpanAttributeValue>,
): boolean {
  if (options.tracesSampler) {
    let decision: number | boolean | undefined;
    try {
      decision = options.tracesSampler({ name, attributes, parentSampled: ctx.sampled });
    } catch {
      decision = undefined;
    }
    if (decision !== undefined) return ctx.sampleRand >= 1 - Number(decision);
  }
  if (ctx.sampled !== undefined) return ctx.sampled;
  const rate = options.tracesSampleRate;
  return rate !== undefined && ctx.sampleRand >= 1 - rate;
}

/** The current isolation scope's trace (created on first use). */
export function getPropagationContext(): PropagationContext {
  const iso = getIsolationScope();
  iso.propagation ??= newPropagationContext();
  return iso.propagation;
}

/**
 * Joins the trace of incoming headers (traceparent and tracestate; baggage
 * is kept to pass on) for the current isolation scope; without them, the
 * scope gets a trace of its own. Integrations call it per request; call it
 * yourself for queues or custom protocols, inside `withIsolationScope`.
 */
export function continueTrace(headers: HeaderSource): PropagationContext {
  const ctx = propagationFromHeaders(headers);
  getIsolationScope().propagation = ctx;
  return ctx;
}

/** The span active in this async context, if any. */
export function getActiveSpan(): Span | undefined {
  return getCurrentScope().span;
}

function createSpan(options: StartSpanOptions): Span {
  const parent = options.forceSegment ? undefined : getActiveSpan();
  if (parent) {
    return new Span({
      ...options,
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      sampled: parent.sampled,
      segment: parent.segment,
    });
  }
  let ctx = getPropagationContext();
  // A local root gets its own trace and decision; errors outside it keep the scope's trace.
  if (!ctx.continued) ctx = newPropagationContext();
  const client = getClient();
  const attributes: Record<string, SpanAttributeValue> = {};
  for (const [k, v] of Object.entries(options.attributes ?? {})) {
    if (v !== null && v !== undefined) attributes[k] = v;
  }
  const sampled =
    !!client?.enabled &&
    hasTracingEnabled(client.options) &&
    sample(client.options, ctx, options.name, attributes);
  return new Span({
    ...options,
    traceId: ctx.traceId,
    parentSpanId: ctx.parentSpanId,
    sampled,
    onSegmentEnd: sampled ? (segment) => client?.captureSegment(segment) : undefined,
  });
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && typeof (v as { then?: unknown }).then === "function";

/**
 * Runs `cb` in a new span, active inside it (nested spans become its
 * children), and ends it when `cb` returns or its promise settles. A throw
 * or rejection marks the span failed and is passed on.
 *
 * @example
 * const order = await startSpan({ name: "load order", op: "db.query" }, () => db.orders.get(id));
 */
export function startSpan<T>(options: StartSpanOptions, cb: (span: Span) => T): T {
  return withScope((scope) => {
    const span = createSpan(options);
    scope.span = span;
    let result: T;
    try {
      result = cb(span);
    } catch (e) {
      span.setStatus("error").end();
      throw e;
    }
    if (isThenable(result)) {
      return Promise.resolve(result).then(
        (v) => {
          span.end();
          return v;
        },
        (e: unknown) => {
          span.setStatus("error").end();
          throw e;
        },
      ) as T;
    }
    span.end();
    return result;
  });
}

/** A span that is not made active: end it yourself with `span.end()`. */
export function startInactiveSpan(options: StartSpanOptions): Span {
  return createSpan(options);
}

/** Runs `cb` with `span` active (nested spans become its children). */
export function withActiveSpan<T>(span: Span | undefined, cb: () => T): T {
  return withScope((scope) => {
    scope.span = span;
    return cb();
  });
}

/** Options of traceHeaders(). */
export interface TraceHeadersOptions {
  /** The span the receiver continues from (default: the active span). */
  span?: Span;
}

/**
 * Headers that carry the current trace to another service: `traceparent`,
 * the caller's `tracestate` when this trace continues theirs, and the
 * caller's `baggage`.
 *
 * @example
 * await fetch(url, { headers: { ...traceHeaders() } });
 */
export function traceHeaders(options: TraceHeadersOptions = {}): Record<string, string> {
  const span = options.span ?? getActiveSpan();
  const ctx = getPropagationContext();
  const traceId = span ? span.traceId : ctx.traceId;
  const sampled = span ? span.sampled : ctx.sampled;
  const out: Record<string, string> = {
    traceparent: `00-${traceId}-${span ? span.spanId : ctx.spanId}-${sampled ? "01" : "00"}`,
  };
  if (ctx.traceId === traceId && ctx.tracestate) out.tracestate = ctx.tracestate;
  if (ctx.baggage) out.baggage = ctx.baggage;
  return out;
}

/** The current trace's `traceparent` and `tracestate`, e.g. for a page or a message. */
export function getTraceData(): { traceparent: string; tracestate?: string } {
  const { traceparent = "", tracestate } = traceHeaders();
  return tracestate ? { traceparent, tracestate } : { traceparent };
}

const attr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * `<meta>` tags for a server-rendered page, so the browser SDK continues
 * this request's trace: put them in the page's `<head>`.
 */
export function getTraceMetaTags(): string {
  return Object.entries(getTraceData())
    .map(([k, v]) => `<meta name="${k}" content="${attr(v)}"/>`)
    .join("\n");
}

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
};

/**
 * Whether trace headers may go to `url` (tracePropagationTargets), compared
 * without its user info, query and fragment: a target with "://" matches
 * URLs starting with it; one starting with "/" requests to the page's own
 * origin whose path starts with it; any other is a host, with a port if it
 * has one, matching that host and its subdomains; a RegExp is searched for.
 * Without the option: requests to the page's own origin in browsers, none
 * elsewhere.
 */
export function shouldPropagate(url: string): boolean {
  const targets = getClient()?.options.tracePropagationTargets;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  let u: URL;
  try {
    // A path is the page's ("//host" and "/\host" are other hosts, as browsers read them).
    u = new URL(url, origin);
  } catch {
    return false; // relative, outside a page
  }
  const own = !!origin && u.origin === origin;
  if (!targets) return own;
  const compared = `${u.protocol}//${u.host}${u.pathname}`;
  const host = u.hostname.toLowerCase();
  const port = u.port || DEFAULT_PORTS[u.protocol];
  return targets.some((t) => {
    if (typeof t !== "string") return compared.search(t) >= 0;
    if (t.includes("://")) return compared.startsWith(t);
    if (t.startsWith("/")) return own && u.pathname.startsWith(t);
    const lower = t.toLowerCase();
    const [, name = lower, wanted] = /^(\[.*\]|[^:]*)(?::(\d+))?$/.exec(lower) ?? [];
    return !!name && (!wanted || wanted === port) && (host === name || host.endsWith(`.${name}`));
  });
}
