/**
 * The client. Capturing is synchronous and cheap:
 *
 *   build → scopes → fingerprint → budgets ─► drop
 *         → sampleRate ─► drop → processors → beforeSend → queue
 *
 * Encoding (enrichment such as context lines, normalize, REDACT, OTLP or
 * JSON, size guard, compression) and sending run asynchronously, and only
 * for what will be sent. Redaction runs after beforeSend, so nothing a
 * callback adds escapes it. Each kind of data has its endpoint
 * (fixwire-protocol): errors, messages and spans travel as OTLP/HTTP JSON,
 * sessions, feedback and check-ins as Fixwire JSON.
 */
import { Delivery, type Outbound } from "./delivery.ts";
import { type Dsn, parseDsn, SDK_VERSION } from "./dsn.ts";
import { debugImages, eventFromUnknown } from "./eventbuilder.ts";
import { fingerprint, Limiter, type RateLimitOptions } from "./limiter.ts";
import {
  eventRecord,
  type KeyValue,
  logsRequest,
  type ResourceInfo,
  tracesRequest,
} from "./otlp.ts";
import { Redactor } from "./redact.ts";
import {
  applyScopes,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  type Scope,
} from "./scope.ts";
import { ahead, clip, clipStrings, normalize } from "./serialize.ts";
import {
  hashIdentity,
  identity,
  type PageSession,
  type RequestSession,
  SessionAggregates,
} from "./sessions.ts";
import {
  getActiveSpan,
  getPropagationContext,
  type SamplingContext,
  type Span,
} from "./tracing.ts";
import type {
  Breadcrumb,
  CheckIn,
  Event,
  EventHint,
  Exception,
  Feedback,
  Mechanism,
  MonitorConfig,
  SeverityLevel,
  StackFrame,
  StackParser,
} from "./types.ts";

/** One POST to the ingest. */
export interface TransportRequest {
  url: string;
  body: string | Uint8Array;
  headers: Record<string, string>;
}

/** What the client needs from a response: the status and the rate-limit headers. */
export interface TransportResponse {
  status: number;
  header(name: string): string | null;
}

/** Sends requests. Replace it (the `transport` option) for proxies or tests. */
export interface Transport {
  /** Resolves with the response, or rejects on a network error (the request is retried). */
  send(request: TransportRequest): Promise<TransportResponse>;
}

/** Makes the offline store for a client (the `offline` option, or a runtime's default). */
export type SpoolFactory = (options: ClientOptions, dsn: Dsn) => Spool | undefined;

/** An encoded request, as the offline store keeps it. */
export interface StoredRequest {
  /** Relative to the DSN's base URL, e.g. `/v1/logs`. */
  path: string;
  contentType: string;
  body: string | Uint8Array;
  headers: Record<string, string>;
  /** The kind of data, for rate limits. */
  category: string;
}

/** An offline store for encoded requests (opt-in: the `offline` option). */
export interface Spool {
  put(request: StoredRequest): Promise<string | number | undefined>;
  delete(id: string | number): Promise<void>;
  /** What an earlier run (or an outage) left, for this process to send. */
  load(): Promise<(StoredRequest & { id: string | number })[]>;
}

/**
 * Hooks the SDK into a runtime or library. `setup` runs once per client;
 * integrations that install global handlers should do so once per process
 * and look up the current client when they fire.
 */
export interface Integration {
  /** Unique: an integration in `integrations` replaces a default one of the same name. */
  name: string;
  setup(client: Client): void;
}

/**
 * The integrations a client installs: the defaults, then the custom ones;
 * a custom integration replaces a default one of the same name.
 */
export function resolveIntegrations(
  defaults: Integration[],
  custom: Integration[] = [],
): Integration[] {
  const own = Array.isArray(custom) ? custom : [];
  const names = new Set(own.map((i) => i?.name));
  return [...defaults.filter((i) => !names.has(i.name)), ...own];
}

