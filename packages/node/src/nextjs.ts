/**
 * Next.js: server errors from the `onRequestError` instrumentation hook
 * (Next 15+), with the route pattern as the transaction:
 *
 *   // instrumentation.ts
 *   import * as Fixwire from "@fixwire/node";
 *   export function register() {
 *     if (process.env.NEXT_RUNTIME === "nodejs") Fixwire.init({ dsn: process.env.FIXWIRE_DSN });
 *   }
 *   export const onRequestError = Fixwire.captureRequestError;
 *
 * The Node.js runtime only; the browser side uses @fixwire/browser (in
 * `instrumentation-client.ts`) and @fixwire/react.
 */
import { getClient, withScope } from "@fixwire/core";

import { safeHeaders } from "./integrations.ts";

/** The request Next.js passes to onRequestError. */
export interface NextRequestInfo {
  /** The path, with its query string. */
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Where the error happened, as Next.js describes it. */
export interface NextErrorContext {
  routerKind: string;
  /** The route pattern, e.g. `/blog/[slug]`. */
  routePath: string;
  /** "render", "route", "action" or "middleware". */
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
}

/**
 * Reports a server error from Next.js' onRequestError hook: the request
 * (allowlisted headers), the route pattern as the transaction, and the
 * router context; then flushes (up to 2 s), as serverless functions may
 * freeze right after.
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
        headers: safeHeaders(request.headers, !!client.options.sendDefaultPii),
        ...(query ? { query_string: query } : {}),
      };
      event.transaction ??= context.routePath;
      return event;
    });
    client.captureException(error, { mechanism: { type: "nextjs.request", handled: false } });
  });
  await client.flush(2000);
}
