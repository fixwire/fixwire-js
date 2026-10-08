// The Router: pages, navigations and the errors after them named after the
// route that matched (`/users/:id`), and failed navigations reported.

import { EventType, type Router } from "@angular/router";
import { captureException, setRouteName } from "@fixwire/browser";

/** A route snapshot, as far as Fixwire reads it. */
export interface RouteSnapshotLike {
  readonly routeConfig: { readonly path?: string } | null;
  readonly firstChild: RouteSnapshotLike | null;
}

/** The matched route's pattern, from the root down its primary outlets: `/users/:id`. */
export function routeName(root: RouteSnapshotLike): string {
  const parts: string[] = [];
  for (let r: RouteSnapshotLike | null = root; r; r = r.firstChild) {
    const path = r.routeConfig?.path;
    if (path) parts.push(path);
  }
  return `/${parts.join("/")}`;
}

const instrumented = new WeakSet<Router>();

/** Names navigations after their routes and reports the ones that fail. Once per router. */
export function instrumentRouter(router: Router): void {
  if (instrumented.has(router)) return;
  instrumented.add(router);
  router.events.subscribe((event) => {
    if (event.type === EventType.NavigationEnd) {
      setRouteName(routeName(router.routerState.snapshot.root));
    } else if (event.type === EventType.NavigationError) {
      captureException(event.error, { mechanism: { type: "angular.router", handled: false } });
    }
  });
}
