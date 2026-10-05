/**
 * Fixwire SDK for edge runtimes: Cloudflare Workers, Vercel Edge Functions
 * and Next.js middleware, Deno Deploy and Netlify Edge Functions.
 *
 *   import * as Fixwire from "@fixwire/edge";
 *   export default Fixwire.withFixwire((env) => ({ dsn: env.FIXWIRE_DSN }), {
 *     async fetch(request, env, ctx) { … },
 *   });
 *
 * Edge runtimes may stop an isolate as soon as the response is sent, so the
 * handler wrappers hand the delivery of queued events to the runtime's
 * waitUntil, or wait for it before returning.
 */
import {
  addBreadcrumb,
  bindClient,
  Client,
  type ClientOptions,
  continueTrace,
  createStackParser,
  getActiveSpan,
  getClient,
  type Integration,
  nodeStackLineParser,
  type Platform,
  resolveIntegrations,
  Scope,
  setAsyncContextStrategy,
  shouldPropagate,
  startInactiveSpan,
  startSpan,
  type Transport,
  traceHeaders,
  withIsolationScope,
} from "@fixwire/core";

export * from "@fixwire/core";

/** An AsyncLocalStorage class (`node:async_hooks`), which edge runtimes provide. */
export interface AsyncLocalStorageClass {
  new <T>(): { getStore(): T | undefined; run<R>(store: T, callback: () => R): R };
}

/** Options of the edge SDK's `init()`. */
export interface EdgeOptions extends ClientOptions {
  /**
   * The runtime's AsyncLocalStorage, so concurrent requests keep their own
   * scopes (tags, user, breadcrumbs). Found on its own on Vercel Edge and in
   * Next.js middleware; on Cloudflare Workers enable `nodejs_compat` and pass
   * `AsyncLocalStorage` from `node:async_hooks`. Without one, requests an
   * isolate serves at the same time share their scope.
   */
  asyncLocalStorage?: AsyncLocalStorageClass;
  /** Read FIXWIRE_* variables of `process.env`, where the runtime has it, for unset options (default true). */
  useEnvironment?: boolean;
}

// Captured before fetchIntegration wraps fetch: deliveries are never traced.
const runtimeFetch: typeof fetch | undefined = globalThis.fetch?.bind(globalThis);

/** Sends requests with the runtime's fetch. */
export function makeEdgeTransport(fetchImpl: typeof fetch | undefined = runtimeFetch): Transport {
  return {
    async send(req) {
      if (!fetchImpl) throw new Error("no fetch in this runtime");
      const res = await fetchImpl(req.url, {
        method: "POST",
        body: req.body as BodyInit,
        headers: req.headers,
      });
      await res.body?.cancel(); // only the status and headers matter
      return { status: res.status, header: (name) => res.headers.get(name) };
    },
  };
}

async function gzip(body: string): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
  return {
    body: new Uint8Array(await new Response(stream).arrayBuffer()),
    headers: { "Content-Encoding": "gzip" },
  };
}

interface EdgeGlobals {
  navigator?: { userAgent?: string };
  EdgeRuntime?: unknown;
  Netlify?: unknown;
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
  AsyncLocalStorage?: AsyncLocalStorageClass;
  process?: { env?: Record<string, string | undefined> };
}

const g = globalThis as EdgeGlobals;

/** The runtime, for contexts.runtime. */
function runtime(): { name: string; version?: string } {
  if (g.navigator?.userAgent === "Cloudflare-Workers") return { name: "cloudflare-workers" };
  if (typeof g.EdgeRuntime === "string") return { name: "vercel-edge" };
  if (g.Netlify !== undefined) return { name: "netlify-edge" };
  if (g.Deno?.version?.deno) return { name: "deno", version: g.Deno.version.deno };
  if (g.Bun?.version) return { name: "bun", version: g.Bun.version };
  return { name: "edge" };
}

