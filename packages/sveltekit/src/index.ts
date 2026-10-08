/**
 * Fixwire for SvelteKit on the server (Node.js: adapter-node, and the
 * serverless adapters' Node.js runtimes). Bundlers pick `client.ts` for the
 * browser.
 *
 *   // src/hooks.server.ts
 *   import * as Fixwire from "@fixwire/sveltekit";
 *   import { sequence } from "@sveltejs/kit/hooks";
 *
 *   export const init = () => Fixwire.init({ tracesSampleRate: 0.2 }); // FIXWIRE_DSN
 *   export const handle = sequence(Fixwire.fixwireHandle(), yourHandle);
 *   export const handleError = Fixwire.handleErrorWithFixwire();
 */
import {
  type Client,
  getTraceMetaTags,
  init as initNode,
  type NodeOptions,
  setRouteName,
} from "@fixwire/node";

import {
  type EventLike,
  type HandleErrorInput,
  type HandleInput,
  ROUTE_META,
  wrapHandleError,
} from "./common.ts";

export * from "@fixwire/node";
export {
  type EventLike,
  type HandleErrorInput,
  type HandleInput,
  type NavigationLike,
  trackNavigation,
} from "./common.ts";

/**
 * Starts the SDK on the server. Unset, the DSN, release and environment
 * come from FIXWIRE_DSN, FIXWIRE_RELEASE and FIXWIRE_ENVIRONMENT, or the
 * PUBLIC_FIXWIRE_ ones the browser reads.
 */
export function init(options: NodeOptions = {}): Client {
  const o = { ...options };
  if (o.useEnvironment !== false) {
    const e = process.env;
    o.dsn ??= e.FIXWIRE_DSN || e.PUBLIC_FIXWIRE_DSN || undefined;
    o.release ??= e.FIXWIRE_RELEASE || e.PUBLIC_FIXWIRE_RELEASE || undefined;
    o.environment ??= e.FIXWIRE_ENVIRONMENT || e.PUBLIC_FIXWIRE_ENVIRONMENT || undefined;
  }
  return initNode(o);
}

/**
 * The server's handleError hook: reports unexpected errors (SvelteKit 3's
 * `kind: "unknown"`, SvelteKit 2's 5xx), named after their route, then
 * returns what `handler` returns.
 *
 * @example
 * export const handleError = Fixwire.handleErrorWithFixwire(({ error }) => ({ message: "Sorry!" }));
 */
export function handleErrorWithFixwire<I extends HandleErrorInput, R = undefined>(
  handler?: (input: I) => R,
): (input: I) => R | undefined {
  return wrapHandleError("sveltekit.server", handler);
}

const escapeAttribute = (s: string): string => s.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A handle hook that names each request after its route (`GET
 * /users/[id]`), so traces and errors group by route. A rendered page's
 * head gets the route and the request's trace, so the browser names its
 * page load after the route and continues the trace. First in `sequence()`.
 */
export function fixwireHandle(): <E extends EventLike>(input: HandleInput<E>) => Promise<Response> {
  return async ({ event, resolve }) => {
    const route = event.route.id;
    if (route) setRouteName(route);
    let added = false;
    return resolve(event, {
      transformPageChunk: ({ html }) => {
        const at = added ? -1 : html.indexOf("</head>");
        if (at < 0) return html;
        added = true;
        const named = route
          ? `<meta name="${ROUTE_META}" content="${escapeAttribute(route)}"/>`
          : "";
        return `${html.slice(0, at)}${getTraceMetaTags()}${named}${html.slice(at)}`;
      },
    });
  };
}
