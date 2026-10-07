// vue-router: pages and navigations named after the route they matched
// (`/users/:id`), and the router's own errors reported.
import { captureException, setRouteName } from "@fixwire/core";

/** A route, as vue-router (4 or 5) and Nuxt's router give it. */
export interface RouteLike {
  path: string;
  matched: readonly { path: string }[];
}

/** What Fixwire uses of a vue-router router (4 or 5) or Nuxt's. */
export interface RouterLike {
  afterEach(guard: (to: RouteLike, from: RouteLike, failure?: unknown) => unknown): () => void;
  onError(handler: (error: unknown) => unknown): () => void;
  readonly currentRoute?: { readonly value: RouteLike };
}

/**
 * The route's pattern (`/users/:id`), or its path when no route matched.
 * Custom parameter patterns are left out: `/orders/:id(\\d+)` and Nuxt's
 * `/users/:id()` are `/orders/:id` and `/users/:id`.
 */
export function routeName(route: RouteLike): string {
  const pattern = route.matched.at(-1)?.path;
  if (!pattern) return route.path;
  if (!pattern.includes("(")) return pattern;
  // One pass: parentheses nest, and a backslash escapes the next character.
  let out = "";
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      if (depth === 0) out += pattern.slice(i, i + 2);
      i++;
    } else if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

const instrumented = new WeakSet<RouterLike>();

/**
 * Names pages, navigations and the errors after them after the router's
 * routes, and reports the errors it hits (a failed lazy route, a guard that
 * throws). Once per router; `init({ router })` does it.
 */
export function instrumentRouter(router: RouterLike): void {
  if (instrumented.has(router)) return;
  instrumented.add(router);
  router.onError((error) => {
    captureException(error, { mechanism: { type: "vue.router", handled: false } });
  });
  router.afterEach((to, _from, failure) => {
    if (!failure) setRouteName(routeName(to));
  });
  // The router may have settled on its first route already.
  const current = router.currentRoute?.value;
  if (current?.matched.length) setRouteName(routeName(current));
}
