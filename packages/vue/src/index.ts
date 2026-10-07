/**
 * Fixwire for Vue 3: the errors Vue catches, with their component, and
 * pages and navigations named after vue-router's routes.
 *
 *   import { createApp } from "vue";
 *   import * as Fixwire from "@fixwire/vue";
 *
 *   const app = createApp(App).use(router);
 *   Fixwire.init({ app, router, dsn: "…", tracesSampleRate: 0.2 });
 *   app.mount("#app");
 *
 * Everything in @fixwire/browser is exported too.
 */
import {
  type BrowserOptions,
  type Client,
  init as initBrowser,
  resolveIntegrations,
} from "@fixwire/browser";
import type { App } from "vue";

import { attachErrorHandler, type ErrorHandlerOptions } from "./errorhandler.ts";
import { browserTracingIntegration, instrumentRouter, type RouterLike } from "./router.ts";

export * from "@fixwire/browser";
export { attachErrorHandler, componentName, type ErrorHandlerOptions } from "./errorhandler.ts";
export {
  browserTracingIntegration,
  instrumentRouter,
  type RouteLike,
  type RouterLike,
  routeName,
  type VueTracingOptions,
} from "./router.ts";

/** Options of init: the browser SDK's, and what Vue adds. */
export interface VueOptions extends BrowserOptions, ErrorHandlerOptions {
  /** The app, or apps, whose errors to report (what createApp returns). */
  app?: App | App[];
  /** vue-router's router: pages, navigations and errors are named after its routes. */
  router?: RouterLike;
}

/**
 * Starts the SDK in the browser and reports the errors `app` catches. With
 * `router`, pages and navigations are named after its routes (and traced
 * when tracesSampleRate is set), and the router's errors are reported.
 */
export function init(options: VueOptions = {}): Client {
  const { app, router, logErrors, attachProps, ...rest } = options;
  const o: BrowserOptions = { ...rest };
  if (router && o.defaultIntegrations !== false)
    o.integrations = resolveIntegrations([browserTracingIntegration({ router })], o.integrations);
  const client = initBrowser(o);
  if (router) instrumentRouter(router);
  for (const a of app === undefined ? [] : [app].flat())
    attachErrorHandler(a, { logErrors, attachProps });
  return client;
}
