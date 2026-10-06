/**
 * Node integrations. They use process events and diagnostics_channel,
 * never patching modules, and install once per process.
 */
import * as diagnostics from "node:diagnostics_channel";

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type Client,
  continueTrace,
  getClient,
  getCurrentScope,
  getIsolationScope,
  hasTracingEnabled,
  type Integration,
  type RequestInfo,
  startInactiveSpan,
} from "@fixwire/core";

import { enterIsolationScope } from "./context.ts";
import { fetchIntegration, guarded, httpClientIntegration } from "./tracing.ts";

const installed = new Set<string>();
const once = (name: string, fn: () => void): void => {
  if (installed.has(name)) return;
  installed.add(name);
  fn();
};

/** How long a crashing process waits for its events to be sent. */
const SHUTDOWN_TIMEOUT_MS = 2000;

/** The SDK's process listeners, once installed. */
let uncaughtListener: NodeJS.UncaughtExceptionListener | undefined;
let rejectionListener: NodeJS.UnhandledRejectionListener | undefined;

type ProcessEvent = "uncaughtException" | "unhandledRejection";
/** `process`, typed for either event. */
const emitter: NodeJS.EventEmitter = process;

/** How many listeners of the app's (not the SDK's) an event has. */
const appListeners = (event: ProcessEvent): number =>
  emitter.listeners(event).filter((l) => l !== uncaughtListener && l !== rejectionListener).length;

/** Takes a listener off until the next turn of the loop: meanwhile, Node does without it. */
function standAside(
  event: ProcessEvent,
  listener: NodeJS.UncaughtExceptionListener | NodeJS.UnhandledRejectionListener | undefined,
): void {
  if (!listener) return;
  emitter.removeListener(event, listener);
  setImmediate(() => {
    if (!emitter.listeners(event).includes(listener)) emitter.on(event, listener);
  }).unref();
}

/**
 * Node's `--unhandled-rejections` mode: the command line's, else
 * NODE_OPTIONS' (the command line overrides it), else `throw`. Exported for
 * tests.
 */
export function rejectionMode(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? "",
): string {
  const last = (args: readonly string[]): string | undefined => {
    let mode: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const [name, value] = (args[i] ?? "").split("=", 2);
      // Node reads `_` in an option's name as `-`.
      if (name?.replace(/_/g, "-") === "--unhandled-rejections") mode = value ?? args[++i];
    }
    return mode;
  };
  const options = nodeOptions.replace(/"/g, "").split(/\s+/);
  return last(execArgv) ?? last(options) ?? "throw";
}

/** Uncaught exceptions: reported as fatal, flushed, then Node's default (exit 1) unless the app handles them too. */
export const onUncaughtExceptionIntegration = (): Integration => ({
  name: "OnUncaughtException",
  setup: () =>
    once("uncaught", () => {
      const handler = (error: Error, origin?: string): void => {
        const client = getClient();
        const others = process.listeners("uncaughtException").filter((l) => l !== handler).length;
        if (origin === "unhandledRejection" && rejectionListener) {
          // `--unhandled-rejections=strict`: Node raises a rejection, then
          // emits it. Unhandled, it is the rejection integration's (emitted
          // next): it reports it and then crashes as Node would have.
          if (others === 0) return;
          // The app handles it: report it here, and leave the rejection to
          // the app's listeners, else to Node's warning, as without the SDK.
          standAside("unhandledRejection", rejectionListener);
          client?.captureException(error, {
            mechanism: { type: "onunhandledrejection", handled: false },
          });
          return;
        }
        client?.captureException(error, {
          mechanism: { type: "onuncaughtexception", handled: false },
        });
        if (others > 0) return;
        console.error(error);
        // Node would exit now; keep the loop alive (our timers are unref'd)
        // until the event is sent, then exit as Node does.
        process.exitCode = 1;
        const keepAlive = setTimeout(() => undefined, SHUTDOWN_TIMEOUT_MS + 500);
        void (client ? client.close(SHUTDOWN_TIMEOUT_MS) : Promise.resolve(true)).finally(() => {
          clearTimeout(keepAlive);
          process.exit(1);
        });
      };
      uncaughtListener = handler;
      process.on("uncaughtException", handler);
    }),
});

