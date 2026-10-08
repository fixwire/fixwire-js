// What the server and browser entries share: the handleError wrapper for
// SvelteKit 3's and 2's shapes, and route names.
import { captureException, setRouteName, withScope } from "@fixwire/core";

/** A request or navigation event, as far as Fixwire reads it. */
export interface EventLike {
  route: { id: string | null };
  url: URL;
}

/**
 * What a handleError hook receives: SvelteKit 3's `{ kind, error, event }`
 * (kind is "app", "framework", "validation" or "unknown") or SvelteKit 2's
 * `{ error, event, status, message }`.
 */
export interface HandleErrorInput<E extends EventLike = EventLike> {
  error: unknown;
  event: E;
  kind?: string;
  issues?: unknown;
  status?: number;
  message?: string;
}

/**
 * Whether an error is a bug to report: SvelteKit 3's unknown errors (not
 * those thrown with `error()`, its own such as 404s, or failed validation),
 * SvelteKit 2's with a 5xx status.
 */
export function isReportable(input: HandleErrorInput): boolean {
  if (input.kind !== undefined) return input.kind === "unknown";
  return (input.status ?? 500) >= 500;
}

/** Reports a handleError hook's error, named after the event's route. */
export function reportHandledError(input: HandleErrorInput, mechanism: string): void {
  if (!isReportable(input)) return;
  const route = input.event?.route?.id;
  if (route) setRouteName(route);
  withScope((scope) => {
    if (input.kind) scope.setTag("sveltekit.kind", input.kind);
    captureException(input.error, { mechanism: { type: mechanism, handled: false } });
  });
}

/**
 * The handleError hook for hooks.server.ts and hooks.client.ts: reports
 * the errors that are bugs, then returns what your handler returns (the
 * App.Error SvelteKit shows), or nothing to keep SvelteKit's defaults.
 */
export function wrapHandleError<I extends HandleErrorInput, R = undefined>(
  mechanism: string,
  handler?: (input: I) => R,
): (input: I) => R | undefined {
  return (input) => {
    try {
      reportHandledError(input, mechanism);
    } catch {
      // handleError must never throw
    }
    return handler?.(input);
  };
}

/** What resolve takes, as far as Fixwire passes it. */
export interface ResolveOptionsLike {
  transformPageChunk?(input: {
    html: string;
    done: boolean;
  }): string | undefined | Promise<string | undefined>;
}

/** What a handle hook receives, as far as Fixwire reads it. */
export interface HandleInput<E extends EventLike = EventLike> {
  event: E;
  resolve(event: E, options?: ResolveOptionsLike): Response | Promise<Response>;
}

/** The meta tag a server-rendered page names its route in, for the browser's page load. */
export const ROUTE_META = "fixwire-route";

/** What afterNavigate passes, as far as Fixwire reads it. */
export interface NavigationLike {
  type?: string;
  to: { route: { id: string | null }; url: URL } | null;
}

/**
 * Names the page after the route it navigated to (`/users/[id]`): pass it
 * to afterNavigate in your root layout.
 *
 * @example
 * // src/routes/+layout.svelte
 * import { afterNavigate } from "$app/navigation";
 * afterNavigate(Fixwire.trackNavigation);
 */
export function trackNavigation(navigation: NavigationLike): void {
  const to = navigation.to;
  if (!to) return;
  if (to.route.id) setRouteName(to.route.id);
  // On the first page SvelteKit may not know the route yet; the server
  // named it (fixwireHandle), and init read that.
  else if (navigation.type !== "enter") setRouteName(to.url.pathname);
}