/** Options of `init()` and of `new Client()`. */
export interface ClientOptions {
  /** Where data goes: `https://<key>@<host>`. Without it the SDK does nothing. */
  dsn?: string;
  /** Your version, e.g. `"web@1.4.0"`: issues show the release they started and regressed in. */
  release?: string;
  /** e.g. `"production"` (default) or `"staging"`. */
  environment?: string;
  /** The build of a release, when one release ships several (e.g. per platform). */
  dist?: string;
  /** The host's name, on server runtimes. */
  serverName?: string;
  /** Share of error events sent (0–1, default 1), applied after the budgets. */
  sampleRate?: number;
  /** Breadcrumbs kept per scope (default 100). */
  maxBreadcrumbs?: number;
  /**
   * Longest string sent, in bytes of UTF-8 (default 1024): longer ones are
   * cut on a character boundary and end in "...". Recorded AI content gets
   * 16 kB. Secrets are masked before the cut.
   */
  maxValueLength?: number;
  /** Frames sent per error, the newest kept (default 100). */
  maxStackFrames?: number;
  /** Requests waiting to be sent, and as many waiting for a retry (default 100); past that, new data is dropped. */
  maxQueue?: number;
  /**
   * The last word on an event: return it (changed or not), or null to drop
   * it. Runs before redaction, so what it adds is masked too.
   */
  beforeSend?: (event: Event, hint: EventHint) => Event | null;
  /** Changes a breadcrumb, or drops it by returning null. */
  beforeBreadcrumb?: (crumb: Breadcrumb, hint?: Record<string, unknown>) => Breadcrumb | null;
  /** Send the user's IP address (proxy headers) with requests (default false). */
  sendDefaultPii?: boolean;
  /** Mask secrets and personal data on the device, with the server's rules (default true). */
  redact?: boolean;
  /** Replaces the default key fragments ("password", "token", …) whose values are filtered. */
  sensitiveKeys?: string[];
  /** Budgets per issue and overall, so a crash loop costs a few events and a count. */
  rateLimit?: RateLimitOptions;
  /** Added to (or replacing, by name) the default integrations. */
  integrations?: Integration[];
  /** Install the runtime's default integrations (default true). */
  defaultIntegrations?: boolean;
  /** Replaces the runtime's HTTP transport. */
  transport?: Transport;
  /**
   * Keep requests until the server has them, across outages and restarts.
   * On Node: `true` (a cache directory) or a directory path. In browsers:
   * the IndexedDB store, imported separately so pages without it don't ship
   * it: `offline: makeIndexedDbSpool` from `@fixwire/browser/offline`. A store
   * factory of your own works anywhere. Off by default.
   */
  offline?: boolean | string | SpoolFactory;
  /** Log the SDK's own problems to the console. */
  debug?: boolean;
  /**
   * Share of traces recorded (0–1). Unset (and no tracesSampler): tracing
   * is off, though errors still carry the incoming trace's id.
   */
  tracesSampleRate?: number;
  /**
   * Decides per trace: a rate (0–1), true/false, or undefined to fall back
   * to the caller's decision and then tracesSampleRate.
   */
  tracesSampler?: (context: SamplingContext) => number | boolean | undefined;
  /**
   * Outgoing requests that carry trace headers, by their URL without user
   * info, query and fragment: a string with "://" matches URLs starting
   * with it (`"https://api.example.com/v2"`); one starting with "/" requests
   * to the page's own origin whose path starts with it (browsers); any other
   * string is a host, with a port if it has one, matching that host and its
   * subdomains (`"example.com"` matches `api.example.com`, not
   * `badexample.com`); a RegExp is searched for in the URL. Default: the
   * page's own origin in browsers, nothing on servers.
   */
  tracePropagationTargets?: (string | RegExp)[];
  /**
   * Record AI content (prompts, outputs, tool arguments and results) on
   * gen_ai spans, bounded and redacted. Default false: only models, tokens,
   * timings, errors and tool-argument hashes are sent.
   */
  recordAiContent?: boolean;
  /**
   * Release health: count sessions (a page load in browsers, a request on
   * servers) so each release gets crash-free rates (default true). Needs
   * `release`. Sessions carry no content, and their user only as a hash
   * made on this device.
   */
  autoSessionTracking?: boolean;
}

