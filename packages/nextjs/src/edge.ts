/**
 * Fixwire for Next.js on the edge runtime (`proxy.ts`, and routes with
 * `runtime = "edge"`); bundlers pick it for "@fixwire/nextjs" there.
 * `instrumentation.ts` sets it up as on Node.js.
 */
import {
  type Client,
  type EdgeOptions,
  flush,
  getClient,
  init as initEdge,
  setRouteName,
  withScope,
} from "@fixwire/edge";

import { type NextErrorContext, type NextRequestInfo, withSettings } from "./common.ts";

export * from "@fixwire/edge";
export {
  type NextErrorContext,
  type NextRequestInfo,
  onRouterTransitionStart,
  useCaptureException,
  withFixwireConfig,
} from "./common.ts";

/** What the runtime has of process.env (edge routes get the variables Next inlines). */
const env = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * Starts the SDK on the edge runtime. Unset, the DSN, release and
 * environment come from FIXWIRE_DSN, FIXWIRE_RELEASE and
 * FIXWIRE_ENVIRONMENT, or their NEXT_PUBLIC_ versions.
 */
export function init(options: EdgeOptions = {}): Client {
  if (options.useEnvironment === false) return initEdge(options);
  const e = env();
  return initEdge(
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

/**
 * Reports a server error from Next.js' onRequestError hook on the edge
 * runtime, as the Node.js entry does (route pattern as the transaction, the
 * router context), and waits for the delivery: the isolate may stop right
 * after. Request headers aren't sent here.
 */
export async function captureRequestError(
  error: unknown,
  request: NextRequestInfo,
  context: NextErrorContext,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  const [path, query] = request.path.split("?", 2) as [string, string | undefined];
  const digest = (error as { digest?: unknown } | null)?.digest;
  setRouteName(context.routePath);
  withScope((scope) => {
    scope.setContext("nextjs", {
      ...context,
      digest: typeof digest === "string" ? digest : undefined,
    });
    scope.setTag("nextjs.route_type", context.routeType);
    scope.addEventProcessor((event) => {
      event.request ??= {
        url: path,
        method: request.method,
        ...(query ? { query_string: query } : {}),
      };
      event.transaction ??= context.routePath;
      return event;
    });
    client.captureException(error, { mechanism: { type: "nextjs.request", handled: false } });
  });
  await flush(2000);
}
