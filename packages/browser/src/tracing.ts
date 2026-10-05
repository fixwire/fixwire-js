/**
 * Browser tracing (opt-in, so pages that only report errors don't ship it):
 * a segment per page load and per route change, ended once the page is
 * idle, with web vitals; fetch calls as child spans carrying trace headers
 * (same-origin by default); and the trace of a server-rendered page
 * continued from its `<meta name="traceparent">` (and `tracestate`).
 */
import {
  continueTrace,
  getActiveSpan,
  getClient,
  getCurrentScope,
  getIsolationScope,
  hasTracingEnabled,
  type Integration,
  newPropagationContext,
  type Scope,
  type Span,
  shouldPropagate,
  startInactiveSpan,
  traceHeaders,
} from "@fixwire/core";

/** Options of browserTracingIntegration(). */
export interface BrowserTracingOptions {
  /** End a page's segment after this long (ms) with no open child spans (default 1000). */
  idleTimeout?: number;
  /** End it after this long (ms) at the latest (default 30000). */
  finalTimeout?: number;
  /** A segment for the initial page load (default true). */
  instrumentPageLoad?: boolean;
  /** A segment per route change: history.pushState and back/forward (default true). */
  instrumentNavigation?: boolean;
}

interface BrowserGlobals {
  document?: {
    readyState?: string;
    visibilityState?: string;
    addEventListener?(type: string, fn: () => void): void;
    querySelector(selector: string): { getAttribute(name: string): string | null } | null;
  };
  location?: { href: string; pathname: string };
  history?: { pushState(...args: unknown[]): void };
  performance?: Performance;
  addEventListener?(type: string, fn: () => void, options?: { once?: boolean }): void;
  PerformanceObserver?: typeof PerformanceObserver;
  fetch?: typeof fetch;
  __FIXWIRE__?: { instrumented: Record<string, boolean> };
}

const g = globalThis as unknown as BrowserGlobals;
const now = (): number => Date.now() / 1000;

const installed = (name: string): boolean => {
  const reg = g.__FIXWIRE__?.instrumented;
  if (!reg || reg[name]) return true;
  reg[name] = true;
  return false;
};

/** The page's segment: active on the root scope until the page is idle. */
let page: { span: Span; finish(end?: number): void } | undefined;

function startPageSegment(
  root: Scope,
  name: string,
  op: "pageload" | "navigation",
  o: Required<BrowserTracingOptions>,
  startTime?: number,
): Span {
  page?.finish();
  const span = startInactiveSpan({
    name,
    op,
    origin: `auto.${op}.browser`,
    forceSegment: true,
    startTime,
    attributes: { "url.path": name },
  });
  root.span = span;
  let idleSince = now();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const finish = (end?: number): void => {
    clearTimeout(idle);
    clearTimeout(final);
    span.setIdleListener(undefined);
    if (root.span === span) root.span = undefined;
    if (page?.span === span) page = undefined;
    if (op === "pageload") pageMetrics(span);
    span.end(end);
  };
  const arm = (): void => {
    idleSince = now();
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (span.openChildren === 0) finish(idleSince);
    }, o.idleTimeout);
  };
  const final = setTimeout(() => finish(), o.finalTimeout);
  span.setIdleListener(arm);
  if (op === "pageload" && g.document && g.document.readyState !== "complete")
    g.addEventListener?.("load", arm, { once: true });
  else arm();
  page = { span, finish };
  return span;
}

/** Navigation timing and web vitals, as attributes of the page-load segment (ms; CLS unitless). */
const vitals: Record<string, number> = {};

function observeVitals(): void {
  const PO = g.PerformanceObserver;
  if (!PO) return;
  const observe = (type: string, fn: (entries: PerformanceEntry[]) => void): void => {
    try {
      new PO((list) => fn(list.getEntries())).observe({ type, buffered: true });
    } catch {
      // not supported here
    }
  };
  observe("largest-contentful-paint", (es) => {
    const last = es.at(-1);
    if (last) vitals.lcp = last.startTime;
  });
  observe("paint", (es) => {
    for (const e of es) if (e.name === "first-contentful-paint") vitals.fcp = e.startTime;
  });
  observe("layout-shift", (es) => {
    for (const e of es as (PerformanceEntry & { value?: number; hadRecentInput?: boolean })[])
      if (!e.hadRecentInput) vitals.cls = (vitals.cls ?? 0) + (e.value ?? 0);
  });
}