/** What an edge runtime provides to a Client (for `new Client(options, edgePlatform())`). */
export const edgePlatform = (): Platform => ({
  sdkName: "fixwire.javascript.edge",
  language: "nodejs",
  serviceName: g.process?.env?.OTEL_SERVICE_NAME || undefined,
  // Every edge runtime is V8: its stack lines read like Node's.
  stackParser: createStackParser(nodeStackLineParser()),
  globalPerMinute: 600,
  maxInFlight: 4,
  makeTransport: () => makeEdgeTransport(),
  ...(typeof CompressionStream === "function" ? { compress: gzip } : {}),
  defaults: (event) => {
    event.contexts = { ...event.contexts, runtime: runtime() };
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

interface Scopes {
  isolation: Scope;
  current: Scope;
}

/** Scopes per request, with the runtime's AsyncLocalStorage. */
function useAsyncLocalStorage(ALS: AsyncLocalStorageClass): void {
  const storage = new ALS<Scopes>();
  const root: Scopes = { isolation: new Scope(), current: new Scope() };
  const get = (): Scopes => storage.getStore() ?? root;
  setAsyncContextStrategy({
    getIsolationScope: () => get().isolation,
    getCurrentScope: () => get().current,
    withScope: (cb) => {
      const s = get();
      const scope = s.current.clone();
      return storage.run({ isolation: s.isolation, current: scope }, () => cb(scope));
    },
    withIsolationScope: (cb) => {
      const s = get();
      const isolation = s.isolation.clone();
      return storage.run({ isolation, current: s.current.clone() }, () => cb(isolation));
    },
  });
}

let fetchPatched = false;

/** fetch() calls: child spans, breadcrumbs, and trace headers for `tracePropagationTargets`. */
export const fetchIntegration = (): Integration => ({
  name: "Fetch",
  setup: () => {
    const original = (globalThis as { fetch?: typeof fetch }).fetch;
    if (fetchPatched || typeof original !== "function") return;
    fetchPatched = true;
    globalThis.fetch = function fixwireFetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const plain = url.split(/[?#]/, 1)[0] ?? url;
      const parent = getActiveSpan();
      const span = parent?.isRecording()
        ? startInactiveSpan({
            name: `${method} ${plain}`,
            op: "http.client",
            origin: "auto.http.edge.fetch",
            attributes: { "http.request.method": method, "url.full": plain },
          })
        : undefined;
      let args: [RequestInfo | URL, RequestInit | undefined] = [input, init];
      if (shouldPropagate(url)) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has("traceparent")) {
          for (const [k, v] of Object.entries(traceHeaders({ span })))
            if (!headers.has(k)) headers.set(k, v);
          args = [input, { ...init, headers }];
        }
      }
      const end = (status: number | undefined, error?: unknown): void => {
        if (span) {
          span.setAttribute("http.response.status_code", status);
          if (error !== undefined || (status ?? 0) >= 400) span.setStatus("error");
          span.end();
        }
        const data: Record<string, unknown> = { method, url: plain };
        if (status !== undefined) data.status_code = status;
        addBreadcrumb(
          {
            type: "http",
            category: "http",
            level: error !== undefined || (status ?? 0) >= 500 ? "error" : "info",
            data,
          },
          { error },
        );
      };
      return original(...args).then(
        (res) => {
          end(res.status);
          return res;
        },
        (err: unknown) => {
          end(undefined, err);
          throw err;
        },
      );
    };
  },
});

/**
 * Starts the SDK: creates the client, binds it for the top-level functions,
 * keeps scopes per request where the runtime has AsyncLocalStorage, and
 * traces fetch() calls. Without a DSN, captures are no-ops. On Cloudflare
 * Workers, `withFixwire` calls it for you with the worker's env.
 *
 * @example
 * import * as Fixwire from "@fixwire/edge";
 * Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "web@1.4.0" });
 */
export function init(options: EdgeOptions = {}): Client {
  const o: EdgeOptions = { ...options };
  const env = g.process?.env;
  if (o.useEnvironment !== false && env) {
    o.dsn ??= env.FIXWIRE_DSN || undefined;
    o.release ??= env.FIXWIRE_RELEASE || undefined;
    o.environment ??= env.FIXWIRE_ENVIRONMENT || undefined;
  }
  const als = o.asyncLocalStorage ?? g.AsyncLocalStorage;
  if (als) useAsyncLocalStorage(als);
  else if (o.debug)
    console.warn(
      "[fixwire] no AsyncLocalStorage: requests served at the same time share tags, user and " +
        "breadcrumbs; pass asyncLocalStorage (Cloudflare: enable nodejs_compat)",
    );
  const client = new Client(o, edgePlatform());
  bindClient(client);
  const defaults = o.defaultIntegrations === false ? [] : [fetchIntegration()];
  for (const i of resolveIntegrations(defaults, o.integrations)) i.setup(client);
  return client;
}

/** Options of wrapRequestHandler(). */
export interface RequestHandlerOptions {
  /**
   * Keeps the runtime alive after the response until queued events are
   * sent: Vercel's `waitUntil` (`@vercel/functions`), Next.js middleware's
   * `event.waitUntil`, Netlify's `context.waitUntil`. Without it the handler
   * waits for them before returning.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The longest wait for queued events (default 2000 ms). */
  flushTimeoutMs?: number;
}

const SAFE_HEADERS = [
  "accept",
  "accept-language",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
  "user-agent",
  "x-request-id",
  "traceparent",
  "tracestate",
  "baggage",
];

/** The request, private by default: allowlisted headers, never cookies or authorization. */
function requestInfo(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  for (const name of SAFE_HEADERS) {
    const v = request.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  const info: Record<string, unknown> = {
    url: `${url.origin}${url.pathname}`,
    method: request.method,
    headers,
  };
  if (url.search) info.query_string = url.search.slice(1);
  return info;
}

/** Runs one request: its own scope, the caller's trace, a segment, errors reported, then a flush. */
async function serve(
  request: Request,
  run: () => Response | Promise<Response>,
  options: RequestHandlerOptions,
): Promise<Response> {
  try {
    return await withIsolationScope(async (scope) => {
      const endSession = getClient()?.startRequestSession(scope);
      continueTrace(request.headers);
      const info = requestInfo(request);
      scope.addEventProcessor((event) => {
        event.request ??= info;
        return event;
      });
      const path = new URL(request.url).pathname;
      try {
        return await startSpan(
          {
            name: `${request.method} ${path}`,
            op: "http.server",
            origin: "auto.http.edge",
            forceSegment: true,
            attributes: { "http.request.method": request.method, "url.path": path },
          },
          async (span) => {
            try {
              const res = await run();
              span.setAttribute("http.response.status_code", res.status);
              if (res.status >= 500) span.setStatus("error");
              return res;
            } catch (e) {
              getClient()?.captureException(e, { mechanism: { type: "edge", handled: false } });
              throw e;
            }
          },
        );
      } finally {
        endSession?.();
      }
    });
  } finally {
    await flushAfter(options);
  }
}

/** Sends queued events: through waitUntil when the runtime has it, else now. */
async function flushAfter(options: RequestHandlerOptions): Promise<void> {
  const flushing = getClient()?.flush(options.flushTimeoutMs ?? 2000);
  if (!flushing) return;
  if (options.waitUntil) options.waitUntil(flushing);
  else await flushing;
}

/**
 * Wraps a `(request) => Response` handler (Vercel Edge Functions, Next.js
 * middleware and edge routes, Deno, Netlify Edge Functions): each request
 * gets its own scope, continues the caller's trace, is traced as a segment
 * and has its errors reported (and thrown on); queued events are sent
 * before the runtime stops.
 *
 * @example
 * import { waitUntil } from "@vercel/functions";
 * export const GET = Fixwire.wrapRequestHandler(async (request) => Response.json(await load()), { waitUntil });
 */
export function wrapRequestHandler<A extends unknown[]>(
  handler: (request: Request, ...rest: A) => Response | Promise<Response>,
  options: RequestHandlerOptions = {},
): (request: Request, ...rest: A) => Promise<Response> {
  return (request, ...rest) => serve(request, () => handler(request, ...rest), options);
}

/** The part of a Workers ExecutionContext the wrapper uses. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A Workers module's handlers: fetch, scheduled and queue are wrapped,
 * anything else passes through.
 */
export interface WorkerHandlers<Env> {
  fetch?(request: Request, env: Env, ctx: ExecutionContextLike): Response | Promise<Response>;
  scheduled?(
    controller: { cron: string; scheduledTime: number },
    env: Env,
    ctx: ExecutionContextLike,
  ): void | Promise<void>;
  queue?(
    batch: { queue: string; messages: readonly unknown[] },
    env: Env,
    ctx: ExecutionContextLike,
  ): void | Promise<void>;
}

let workerClient: Client | undefined;

/** Runs a background invocation (a cron trigger, a queue batch) like a request. */
async function task(
  name: string,
  op: string,
  run: () => void | Promise<void>,
  ctx: ExecutionContextLike,
): Promise<void> {
  try {
    await withIsolationScope(async (scope) => {
      const endSession = getClient()?.startRequestSession(scope);
      scope.setTag("worker.trigger", op);
      try {
        await startSpan(
          { name, op, origin: "auto.function.cloudflare", forceSegment: true },
          async () => {
            try {
              await run();
            } catch (e) {
              getClient()?.captureException(e, {
                mechanism: { type: "cloudflare", handled: false },
              });
              throw e;
            }
          },
        );
      } finally {
        endSession?.();
      }
    });
  } finally {
    await flushAfter({ waitUntil: (p) => ctx.waitUntil(p) });
  }
}

/**
 * Wraps a Cloudflare Workers module: the SDK starts on the first
 * invocation with `options(env)` (FIXWIRE_DSN, FIXWIRE_RELEASE and
 * FIXWIRE_ENVIRONMENT from env fill unset options); every fetch, cron
 * trigger and queue batch gets its own scope, a segment and error
 * reporting; events are sent through `ctx.waitUntil`, after the response.
 *
 * @example
 * import { AsyncLocalStorage } from "node:async_hooks";
 * import * as Fixwire from "@fixwire/edge";
 *
 * export default Fixwire.withFixwire(
 *   (env) => ({ dsn: env.FIXWIRE_DSN, tracesSampleRate: 0.2, asyncLocalStorage: AsyncLocalStorage }),
 *   { async fetch(request, env, ctx) { return new Response("ok"); } },
 * );
 */
export function withFixwire<Env, H extends WorkerHandlers<Env>>(
  options: (env: Env) => EdgeOptions,
  handler: H,
): H {
  const start = (env: Env): void => {
    if (workerClient) return;
    const o = { ...options(env) };
    const vars = (env ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    o.dsn ??= str(vars.FIXWIRE_DSN);
    o.release ??= str(vars.FIXWIRE_RELEASE);
    o.environment ??= str(vars.FIXWIRE_ENVIRONMENT);
    workerClient = init({ ...o, useEnvironment: false });
  };
  const wrapped: WorkerHandlers<Env> = { ...handler };
  const { fetch, scheduled, queue } = handler;
  if (fetch) {
    wrapped.fetch = (request, env, ctx) => {
      start(env);
      return serve(request, () => fetch.call(handler, request, env, ctx), {
        waitUntil: (p) => ctx.waitUntil(p),
      });
    };
  }
  if (scheduled) {
    wrapped.scheduled = (controller, env, ctx) => {
      start(env);
      return task(
        `cron ${controller.cron}`,
        "function.cloudflare.scheduled",
        () => scheduled.call(handler, controller, env, ctx),
        ctx,
      );
    };
  }
  if (queue) {
    wrapped.queue = (batch, env, ctx) => {
      start(env);
      return task(
        `queue ${batch.queue}`,
        "queue.process",
        () => queue.call(handler, batch, env, ctx),
        ctx,
      );
    };
  }
  return wrapped as H;
}
