/**
 * Fixwire for Angular: the errors Angular catches, HttpClient's failures
 * with their status, and pages named after the Router's routes.
 *
 *   // main.ts
 *   import * as Fixwire from "@fixwire/angular";
 *   Fixwire.init({ dsn: "…", tracesSampleRate: 0.2 });
 *   bootstrapApplication(App, appConfig).catch((err) => Fixwire.captureException(err));
 *
 *   // app.config.ts
 *   providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes), Fixwire.provideFixwire()]
 *
 * Everything in @fixwire/browser is exported too.
 */

import {
  type EnvironmentProviders,
  ErrorHandler,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from "@angular/core";
import { Router } from "@angular/router";
import {
  type BrowserOptions,
  browserTracingIntegration,
  type Client,
  init as initBrowser,
  resolveIntegrations,
} from "@fixwire/browser";

import {
  createErrorHandler,
  describeHttpErrors,
  type ErrorHandlerOptions,
} from "./errorhandler.ts";
import { instrumentRouter } from "./router.ts";

export * from "@fixwire/browser";
export {
  createErrorHandler,
  type ErrorHandlerOptions,
  FixwireErrorHandler,
  httpErrorResponses,
  type ViewErrorDetails,
} from "./errorhandler.ts";
export { instrumentRouter, type RouteSnapshotLike, routeName } from "./router.ts";

/**
 * Starts the SDK in the browser, before `bootstrapApplication`. Page loads
 * and navigations are traced when tracesSampleRate (or tracesSampler) is
 * set; `provideFixwire()` names them after the Router's routes.
 */
export function init(options: BrowserOptions = {}): Client {
  const o = { ...options };
  if (o.defaultIntegrations !== false)
    o.integrations = resolveIntegrations([browserTracingIntegration()], o.integrations);
  const client = initBrowser(o);
  describeHttpErrors();
  return client;
}

/**
 * Fixwire's ErrorHandler, HttpClient's errors described, and pages named
 * after the Router's routes when the app has a Router.
 */
export function provideFixwire(options: ErrorHandlerOptions = {}): EnvironmentProviders {
  describeHttpErrors();
  return makeEnvironmentProviders([
    { provide: ErrorHandler, useFactory: () => createErrorHandler(options) },
    provideAppInitializer(() => {
      const router = inject(Router, { optional: true });
      if (router) instrumentRouter(router);
    }),
  ]);
}