/**
 * Hands a rejection back to Node with the SDK's listeners off, so Node does
 * what it would have done without the SDK: raise it as an uncaught exception
 * (to the app's handlers, else printed, exit code 1), or warn.
 */
function handBack(reason: unknown): void {
  standAside("uncaughtException", uncaughtListener);
  standAside("unhandledRejection", rejectionListener);
  void Promise.reject(reason);
}

/**
 * Unhandled promise rejections: reported, then handled as Node's
 * `--unhandled-rejections` mode would without the SDK's listener (listening
 * alone stops the default mode's crash). Where Node would crash (`throw`
 * with no listener of the app's, or `strict` with no `uncaughtException`
 * handler), the event is flushed first, within the shutdown timeout.
 */
export const onUnhandledRejectionIntegration = (): Integration => ({
  name: "OnUnhandledRejection",
  setup: () =>
    once("rejection", () => {
      const mode = rejectionMode();
      const handler = (reason: unknown): void => {
        const client = getClient();
        client?.captureException(reason, {
          mechanism: { type: "onunhandledrejection", handled: false },
        });
        const unheard = appListeners("unhandledRejection") === 0;
        if (
          (mode === "throw" && unheard) ||
          (mode === "strict" && appListeners("uncaughtException") === 0)
        ) {
          // Node would crash now: send the event first.
          void (client ? client.flush(SHUTDOWN_TIMEOUT_MS) : Promise.resolve(true)).finally(() =>
            handBack(reason),
          );
        } else if (mode === "warn-with-error-code" && unheard) {
          handBack(reason); // a warning and exit code 1
        }
        // `warn` warns, `none` stays silent, with listeners or without.
      };
      rejectionListener = handler;
      process.on("unhandledRejection", handler);
    }),
});

/** The Express route of a request (`/orders/:id`), once routing matched it. */
function routeOf(request: IncomingMessage): string | undefined {
  const r = request as { route?: { path?: unknown }; baseUrl?: string };
  return typeof r.route?.path === "string" ? `${r.baseUrl ?? ""}${r.route.path}` : undefined;
}

/** Starts the request's segment (tracing on) and ends it with the response. */
function serverSpan(request: IncomingMessage, response: ServerResponse | undefined): void {
  const method = request.method ?? "GET";
  const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
  const encrypted = (request.socket as { encrypted?: boolean } | undefined)?.encrypted;
  const span = startInactiveSpan({
    name: `${method} ${path}`,
    op: "http.server",
    origin: "auto.http.node",
    forceSegment: true,
    attributes: {
      "http.request.method": method,
      "url.path": path,
      "url.scheme": encrypted ? "https" : "http",
    },
  });
  getCurrentScope().span = span;
  if (!response) return;
  const end = (): void => {
    const route = routeOf(request);
    if (route) span.updateName(`${method} ${route}`).setAttribute("http.route", route);
    span.setAttribute("http.response.status_code", response.statusCode);
    if (response.statusCode >= 500) span.setStatus("error");
    span.end();
  };
  response.once("finish", end);
  response.once("close", end); // aborted: no finish
}

/**
 * Each incoming HTTP request gets its own isolation scope (tags, user,
 * breadcrumbs) and continues the caller's trace; with tracing on, it is a
 * segment named after its route.
 */
/**
 * Whether an incoming request delivers telemetry: an ingest endpoint
 * (fixwire-protocol), with a key.
 */
function isDelivery(request: IncomingMessage): boolean {
  const url = request.url ?? "";
  return (
    /\/v1\/(?:traces|logs|metrics|sessions|feedback|files|check-ins)\b/.test(url) &&
    (String(request.headers.authorization ?? "").startsWith("Bearer ") || /[?&]key=/.test(url))
  );
}

