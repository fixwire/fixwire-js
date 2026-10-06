/**
 * Fixwire SDK for browsers.
 *
 *   import * as Fixwire from '@fixwire/browser';
 *   Fixwire.init({ dsn: '…', release: 'web@1.4.0' });
 */
import {
  bindClient,
  Client,
  type ClientOptions,
  getGlobalScope,
  type Platform,
  resolveIntegrations,
} from "@fixwire/core";

import { breadcrumbsIntegration, globalHandlersIntegration, noiseFilter } from "./integrations.ts";
import { defaultStackParser } from "./stack-parsers.ts";
import { makeFetchTransport } from "./transport.ts";

export * from "@fixwire/core";
export { breadcrumbsIntegration, globalHandlersIntegration, noiseFilter } from "./integrations.ts";
export { defaultStackParser } from "./stack-parsers.ts";
export { type BrowserTracingOptions, browserTracingIntegration } from "./tracing.ts";
export { makeFetchTransport } from "./transport.ts";

/** Options of the browser SDK's `init()`. */
export interface BrowserOptions extends ClientOptions {
  /** Drop extension errors, "Script error." and ResizeObserver noise (default true). */
  filterNoise?: boolean;
}

/** What the browser provides to a Client (for `new Client(options, browserPlatform())`). */
export const browserPlatform = (): Platform => ({
  sdkName: "fixwire.javascript.browser",
  language: "webjs",
  stackParser: defaultStackParser,
  globalPerMinute: 100,
  maxInFlight: 2,
  makeTransport: () => makeFetchTransport(),
  defaults: (event) => {
    // The page, and the user agent (the server tells crawlers by it).
    const g = globalThis as { location?: { href: string }; navigator?: { userAgent?: string } };
    const ua = g.navigator?.userAgent;
    if (g.location && !event.request)
      event.request = {
        url: g.location.href.split(/[?#]/)[0], // the query and fragment may hold tokens
        ...(ua ? { headers: { "user-agent": ua } } : {}),
      };
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

/**
 * Starts the SDK: creates the client, binds it for the top-level functions
 * and installs the integrations (uncaught errors, unhandled rejections,
 * console and fetch breadcrumbs). Without a DSN, captures are no-ops.
 *
 * @example
 * import * as Fixwire from "@fixwire/browser";
 * Fixwire.init({ dsn: "https://<key>@<host>", release: "web@1.4.0" });
 */
export function init(options: BrowserOptions = {}): Client {
  const client = new Client(options, browserPlatform());
  bindClient(client);
  if (options.filterNoise !== false) getGlobalScope().addEventProcessor(noiseFilter);
  const defaults =
    options.defaultIntegrations === false
      ? []
      : [globalHandlersIntegration(), breadcrumbsIntegration()];
  for (const i of resolveIntegrations(defaults, options.integrations)) i.setup(client);
  // Release health: the page load is a session, ending when the page goes
  // away (or crashing first); a page restored from the back-forward cache
  // starts a new one.
  const g = globalThis as {
    addEventListener?: (t: string, fn: (e: { persisted?: boolean }) => void) => void;
  };
  client.startSession();
  g.addEventListener?.("pagehide", () => client.endSession());
  g.addEventListener?.("pageshow", (e) => {
    if (e.persisted) client.startSession();
  });
  if (options.offline) {
    // Back online: retry now instead of waiting out the backoff.
    (globalThis as { addEventListener?: (t: string, fn: () => void) => void }).addEventListener?.(
      "online",
      () => client.retryNow(),
    );
  }
  return client;
}
