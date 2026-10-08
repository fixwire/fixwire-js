/**
 * Fixwire for SvelteKit in the browser; bundlers pick it for
 * "@fixwire/sveltekit" there.
 *
 *   // src/hooks.client.ts
 *   import * as Fixwire from "@fixwire/sveltekit";
 *   import { env } from "$env/dynamic/public";
 *
 *   export const init = () => Fixwire.init({ dsn: env.PUBLIC_FIXWIRE_DSN, tracesSampleRate: 0.2 });
 *   export const handleError = Fixwire.handleErrorWithFixwire();
 */
import {
  type BrowserOptions,
  browserTracingIntegration,
  type Client,
  init as initBrowser,
  resolveIntegrations,
  setRouteName,
} from "@fixwire/browser";

import {
  type EventLike,
  type HandleErrorInput,
  type HandleInput,
  ROUTE_META,
  wrapHandleError,
} from "./common.ts";

export * from "@fixwire/browser";
export {
  type EventLike,
  type HandleErrorInput,
  type HandleInput,
  type NavigationLike,
  trackNavigation,
} from "./common.ts";

/**
 * Starts the SDK in the browser. Page loads and navigations are traced when
 * tracesSampleRate (or tracesSampler) is set; `trackNavigation` names them
 * after their routes.
 */
export function init(options: BrowserOptions = {}): Client {
  const o = { ...options };
  if (o.defaultIntegrations !== false)
    o.integrations = resolveIntegrations([browserTracingIntegration()], o.integrations);
  const client = initBrowser(o);
  // A server-rendered page names its route (fixwireHandle).
  const doc = (globalThis as { document?: { querySelector(s: string): Element | null } }).document;
  const route = doc?.querySelector(`meta[name="${ROUTE_META}"]`)?.getAttribute("content");
  if (route) setRouteName(route);
  return client;
}

/**
 * The browser's handleError hook: reports unexpected errors while
 * navigating (a load function that throws), named after their route, then
 * returns what `handler` returns.
 */
export function handleErrorWithFixwire<I extends HandleErrorInput, R = undefined>(
  handler?: (input: I) => R,
): (input: I) => R | undefined {
  return wrapHandleError("sveltekit.client", handler);
}

/** On the server only: in the browser it passes the request on, as it is. */
export function fixwireHandle(): <E extends EventLike>(input: HandleInput<E>) => Promise<Response> {
  return async ({ event, resolve }) => resolve(event);
}
