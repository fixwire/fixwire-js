// Page loads and navigations as traces, named after the router's routes.
import {
  type BrowserTracingOptions,
  browserTracingIntegration as browserTracing,
  type Integration,
} from "@fixwire/browser";

import { instrumentRouter, type RouterLike } from "./router.ts";

/** Options of browserTracingIntegration. */
export interface VueTracingOptions extends BrowserTracingOptions {
  /** The app's router: pages and navigations are named after its routes. */
  router?: RouterLike;
}

/**
 * Page loads and navigations as traces (see `@fixwire/browser`), named
 * after the router's routes when it's given.
 *
 * @example
 * Fixwire.init({ dsn, tracesSampleRate: 0.2, integrations: [Fixwire.browserTracingIntegration({ router })] });
 */
export const browserTracingIntegration = (options: VueTracingOptions = {}): Integration => {
  const base = browserTracing(options);
  return {
    name: base.name,
    setup: (client) => {
      base.setup(client);
      if (options.router) instrumentRouter(options.router);
    },
  };
};
