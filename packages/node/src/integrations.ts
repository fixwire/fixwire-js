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
import { fetchIntegration, httpClientIntegration } from "./tracing.ts";

const installed = new Set<string>();
const once = (name: string, fn: () => void): void => {
  if (installed.has(name)) return;
  installed.add(name);
  fn();
};

/** Uncaught exceptions: reported as fatal, flushed, then Node's default (exit 1) unless the app handles them too. */
export const onUncaughtExceptionIntegration = (): Integration => ({
  name: "OnUncaughtException",
  setup: () =>
    once("uncaught", () => {
      const handler = (error: Error): void => {
        const client = getClient();
        const others = process.listeners("uncaughtException").filter((l) => l !== handler).length;
        client?.captureException(error, {
          mechanism: { type: "onuncaughtexception", handled: false },
        });
        if (others > 0) return;
        console.error(error);
        // Node would exit now; keep the loop alive (our timers are unref'd)
        // until the event is sent, then exit as Node does.
        process.exitCode = 1;
        const keepAlive = setTimeout(() => undefined, 2500);
        void (client ? client.close(2000) : Promise.resolve(true)).finally(() => {
          clearTimeout(keepAlive);
          process.exit(1);
        });
      };
      process.on("uncaughtException", handler);
    }),
});

/** Unhandled promise rejections: reported, with Node's own warning left in place. */
export const onUnhandledRejectionIntegration = (): Integration => ({
  name: "OnUnhandledRejection",
  setup: () =>
    once("rejection", () => {
      process.on("unhandledRejection", (reason) => {
        getClient()?.captureException(reason, {
          mechanism: { type: "onunhandledrejection", handled: false },
        });
      });
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
 * (sdks/PROTOCOL.md), with a key.
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
      diagnostics.subscribe("http.server.request.start", (message) => {
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
      });
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
