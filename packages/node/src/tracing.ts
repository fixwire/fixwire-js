/**
 * Outgoing requests (node:http, node:https and fetch) as child spans of the
 * active span, carrying trace headers to tracePropagationTargets, with an
 * "http" breadcrumb each. Built on diagnostics_channel: nothing is patched,
 * and modules loaded before init() are covered too.
 *
 * Header injection needs `http.client.request.created` (Node 22.14+); on
 * older versions node:http requests still get spans, without headers.
 */
import * as diagnostics from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";

import {
  getActiveSpan,
  getClient,
  getIsolationScope,
  type Integration,
  type Scope,
  type Span,
  shouldPropagate,
  startInactiveSpan,
  traceHeaders,
} from "@fixwire/core";

import { sdkRequest } from "./transport.ts";

const installed = new Set<string>();
const once = (name: string, fn: () => void): void => {
  if (installed.has(name)) return;
  installed.add(name);
  fn();
};

interface Outgoing {
  span: Span | undefined;
  scope: Scope;
  method: string;
  url: string;
}

const withoutQuery = (url: string): string => url.split(/[?#]/, 1)[0] ?? url;

/** Starts the child span (inside a sampled span) and returns the bookkeeping. */
function begin(method: string, url: string, origin: string): Outgoing {
  const parent = getActiveSpan();
  const plain = withoutQuery(url);
  let span: Span | undefined;
  if (parent?.isRecording()) {
    let host: string | undefined;
    let port: number | undefined;
    try {
      const u = new URL(plain);
      host = u.hostname;
      port = u.port ? Number(u.port) : undefined;
    } catch {
      // a relative or odd URL: no server attributes
    }
    span = startInactiveSpan({
      name: `${method} ${plain}`,
      op: "http.client",
      origin,
      attributes: {
        "http.request.method": method,
        "url.full": plain,
        "server.address": host,
        "server.port": port,
      },
    });
  }
  return { span, scope: getIsolationScope(), method, url: plain };
}

/** Ends the span and records the breadcrumb (on the scope of the code that made the request). */
function finish(o: Outgoing, status: number | undefined, error?: unknown): void {
  if (o.span) {
    o.span.setAttribute("http.response.status_code", status);
    if (error !== undefined || (status !== undefined && status >= 400)) o.span.setStatus("error");
    o.span.end();
  }
  const client = getClient();
  if (!client) return;
  const data: Record<string, unknown> = { method: o.method, url: o.url };
  if (status !== undefined) data.status_code = status;
  client.addBreadcrumb(
    {
      type: "http",
      category: "http",
      level: error || (status ?? 0) >= 500 ? "error" : "info",
      data,
    },
    { error },
    o.scope,
  );
}

/** Trace headers for a request to `url` (tracePropagationTargets). */
function headersFor(o: Outgoing, url: string): Record<string, string> {
  return shouldPropagate(url) ? traceHeaders({ span: o.span }) : {};
}

const requests = new WeakMap<ClientRequest, Outgoing | null>();

function clientRequestUrl(req: ClientRequest): string {
  const host = req.getHeader("host") ?? req.host;
  return `${req.protocol}//${String(host)}${req.path}`;
}

function onClientRequest(req: ClientRequest, canInject: boolean): void {
  if (requests.has(req)) return;
  if (sdkRequest.active) {
    requests.set(req, null); // the SDK's own delivery
    return;
  }
  const url = clientRequestUrl(req);
  const o = begin(req.method, url, "auto.http.node.http");
  requests.set(req, o);
  // Unless the caller set its own: their baggage is kept too.
  if (canInject && !req.headersSent && req.getHeader("traceparent") === undefined) {
    for (const [k, v] of Object.entries(headersFor(o, url)))
      if (req.getHeader(k) === undefined) req.setHeader(k, v);
  }
}

/** node:http and node:https requests: child spans, trace headers, breadcrumbs. */
export const httpClientIntegration = (): Integration => ({
  name: "HttpClient",
  setup: () =>
    once("http.client", () => {
      diagnostics.subscribe("http.client.request.created", (m) => {
        onClientRequest((m as { request: ClientRequest }).request, true);
      });
      // Older Node: no "created" channel, and "start" is too late for headers.
      diagnostics.subscribe("http.client.request.start", (m) => {
        onClientRequest((m as { request: ClientRequest }).request, false);
      });
      diagnostics.subscribe("http.client.response.finish", (m) => {
        const { request, response } = m as { request: ClientRequest; response: IncomingMessage };
        const o = requests.get(request);
        if (o) finish(o, response.statusCode);
        requests.delete(request);
      });
      diagnostics.subscribe("http.client.request.error", (m) => {
        const { request, error } = m as { request: ClientRequest; error: unknown };
        const o = requests.get(request);
        if (o) finish(o, undefined, error);
        requests.delete(request);
      });
    }),
});

/** The parts of undici's request object that its diagnostics channels expose. */
interface UndiciRequest {
  origin: string | URL;
  path: string;
  method: string;
  headers: string | (string | string[] | Buffer)[];
  addHeader(name: string, value: string): unknown;
}

function undiciHeader(req: UndiciRequest, name: string): string | undefined {
  const h = req.headers;
  if (typeof h === "string") {
    for (const line of h.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0 && line.slice(0, i).trim().toLowerCase() === name) return line.slice(i + 1).trim();
    }
    return undefined;
  }
  for (let i = 0; i + 1 < h.length; i += 2) {
    if (String(h[i]).toLowerCase() === name) return String(h[i + 1]);
  }
  return undefined;
}

const fetches = new WeakMap<UndiciRequest, Outgoing>();

/** fetch() (Node's built-in undici): child spans, trace headers, breadcrumbs. */
export const fetchIntegration = (): Integration => ({
  name: "Fetch",
  setup: () =>
    once("fetch", () => {
      diagnostics.subscribe("undici:request:create", (m) => {
        const req = (m as { request: UndiciRequest }).request;
        const url = `${String(req.origin).replace(/\/$/, "")}${req.path}`;
        const o = begin(req.method, url, "auto.http.node.fetch");
        fetches.set(req, o);
        if (undiciHeader(req, "traceparent") === undefined) {
          for (const [k, v] of Object.entries(headersFor(o, url)))
            if (undiciHeader(req, k) === undefined) req.addHeader(k, v);
        }
      });
      diagnostics.subscribe("undici:request:headers", (m) => {
        const { request, response } = m as {
          request: UndiciRequest;
          response: { statusCode: number };
        };
        const o = fetches.get(request);
        if (o) finish(o, response.statusCode);
        fetches.delete(request);
      });
      diagnostics.subscribe("undici:request:error", (m) => {
        const { request, error } = m as { request: UndiciRequest; error: unknown };
        const o = fetches.get(request);
        if (o) finish(o, undefined, error);
        fetches.delete(request);
      });
    }),
});