/** What a runtime (browser, Node) provides. */
export interface Platform {
  /** `fixwire.javascript.<runtime>`. */
  sdkName: string;
  /** OpenTelemetry's telemetry.sdk.language: `webjs` in browsers, else `nodejs`. */
  language: string;
  /** The app's service.name, when the runtime knows it (OTEL_SERVICE_NAME). */
  serviceName?: string;
  stackParser: StackParser;
  globalPerMinute: number;
  maxInFlight: number;
  makeTransport(): Transport;
  /** Enrichment before encoding, e.g. context lines (may read files). */
  enrich?(event: Event): Promise<void>;
  /** Compression: the body and the headers that say so. */
  compress?(body: string): Promise<{ body: string | Uint8Array; headers: Record<string, string> }>;
  /** Event defaults such as contexts.runtime. */
  defaults?(event: Event): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** The offline store for `offline: true` (Node: files). */
  makeSpool?: SpoolFactory;
}

/** An error or message is at most this much JSON. */
const MAX_EVENT_BYTES = 1 << 20;
/** A request of spans is at most this much JSON. */
const MAX_REQUEST_BYTES = 5 << 20;
/** Aggregates in one sessions request. */
const MAX_AGGREGATES = 5000;
/** Ids and the app's own configuration: cut, but not redacted. */
const REDACT_SKIP = [
  "event_id",
  "timestamp",
  "platform",
  "level",
  "sdk",
  "release",
  "dist",
  "environment",
] as const;

const now = (): number => Date.now() / 1000;
const utf8 = (s: string): number => new TextEncoder().encode(s).length;

