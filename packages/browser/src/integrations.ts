/**
 * Browser integrations. Global handlers listen with addEventListener and
 * never replace window.onerror, so later libraries can't silently disable
 * them; breadcrumbs wrap console and fetch through a shared registry, so
 * two copies of the SDK never double-wrap.
 */
import { type Event, getClient, type Integration } from "@fixwire/core";

type Target = Pick<EventTarget, "addEventListener">;

const installed = (name: string): boolean => {
  const g = globalThis as { __FIXWIRE__?: { instrumented: Record<string, boolean> } };
  const reg = g.__FIXWIRE__?.instrumented;
  if (!reg || reg[name]) return true;
  reg[name] = true;
  return false;
};

/** Uncaught errors and unhandled rejections. */
export const globalHandlersIntegration = (target?: Target): Integration => ({
  name: "GlobalHandlers",
  setup: () => {
    const t = target ?? (globalThis as unknown as Target);
    if (
      typeof t.addEventListener !== "function" ||
      installed(target ? `globalHandlers:${Math.random()}` : "globalHandlers")
    )
      return;
    t.addEventListener("error", (e) => {
      const ev = e as ErrorEvent;
      const client = getClient();
      if (!client) return;
      if (ev.error !== undefined && ev.error !== null) {
        client.captureException(ev.error, { mechanism: { type: "onerror", handled: false } });
      } else {
        // Cross-origin "Script error." carries nothing useful; the noise filter drops it.
        client.captureEvent(
          {
            level: "error",
            exception: {
              values: [
                {
                  type: "Error",
                  value: ev.message,
                  mechanism: { type: "onerror", handled: false },
                },
              ],
            },
          },
          { mechanism: { type: "onerror", handled: false } },
        );
      }
    });
    t.addEventListener("unhandledrejection", (e) => {
      const reason = (e as PromiseRejectionEvent).reason;
      getClient()?.captureException(reason, {
        mechanism: { type: "onunhandledrejection", handled: false },
      });
    });
  },
});

/** Console calls and fetch requests as breadcrumbs. */
export const breadcrumbsIntegration = (): Integration => ({
  name: "Breadcrumbs",
  setup: () => {
    const g = globalThis as unknown as { console?: Console; fetch?: typeof fetch };
    if (g.console && !installed("breadcrumbs:console")) {
      for (const level of ["debug", "info", "warn", "error", "log"] as const) {
        const original = g.console[level];
        if (typeof original !== "function") continue;
        g.console[level] = function fixwireWrapped(this: Console, ...args: unknown[]) {
          try {
            getClient()?.addBreadcrumb({
              category: "console",
              level: level === "warn" ? "warning" : level === "log" ? "info" : level,
              message: args
                .map((a) => (typeof a === "string" ? a : safeString(a)))
                .join(" ")
                .slice(0, 1024),
            });
          } catch {
            // never break logging
          }
          return original.apply(this, args);
        };
      }
    }
    if (typeof g.fetch === "function" && !installed("breadcrumbs:fetch")) {
      const original = g.fetch;
      g.fetch = async function fixwireWrapped(input: RequestInfo | URL, init?: RequestInit) {
        const start = Date.now();
        let status = 0;
        try {
          const res = await original(input, init);
          status = res.status;
          return res;
        } finally {
          crumb(input, init, status, start);
        }
      };
    }
  },
});

/** The breadcrumb of a fetch call. It never throws: the app gets its response as it was. */
function crumb(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  status: number,
  start: number,
): void {
  try {
    // A Request, else a string or anything fetch turns into one (a URL).
    const req = typeof input === "object" && "url" in input ? input : undefined;
    const url = req ? req.url : String(input);
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    const client = getClient();
    // Our own requests are not breadcrumbs.
    if (!client || (client.dsn && url.startsWith(`${client.dsn.baseUrl}/`))) return;
    client.addBreadcrumb({
      category: "fetch",
      type: "http",
      level: status === 0 || status >= 500 ? "error" : status >= 400 ? "warning" : "info",
      data: {
        url: url.split(/[?#]/)[0],
        method,
        status_code: status,
        duration_ms: Date.now() - start,
      },
    });
  } catch {
    // never break the app's fetch
  }
}

/**
 * A logged value as JSON. Only its first values and characters: the message
 * keeps 1024 characters, so logging a large object stays cheap.
 */
function safeString(v: unknown): string {
  let budget = 1000;
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) =>
        --budget < 0 ? undefined : typeof x === "string" ? x.slice(0, 1024) : x,
      ) ?? String(v)
    );
  } catch {
    return String(v);
  }
}

const EXTENSION = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//;

/**
 * Drops what no one can act on: errors raised entirely inside browser
 * extensions, cross-origin "Script error." without a stack, and the benign
 * ResizeObserver loop warning.
 */
export function noiseFilter(event: Event): Event | null {
  const values = event.exception?.values ?? [];
  const ex = values[values.length - 1];
  if (!ex) return event;
  const frames = ex.stacktrace?.frames ?? [];
  if (frames.length && frames.every((f) => EXTENSION.test(f.filename ?? ""))) return null;
  if (/^Script error\.?$/.test(ex.value ?? "") && !frames.length) return null;
  if (
    /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/.test(
      ex.value ?? "",
    )
  )
    return null;
  return event;
}
