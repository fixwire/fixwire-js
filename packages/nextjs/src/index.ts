/**
 * Fixwire for Next.js, on the Node.js runtime. One import serves every
 * runtime: bundlers pick `client.ts` for the browser and `edge.ts` for the
 * edge runtime, and Node.js gets this one.
 *
 *   // instrumentation.ts
 *   import * as Fixwire from "@fixwire/nextjs";
 *   export function register() {
 *     Fixwire.init({ tracesSampleRate: 0.2 }); // FIXWIRE_DSN or NEXT_PUBLIC_FIXWIRE_DSN
 *   }
 *   export const onRequestError = Fixwire.captureRequestError;
 *
 *   // instrumentation-client.ts
 *   import * as Fixwire from "@fixwire/nextjs";
 *   Fixwire.init({ tracesSampleRate: 0.2 });
 *   export const onRouterTransitionStart = Fixwire.onRouterTransitionStart;
 */
import { type Client, init as initNode, type NodeOptions } from "@fixwire/node";

import { withSettings } from "./common.ts";

export * from "@fixwire/node";
export {
  onRouterTransitionStart,
  useCaptureException,
  withFixwireConfig,
} from "./common.ts";

/**
 * Starts the SDK on the server. Unset, the DSN, release and environment
 * come from FIXWIRE_DSN, FIXWIRE_RELEASE and FIXWIRE_ENVIRONMENT, or their
 * NEXT_PUBLIC_ versions.
 */
export function init(options: NodeOptions = {}): Client {
  if (options.useEnvironment === false) return initNode(options);
  const e = process.env;
  return initNode(
    withSettings(
      options,
      { dsn: e.FIXWIRE_DSN, release: e.FIXWIRE_RELEASE, environment: e.FIXWIRE_ENVIRONMENT },
      {
        dsn: e.NEXT_PUBLIC_FIXWIRE_DSN,
        release: e.NEXT_PUBLIC_FIXWIRE_RELEASE,
        environment: e.NEXT_PUBLIC_FIXWIRE_ENVIRONMENT,
      },
    ),
  );
}