function uuid4(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Encodes something captured into its requests, or undefined when it can't be. */
type Encode = () => Promise<Outbound | Outbound[] | undefined>;

/** Request sessions are sent this often (seconds), and on flush. */
const SESSIONS_INTERVAL = 60;

const iso = (t: number): string => new Date(t * 1000).toISOString();

/**
 * Captures events and delivers them. Most apps create one with `init()`;
 * create one directly to report to a second project, or without globals.
 */
export class Client {
  readonly options: ClientOptions;
  readonly dsn: Dsn | undefined;
  readonly platform: Platform;
  readonly delivery: Delivery;
  private readonly limiter!: Limiter;
  private readonly redactor: Redactor | undefined;
  private readonly transport: Transport | undefined;
  /** Inside a callback or the SDK's own logging: breadcrumbs logged now are skipped. */
  private capturing = 0;
  private queue: Encode[] = [];
  private inFlight = 0;
  private pumping = false;
  private timer: unknown;
  private closed = false;
  private waiters: (() => void)[] = [];
  private readonly spool: Spool | undefined;
  private spoolLoaded = false;
  private session: PageSession | undefined;
  private readonly aggregates = new SessionAggregates();
  private sessionTimer: unknown;
  private sessionsDue = false;

  constructor(options: ClientOptions, platform: Platform) {
    this.options = options;
    this.platform = platform;
    this.delivery = new Delivery(options.maxQueue);
    // A broken DSN or option must not stop the app: the SDK stays off.
    try {
      this.dsn = options.dsn ? parseDsn(options.dsn) : undefined;
      this.limiter = new Limiter(options.rateLimit ?? {}, platform.globalPerMinute);
      this.redactor =
        options.redact === false
          ? undefined
          : new Redactor({ sensitiveKeys: options.sensitiveKeys });
      this.transport = this.dsn ? (options.transport ?? platform.makeTransport()) : undefined;
      getIsolationScope().maxBreadcrumbs = options.maxBreadcrumbs ?? 100;
      const factory = typeof options.offline === "function" ? options.offline : platform.makeSpool;
      this.spool = this.dsn && options.offline ? factory?.(options, this.dsn) : undefined;
      if (this.dsn && options.offline && !factory)
        this.warn(
          "offline: true needs a store here; pass offline: makeIndexedDbSpool from @fixwire/browser/offline",
        );
    } catch (e) {
      this.dsn = undefined;
      console.warn("[fixwire] not started:", e instanceof Error ? e.message : e);
    }
    // Deliver what an earlier run left.
    if (this.spool) this.schedule();
  }

  /** The longest string sent (bytes of UTF-8). */
  private get limit(): number {
    return this.options.maxValueLength ?? 1024;
  }

  /** Frames sent per error. */
  private get maxFrames(): number {
    return this.options.maxStackFrames || 100;
  }

  /** False without a DSN or after close(): captures are then no-ops. */
  get enabled(): boolean {
    return !!this.dsn && !this.closed;
  }

  // Capturing.

  /**
   * Reports an error (or any thrown value). Returns the event id, or
   * undefined when it was dropped (budgets, sampling, beforeSend) or
   * already reported.
   */
  captureException(exception: unknown, hint: EventHint = {}): string | undefined {
    if (!this.enabled) return undefined;
    const mechanism: Mechanism = hint.mechanism ?? { type: "generic", handled: true };
    let event: Event;
    // Getters and proxies may throw: that must not reach the caller.
    try {
      // The same error object reported twice (explicitly, then by a handler) is sent once.
      if (
        exception &&
        typeof exception === "object" &&
        (exception as { __fixwire_captured__?: boolean }).__fixwire_captured__
      )
        return undefined;
      const syntheticException = hint.syntheticException ?? new Error("Fixwire syntheticException");
      event = eventFromUnknown(
        this.platform.stackParser,
        exception,
        { ...hint, syntheticException },
        mechanism,
        ahead(this.limit),
        this.maxFrames,
      );
    } catch (e) {
      this.warn("could not prepare an event", e);
      return undefined;
    }
    if (mechanism.handled === false) event.level = "fatal";
    const id = this.captureEvent(event, { ...hint, originalException: exception });
    if (id && exception && typeof exception === "object") {
      try {
        Object.defineProperty(exception, "__fixwire_captured__", {
          value: true,
          enumerable: false,
        });
      } catch {
        // frozen objects stay as they are
      }
    }
    return id;
  }

  /** Reports a message (default level "info"). Returns the event id, or undefined when dropped. */
  captureMessage(
    message: string,
    level: SeverityLevel = "info",
    hint: EventHint = {},
  ): string | undefined {
    if (!this.enabled) return undefined;
    return this.captureEvent({ message, level }, hint);
  }

  /** Sends an event you built. Returns its id, or undefined when dropped. */
  captureEvent(event: Event, hint: EventHint = {}): string | undefined {
    if (!this.enabled) return undefined;
    let prepared: Event | null;
    this.capturing++;
    try {
      this.markSession(event);
      prepared = this.prepare(event, hint);
    } catch (e) {
      this.warn("could not prepare an event", e);
      return undefined;
    } finally {
      this.capturing--;
    }
    if (!prepared) return undefined;
    this.enqueue(() => this.encodeEvent(prepared));
    return prepared.event_id;
  }

  /**
   * Sends feedback: a rating of an AI answer and/or what someone said about
   * a crash. Feedback isn't sampled or rate limited, and skips beforeSend
   * (redaction still applies). Returns its id, or undefined when it holds
   * neither a message nor a rating.
   *
   * @example
   * // The backend returned the agent run's trace id with the answer.
   * client.captureFeedback({ score: -1, traceId: answer.traceId, message: "Wrong order refunded" });
   */
  captureFeedback(feedback: Feedback): string | undefined {
    if (!this.enabled) return undefined;
    const message = typeof feedback.message === "string" ? feedback.message.trim() : "";
    const score =
      typeof feedback.score === "number" && Number.isFinite(feedback.score)
        ? Math.max(-1, Math.min(1, feedback.score))
        : 0;
    if (!message && score === 0) return undefined;
    const o = this.options;
    // The person who gave it, as the scopes know them.
    const user = {
      ...getGlobalScope().user,
      ...getIsolationScope().user,
      ...getCurrentScope().user,
    };
    // What they said and who they are are redacted like events, then cut.
    const said = clipStrings(
      {
        message,
        name: user.username,
        email: user.email,
        url: feedback.url ?? (globalThis as { location?: { href?: string } }).location?.href,
      },
      ahead(this.limit),
    ) as Record<string, unknown>;
    this.redactor?.walk(said);
    const id = uuid4();
    const body = {
      feedback_id: id,
      ...said,
      score: score || undefined,
      event_id: feedback.eventId,
      trace_id: feedback.traceId ?? getActiveSpan()?.traceId ?? getPropagationContext().traceId,
      source: feedback.source ?? "api",
      release: o.release,
      environment: o.environment ?? "production",
      timestamp: now(),
      sdk: { name: this.platform.sdkName, version: SDK_VERSION },
    };
    this.enqueue(() => this.json("/v1/feedback", "feedback", body));
    return id;
  }

  /**
   * Reports a scheduled job's run to its monitor: `in_progress` when it
   * starts, then `ok` or `error` with the id this returned. A monitor
   * config creates or updates the monitor. Returns the check-in's id.
   *
   * @example
   * const id = client.captureCheckIn({ monitorSlug: "nightly-report", status: "in_progress" });
   * await report();
   * client.captureCheckIn({ monitorSlug: "nightly-report", status: "ok", checkInId: id });
   */
  captureCheckIn(checkIn: CheckIn, monitorConfig?: MonitorConfig): string | undefined {
    if (!this.enabled) return undefined;
    const id = checkIn.checkInId ?? uuid4();
    const c = monitorConfig;
    const body = {
      check_in_id: id,
      status: checkIn.status,
      duration: checkIn.duration,
      environment: this.options.environment ?? "production",
      monitor_config: c && {
        schedule: { ...c.schedule }, // a copy: its strings are cut
        checkin_margin: c.checkinMargin,
        max_runtime: c.maxRuntime,
        timezone: c.timezone,
      },
    };
    this.enqueue(() =>
      this.json(
        `/v1/check-ins/${encodeURIComponent(clip(checkIn.monitorSlug, this.limit))}`,
        "check_in",
        body,
      ),
    );
    return id;
  }

  /** Queues a finished, sampled segment and its spans (startSpan calls it). */
  captureSegment(segment: Span): void {
    if (!this.enabled) return;
    this.enqueue(() => this.encodeSegment(segment));
  }

  /** Records a breadcrumb, through beforeBreadcrumb, on `scope` (default: the isolation scope). */
  addBreadcrumb(crumb: Breadcrumb, hint?: Record<string, unknown>, scope?: Scope): void {
    // What is logged from a callback (beforeBreadcrumb, beforeSend), and the
    // SDK's own lines, are no breadcrumbs.
    if (this.capturing) return;
    this.capturing++;
    try {
      let c: Breadcrumb | null = { timestamp: now(), ...crumb };
      if (this.options.beforeBreadcrumb) {
        try {
          c = this.options.beforeBreadcrumb(c, hint);
        } catch (e) {
          this.warn("beforeBreadcrumb failed", e);
        }
      }
      if (c) (scope ?? getIsolationScope()).addBreadcrumb(c);
    } finally {
      this.capturing--;
    }
  }

  private prepare(event: Event, hint: EventHint): Event | null {
    const o = this.options;
    event.event_id ??= uuid4();
    event.timestamp ??= now();
    event.level ??= "error";
    if (o.release && !event.release) event.release = o.release;
    event.environment ??= o.environment ?? "production";
    if (o.dist && !event.dist) event.dist = o.dist;
    if (o.serverName && !event.server_name) event.server_name = o.serverName;
    const processors = applyScopes(event, o.maxBreadcrumbs ?? 100);
    this.platform.defaults?.(event);
    const span = getActiveSpan();
    if (!event.contexts?.trace) {
      const ctx = getPropagationContext();
      const trace: Record<string, unknown> = span
        ? { trace_id: span.traceId, span_id: span.spanId }
        : { trace_id: ctx.traceId, span_id: ctx.spanId };
      const parent = span ? span.parentSpanId : ctx.parentSpanId;
      if (parent) trace.parent_span_id = parent;
      if (span?.op) trace.op = span.op;
      event.contexts = { ...event.contexts, trace };
    }

    const [allowed, suppressed] = this.limiter.allow(fingerprint(event), now());
    if (!allowed) return null;
    if (o.sampleRate !== undefined && o.sampleRate < 1 && Math.random() >= o.sampleRate)
      return null;
    let e: Event | null = event;
    for (const p of processors) {
      try {
        e = p(e, hint);
      } catch (err) {
        this.warn("an event processor failed", err);
      }
      if (!e) return null;
    }
    if (o.beforeSend) {
      try {
        e = o.beforeSend(e, hint);
      } catch (err) {
        this.warn("beforeSend failed; sending the event unchanged", err);
      }
      if (!e) return null;
    }
    // No integration named it: the segment's name, when in one.
    if (!e.transaction && span) e.transaction = span.segment.name;
    if (suppressed) {
      e.contexts ??= {};
      e.contexts.fixwire = { ...e.contexts.fixwire, suppressed };
    }
    return e;
  }

  // Sessions (release health).

  private sessionsOn(): boolean {
    return this.enabled && this.options.autoSessionTracking !== false && !!this.options.release;
  }

  /** A /v1/sessions body. */
  private sessions(body: Record<string, unknown>): Record<string, unknown> {
    return {
      sdk: { name: this.platform.sdkName, version: SDK_VERSION },
      release: this.options.release,
      environment: this.options.environment ?? "production",
      ...body,
    };
  }

  /** Starts a page's session (browsers do on init). */
  startSession(): void {
    if (!this.sessionsOn()) return;
    this.session = {
      sid: uuid4(),
      started: now(),
      status: "ok",
      errors: 0,
      init: true,
      ended: false,
    };
    this.queueSession();
  }

  /** Ends the page's session: exited, unless it already crashed. */
  endSession(): void {
    const s = this.session;
    if (!s || s.ended) return;
    if (s.status === "ok") s.status = "exited";
    s.ended = true;
    this.queueSession();
  }

  private queueSession(): void {
    const s = this.session;
    if (!s) return;
    const t = now();
    const update: Record<string, unknown> = {
      sid: s.sid,
      init: s.init,
      started: iso(s.started),
      timestamp: iso(t),
      status: s.status,
      errors: s.errors,
      duration: Math.max(0, t - s.started),
    };
    s.init = false;
    const user = identity(getIsolationScope().user ?? getGlobalScope().user);
    this.enqueue(async () => {
      update.did = await hashIdentity(user);
      const agent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
      return this.json(
        "/v1/sessions",
        "session",
        this.sessions({ user_agent: agent, sessions: [update] }),
      );
    });
  }

  /**
   * Starts the session of the request (or invocation) `scope` serves;
   * call the returned function once it ends. Requests are counted per
   * minute and user and sent about every minute, and on flush().
   */
  startRequestSession(scope: Scope): () => void {
    if (!this.sessionsOn()) return () => {};
    const session: RequestSession = { status: "ok" };
    scope.requestSession = session;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.aggregates.record(session.status, identity(scope.user), now());
      if (this.sessionTimer === undefined) {
        this.sessionTimer = this.platform.setTimer(() => {
          this.sessionTimer = undefined;
          this.sessionsDue = true;
          this.schedule();
        }, SESSIONS_INTERVAL * 1000);
      }
    };
  }

  /** An error marks the request's session errored (crashed if unhandled) and counts on the page's. */
  private markSession(event: Event): void {
    const values = event.exception?.values ?? [];
    if (!values.length && event.level !== "error" && event.level !== "fatal") return;
    const crashed = values.some((v) => v.mechanism?.handled === false);
    const rs = getIsolationScope().requestSession;
    if (rs) rs.status = crashed ? "crashed" : rs.status === "ok" ? "errored" : rs.status;
    const s = this.session;
    if (s && !s.ended) {
      s.errors++;
      if (crashed) {
        s.status = "crashed";
        s.ended = true;
        this.queueSession();
      }
    }
  }

  private async sendAggregates(): Promise<void> {
    try {
      const all = await this.aggregates.take();
      for (let i = 0; i < all.length; i += MAX_AGGREGATES) {
        const aggregates = all.slice(i, i + MAX_AGGREGATES);
        this.offer(await this.json("/v1/sessions", "session", this.sessions({ aggregates })));
      }
    } catch (e) {
      this.warn("could not send sessions", e);
    }
  }

  // Delivery.

  private enqueue(encode: Encode): void {
    // While encoding lags (spans of every request at a high rate), as many
    // wait as the delivery queue holds; past that, new ones are dropped.
    if (this.queue.length < (this.options.maxQueue ?? 100)) this.queue.push(encode);
    else this.warn("the queue is full: data dropped");
    this.schedule();
  }

  /** Queues a request for sending, unless the queue is full. */
  private offer(out: Outbound): void {
    if (!this.delivery.offer(out)) this.warn("the queue is full: data dropped");
  }

  private schedule(delayMs = 0): void {
    if (this.timer !== undefined) this.platform.clearTimer(this.timer);
    this.timer = this.platform.setTimer(() => {
      this.timer = undefined;
      void this.pump();
    }, delayMs);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      if (this.spool && !this.spoolLoaded) {
        this.spoolLoaded = true;
        try {
          for (const s of await this.spool.load())
            this.delivery.offer({ ...s, attempts: 0, notBefore: 0, spoolId: s.id });
        } catch (e) {
          this.warn("could not read the offline spool", e);
        }
      }
      while (this.queue.length) {
        const batch = this.queue;
        this.queue = [];
        for (const encode of batch) {
          let outs: Outbound | Outbound[] | undefined;
          try {
            outs = await encode();
          } catch (e) {
            this.warn("could not encode a request", e);
          }
          for (const out of outs ? [outs].flat() : []) {
            if (this.spool) {
              try {
                const { path, contentType, body, headers = {}, category } = out;
                out.spoolId = await this.spool.put({ path, contentType, body, headers, category });
              } catch (e) {
                this.warn("could not write to the offline spool", e);
              }
            }
            this.offer(out);
          }
        }
      }
      if (this.aggregates.size && (this.sessionsDue || this.closed)) {
        this.sessionsDue = false;
        await this.sendAggregates();
      }
      while (this.inFlight < this.platform.maxInFlight) {
        const item = this.delivery.next(now());
        if (!item) break;
        this.inFlight++;
        void this.send(item);
      }
    } finally {
      this.pumping = false;
    }
    if (this.queue.length) {
      this.schedule();
      return;
    }
    const wake = this.delivery.wakeAt();
    if (wake !== undefined && this.inFlight < this.platform.maxInFlight)
      this.schedule(Math.max(0, (wake - now()) * 1000));
    this.notify();
  }

  private async send(item: Outbound): Promise<void> {
    const d = this.dsn as Dsn;
    try {
      const res = await (this.transport as Transport).send({
        url: d.baseUrl + item.path,
        body: item.body,
        headers: {
          "Content-Type": item.contentType,
          Authorization: `Bearer ${d.publicKey}`,
          ...item.headers,
        },
      });
      const dec = this.delivery.onResponse(item, res.status, (n) => res.header(n), now());
      if (dec.dropped) this.warn(`dropped a request to ${item.path} (${dec.reason})`);
      if (!dec.retry) this.unspool(item);
    } catch (e) {
      // Network errors are retried; past the last attempt the spool keeps the request.
      const dec = this.delivery.onError(item, now(), e instanceof Error ? e.name : "network error");
      if (dec.dropped) this.warn(`dropped a request to ${item.path} (${dec.reason})`);
    } finally {
      this.inFlight--;
      this.schedule();
    }
  }

  private unspool(item: Outbound): void {
    if (this.spool && item.spoolId !== undefined) {
      this.spool
        .delete(item.spoolId)
        .catch((e) => this.warn("could not update the offline spool", e));
    }
  }

  /** Retries waiting requests now (e.g. the browser is back online). */
  retryNow(): void {
    for (const item of this.delivery.queue) item.notBefore = 0;
    this.schedule();
  }

  /** The resource of a request: the release and environment, the host and the SDK. */
  private resource(
    release = this.options.release,
    environment = this.options.environment ?? "production",
    host = this.options.serverName,
  ): ResourceInfo {
    const p = this.platform;
    // The app's own configuration: cut, not redacted.
    return clipStrings(
      {
        serviceName: p.serviceName,
        release,
        environment,
        host,
        sdkName: p.sdkName,
        sdkVersion: SDK_VERSION,
        language: p.language,
      },
      this.limit,
    ) as ResourceInfo;
  }

  /** A request of `body` (compressed where the runtime can). */
  private async request(path: string, category: string, body: string): Promise<Outbound> {
    const enc = this.platform.compress ? await this.platform.compress(body) : { body, headers: {} };
    return {
      path,
      contentType: "application/json",
      body: enc.body,
      headers: enc.headers,
      category,
      attempts: 0,
      notBefore: 0,
    };
  }

  /** A Fixwire JSON request (sessions, feedback, check-ins), its strings cut. */
  private json(path: string, category: string, body: object): Promise<Outbound> {
    return this.request(path, category, JSON.stringify(clipStrings(body, this.limit)));
  }

  /**
   * An error or message: an OTLP log record on /v1/logs. Its strings are
   * cut to what redaction reads, masked, then cut to maxValueLength.
   */
  private async encodeEvent(event: Event): Promise<Outbound | undefined> {
    try {
      if (this.platform.enrich) await this.platform.enrich(event);
      const images = event.debug_meta ? undefined : debugImages(this.platform.stackParser, event);
      if (images) event.debug_meta = { images };
      const w = ahead(this.limit);
      // Breadcrumbs and frames are lists of the SDK's, not values of the
      // app's: as many as the options say are kept (the newest frames).
      const { breadcrumbs, exception, ...rest } = event;
      const data = normalize(rest, w) as Event & Record<string, unknown>;
      if (breadcrumbs) data.breadcrumbs = breadcrumbs.map((b) => normalize(b, w, 2) as Breadcrumb);
      if (exception?.values)
        data.exception = {
          values: exception.values.map(({ stacktrace, ...x }) => {
            const out = normalize(x, w, 3) as Exception;
            const frames = stacktrace?.frames?.slice(-this.maxFrames);
            if (frames)
              out.stacktrace = { frames: frames.map((f) => normalize(f, w, 6) as StackFrame) };
            return out;
          }),
        };
      if (this.redactor) {
        const kept: Record<string, unknown> = {};
        for (const k of REDACT_SKIP) {
          if (k in data) {
            kept[k] = data[k];
            delete data[k];
          }
        }
        this.redactor.walk(data);
        Object.assign(data, kept);
      }
      clipStrings(data, this.limit);
      const res = this.resource(data.release, data.environment, data.server_name);
      const record = eventRecord(data);
      let body = logsRequest(res, [record]);
      // Over 1 MB: the breadcrumbs go, then the contexts (frames here carry
      // no local variables), then the event.
      for (const key of ["fixwire.breadcrumbs", "fixwire.contexts"]) {
        if (utf8(body) <= MAX_EVENT_BYTES) break;
        record.attributes = (record.attributes as KeyValue[]).filter((a) => a.key !== key);
        body = logsRequest(res, [record]);
      }
      if (utf8(body) > MAX_EVENT_BYTES) {
        this.warn("dropped an event over 1 MB");
        return undefined;
      }
      return await this.request("/v1/logs", "error", body);
    } catch (e) {
      this.warn("could not encode an event", e);
      return undefined;
    }
  }

  /** A segment and its spans: OTLP exports on /v1/traces of at most 5 MB each, redacted. */
  private async encodeSegment(segment: Span): Promise<Outbound[] | undefined> {
    try {
      const res = this.resource();
      const room = MAX_REQUEST_BYTES - utf8(tracesRequest(res, []));
      return await Promise.all(
        segment
          .batches(this.limit, this.redactor, room)
          .map((spans) => this.request("/v1/traces", "span", tracesRequest(res, spans))),
      );
    } catch (e) {
      this.warn("could not encode spans", e);
      return undefined;
    }
  }

  private idle(): boolean {
    return (
      !this.queue.length &&
      !this.inFlight &&
      !this.pumping &&
      (this.delivery.queue.length === 0 || this.onlyWaiting())
    );
  }

  private onlyWaiting(): boolean {
    const wake = this.delivery.wakeAt();
    return wake !== undefined && wake > now();
  }

  private notify(): void {
    if (!this.idle()) return;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Resolves true once queued events are sent; false on timeout or while retries wait out their backoff. */
  flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.transport) return Promise.resolve(true);
    this.sessionsDue = true;
    this.schedule();
    return new Promise((resolve) => {
      // A ref'd timer: whoever awaits flush keeps the process alive (the
      // client's own timers never do).
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve(this.delivery.queue.length === 0);
      });
    });
  }

  /** Flushes, then disables the client. Resolves like flush(). */
  async close(timeoutMs = 2000): Promise<boolean> {
    if (this.closed) return true;
    this.closed = true;
    const ok = await this.flush(timeoutMs);
    if (this.timer !== undefined) this.platform.clearTimer(this.timer);
    if (this.sessionTimer !== undefined) this.platform.clearTimer(this.sessionTimer);
    return ok;
  }

  private warn(message: string, err?: unknown): void {
    if (!this.options.debug) return;
    this.capturing++; // the SDK's own lines are no breadcrumbs
    try {
      console.warn(`[fixwire] ${message}`, err ?? "");
    } finally {
      this.capturing--;
    }
  }
}
