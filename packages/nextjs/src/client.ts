/**
 * Fixwire for Next.js in the browser (`instrumentation-client.ts`, client
 * components); bundlers pick it for "@fixwire/nextjs" there.
 */
import {
  type BrowserOptions,
  browserTracingIntegration,
  type Client,
  init as initBrowser,
  resolveIntegrations,
} from "@fixwire/browser";

import {
  type NextErrorContext,
  type NextRequestInfo,
  type Settings,
  withSettings,
} from "./common.ts";

export * from "@fixwire/browser";
export {
  type NextErrorContext,
  type NextRequestInfo,
  onRouterTransitionStart,
  useCaptureException,
  withFixwireConfig,
} from "./common.ts";

declare const process: { env: Record<string, string | undefined> };

/**
 * The NEXT_PUBLIC_FIXWIRE_* variables: Next.js replaces each
 * `process.env.NEXT_PUBLIC_…` with its value at build time, and elsewhere
 * there may be no process at all.
 */
function publicSettings(): Settings {
  try {
    return {
      dsn: process.env.NEXT_PUBLIC_FIXWIRE_DSN,
      release: process.env.NEXT_PUBLIC_FIXWIRE_RELEASE,
      environment: process.env.NEXT_PUBLIC_FIXWIRE_ENVIRONMENT,
    };
  } catch {
    return {};
  }
}

/**
 * Starts the SDK in the browser. Unset, the DSN, release and environment
 * come from NEXT_PUBLIC_FIXWIRE_DSN, NEXT_PUBLIC_FIXWIRE_RELEASE and
 * NEXT_PUBLIC_FIXWIRE_ENVIRONMENT. Page loads and navigations are traced
 * when tracesSampleRate (or tracesSampler) is set.
 */
export function init(options: BrowserOptions = {}): Client {
  const o = withSettings(options, {}, publicSettings());
  if (o.defaultIntegrations !== false)
    o.integrations = resolveIntegrations([browserTracingIntegration()], o.integrations);
  return initBrowser(o);
}

/** Server errors are reported on the server: in the browser this does nothing. */
export async function captureRequestError(
  _error: unknown,
  _request: NextRequestInfo,
  _context: NextErrorContext,
): Promise<void> {}