export const httpServerIntegration = (): Integration => ({
  name: "HttpServer",
  setup: () =>
    once("http", () => {
      diagnostics.subscribe(
        "http.server.request.start",
        guarded((message) => {
          enterIsolationScope();
          const { request, response } = message as {
            request?: IncomingMessage;
            response?: ServerResponse;
          };
          if (request) {
            continueTrace(request.headers);
            // Release health: each request is a session, ended with its response.
            if (response && !isDelivery(request)) {
              const end = getClient()?.startRequestSession(getIsolationScope());
              if (end) {
                response.once("finish", end);
                response.once("close", end);
              }
            }
            // An SDK delivery (an app relaying telemetry, or an ingest in this
            // process) is not the app's traffic: tracing it would send a span
            // per export, and one per span after that.
            if (hasTracingEnabled(getClient()?.options) && !isDelivery(request))
              serverSpan(request, response);
            getIsolationScope().addEventProcessor((event) => {
              event.request ??= requestInfo(request, !!getClient()?.options.sendDefaultPii);
              const route = routeOf(request);
              if (route && !event.transaction) event.transaction = route;
              return event;
            });
          }
          getClient()?.addBreadcrumb({
            category: "http.server",
            type: "http",
            data: { method: request?.method, url: request?.url },
          });
        }),
      );
    }),
});

const SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
  "user-agent",
  "x-request-id",
  "x-correlation-id",
  "traceparent",
  "tracestate",
  "baggage",
]);
const PII_HEADERS = new Set(["x-forwarded-for", "x-real-ip", "forwarded"]);

/** The request, private by default: allowlisted headers, never cookies or authorization. */
export function requestInfo(
  req: IncomingMessage,
  pii: boolean,
): RequestInfo & { url: string; method: string } {
  const headers = safeHeaders(req.headers, pii);
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted;
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ??
    (encrypted ? "https" : "http");
  const [path, query] = (req.url ?? "/").split("?", 2) as [string, string | undefined];
  const out: RequestInfo & { url: string; method: string } = {
    url: `${proto}://${req.headers.host ?? "localhost"}${path}`,
    method: req.method ?? "GET",
    headers,
  };
  if (query) out.query_string = query;
  return out;
}

/** The allowlisted request headers (proxy IP headers only with pii). */
export function safeHeaders(
  all: Record<string, string | string[] | undefined>,
  pii: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, v] of Object.entries(all)) {
    const k = key.toLowerCase();
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === "string" && (SAFE_HEADERS.has(k) || (pii && PII_HEADERS.has(k))))
      headers[k] = value;
  }
  return headers;
}

/** An Express error-handling middleware (four arguments). */
export type ExpressErrorHandler = (
  err: unknown,
  req: unknown,
  res: unknown,
  next: (err?: unknown) => void,
) => void;

interface ExpressLikeError {
  status?: number;
  statusCode?: number;
}

/**
 * Express: reports errors that reach the error handlers (not 4xx ones) and
 * passes them on. Add it after your routes:
 *
 *   app.use(expressErrorHandler());
 */
export function expressErrorHandler(): ExpressErrorHandler {
  return function fixwireErrorHandler(
    err: unknown,
    _req: unknown,
    _res: unknown,
    next: (err?: unknown) => void,
  ): void {
    const status = (err as ExpressLikeError)?.status ?? (err as ExpressLikeError)?.statusCode;
    if (status === undefined || status >= 500) {
      getClient()?.captureException(err, { mechanism: { type: "express", handled: false } });
    }
    next(err);
  };
}

/** `app.use(expressErrorHandler())`. */
export function setupExpressErrorHandler(app: { use(handler: unknown): unknown }): void {
  app.use(expressErrorHandler());
}

/** What `init()` installs unless `defaultIntegrations: false`. */
export const defaultIntegrations = (): Integration[] => [
  onUncaughtExceptionIntegration(),
  onUnhandledRejectionIntegration(),
  httpServerIntegration(),
  httpClientIntegration(),
  fetchIntegration(),
];

export type { Client };