function pageMetrics(span: Span): void {
  const nav = g.performance?.getEntriesByType?.("navigation")[0] as
    | (PerformanceEntry & {
        responseStart?: number;
        domContentLoadedEventEnd?: number;
        loadEventEnd?: number;
      })
    | undefined;
  if (nav?.responseStart) vitals.ttfb = nav.responseStart;
  for (const [k, v] of Object.entries(vitals)) span.setAttribute(`browser.web_vital.${k}.value`, v);
  if (nav?.domContentLoadedEventEnd)
    span.setAttribute("browser.dom_content_loaded", nav.domContentLoadedEventEnd);
  if (nav?.loadEventEnd) span.setAttribute("browser.load", nav.loadEventEnd);
}

function meta(name: string): string | undefined {
  return g.document?.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? undefined;
}

function absolute(url: string): string {
  try {
    return new URL(url, g.location?.href).href;
  } catch {
    return url;
  }
}

function instrumentFetch(): void {
  const original = g.fetch;
  if (typeof original !== "function" || installed("tracing:fetch")) return;
  g.fetch = function fixwireTraced(input: RequestInfo | URL, init?: RequestInit) {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = absolute(raw);
    const dsn = getClient()?.dsn;
    if (dsn && url.startsWith(`${dsn.baseUrl}/`)) return original(input, init); // our own delivery
    const method = (
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
    ).toUpperCase();
    const plain = url.split(/[?#]/, 1)[0] ?? url;
    const parent = getActiveSpan();
    const span = parent?.isRecording()
      ? startInactiveSpan({
          name: `${method} ${plain}`,
          op: "http.client",
          origin: "auto.http.browser.fetch",
          attributes: { "http.request.method": method, "url.full": plain },
        })
      : undefined;
    let args: [RequestInfo | URL, RequestInit | undefined] = [input, init];
    if (shouldPropagate(url)) {
      const headers = new Headers(
        init?.headers ??
          (typeof input === "object" && "headers" in input ? input.headers : undefined),
      );
      if (!headers.has("traceparent")) {
        for (const [k, v] of Object.entries(traceHeaders({ span })))
          if (!headers.has(k)) headers.set(k, v);
        args = [input, { ...init, headers }];
      }
    }
    const end = (status: number | undefined, failed: boolean): void => {
      if (!span) return;
      span.setAttribute("http.response.status_code", status);
      if (failed || (status !== undefined && status >= 400)) span.setStatus("error");
      span.end();
    };
    return original(...args).then(
      (res) => {
        end(res.status, false);
        return res;
      },
      (err: unknown) => {
        end(undefined, true);
        throw err;
      },
    );
  };
}

/**
 * Traces page loads, route changes and fetch calls. Needs tracesSampleRate
 * (or tracesSampler) in the options.
 *
 * @example
 * Fixwire.init({ dsn, tracesSampleRate: 0.2, integrations: [Fixwire.browserTracingIntegration()] });
 */
export const browserTracingIntegration = (options: BrowserTracingOptions = {}): Integration => ({
  name: "BrowserTracing",
  setup: (client) => {
    if (!hasTracingEnabled(client.options) || installed("tracing")) return;
    const o: Required<BrowserTracingOptions> = {
      idleTimeout: options.idleTimeout ?? 1000,
      finalTimeout: options.finalTimeout ?? 30_000,
      instrumentPageLoad: options.instrumentPageLoad ?? true,
      instrumentNavigation: options.instrumentNavigation ?? true,
    };
    const root = getCurrentScope();
    const traceparent = meta("traceparent");
    if (traceparent) continueTrace({ traceparent, tracestate: meta("tracestate") });
    instrumentFetch();
    // Leaving or hiding the page ends its segment, so what was measured is sent.
    const leave = (): void => page?.finish();
    g.addEventListener?.("pagehide", leave);
    g.document?.addEventListener?.("visibilitychange", () => {
      if (g.document?.visibilityState === "hidden") leave();
    });
    observeVitals();
    const path = (): string => g.location?.pathname ?? "/";
    if (o.instrumentPageLoad) {
      const origin = g.performance?.timeOrigin;
      startPageSegment(root, path(), "pageload", o, origin ? origin / 1000 : undefined);
    }
    if (o.instrumentNavigation && g.history) {
      let last = path();
      const changed = (): void => {
        const next = path();
        if (next === last || getClient() !== client) return;
        last = next;
        // A new route is a new trace, as a new page would be.
        getIsolationScope().propagation = newPropagationContext();
        startPageSegment(root, next, "navigation", o);
      };
      const history = g.history;
      const push = history.pushState;
      history.pushState = function fixwirePushState(this: unknown, ...args: unknown[]) {
        const out = push.apply(this, args);
        changed();
        return out;
      };
      g.addEventListener?.("popstate", changed);
    }
  },
});
