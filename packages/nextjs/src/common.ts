// What every runtime's entry has: the config helper, the error-page hook,
// the navigation breadcrumb and the settings Next.js inlines.
import { addBreadcrumb, captureException } from "@fixwire/core";
// A namespace import: React's server build (server components) has no
// useEffect, and only client components call the hook.
import * as React from "react";

export type { NextErrorContext, NextRequestInfo } from "@fixwire/node";

/** Next.js' config, as far as Fixwire touches it (its own types stay Next's). */
interface NextConfigLike {
  productionBrowserSourceMaps?: boolean;
}

type ConfigFunction = (phase: string, context: unknown) => object | Promise<object>;

/**
 * Turns on what Fixwire needs from the build: source maps for the browser
 * code, so stack traces show your code once `fixwire-cli sourcemaps upload
 * --inject --delete .next/static` uploaded them (and removed them, so they
 * aren't served). An explicit `productionBrowserSourceMaps` wins. It takes
 * what next.config exports: a config, or a function of the phase that
 * makes one.
 *
 * @example
 * // next.config.ts
 * export default withFixwireConfig({ reactStrictMode: true });
 */
export function withFixwireConfig<C extends object>(config: C): C {
  if (typeof config === "function") {
    const make = config as unknown as ConfigFunction;
    const wrapped = async (phase: string, context: unknown) =>
      withFixwireConfig(await make(phase, context));
    return wrapped as unknown as C;
  }
  const c = config as NextConfigLike;
  return { ...config, productionBrowserSourceMaps: c.productionBrowserSourceMaps ?? true };
}

/**
 * Reports the error an error page (`error.tsx`, `global-error.tsx`) shows.
 * A server error reaches the page with a digest and without its message, and
 * `onRequestError` already reported it on the server, so it isn't sent again.
 *
 * @example
 * "use client";
 * export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
 *   Fixwire.useCaptureException(error);
 *   return <html><body><h2>Something went wrong</h2></body></html>;
 * }
 */
export function useCaptureException(error: unknown): void {
  React.useEffect(() => {
    if (typeof (error as { digest?: unknown } | null)?.digest === "string") return;
    captureException(error, { mechanism: { type: "nextjs.error_page", handled: true } });
  }, [error]);
}

/**
 * Next.js calls it when the App Router starts a navigation
 * (`instrumentation-client.ts`): a breadcrumb for each, so an error shows how
 * the user got there.
 *
 * @example
 * // instrumentation-client.ts
 * export const onRouterTransitionStart = Fixwire.onRouterTransitionStart;
 */
export function onRouterTransitionStart(url: string, navigationType: string): void {
  addBreadcrumb({
    category: "navigation",
    type: "navigation",
    data: { to: url, type: navigationType },
  });
}

/** The settings a runtime's init reads from the environment when they aren't passed. */
export interface Settings {
  dsn?: string;
  release?: string;
  environment?: string;
}

/**
 * Fills unset settings: FIXWIRE_* first, then the NEXT_PUBLIC_FIXWIRE_* the
 * browser needs too, so one variable serves both sides.
 */
export function withSettings<O extends Settings>(
  options: O,
  env: Settings,
  publicEnv: Settings,
): O {
  const o = { ...options };
  o.dsn ??= env.dsn || publicEnv.dsn || undefined;
  o.release ??= env.release || publicEnv.release || undefined;
  o.environment ??= env.environment || publicEnv.environment || undefined;
  return o;
}
