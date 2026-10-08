import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
// Angular's packages are compiled partly: outside an Angular build, the JIT
// compiler finishes them, as TestBed's tests have it.
await import("@angular/compiler");

const { APP_INITIALIZER, createEnvironmentInjector, ErrorHandler, runInInjectionContext } =
  await import("@angular/core");
const { NavigationEnd, NavigationError, Router } = await import("@angular/router");
const { Subject } = await import("rxjs");
const Fixwire = await import("../src/index.ts");
const { recordsOf, thrown } = await import("../../core/test/helpers.ts");

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the request JSON freely
type Json = Record<string, any>;
const requests: import("@fixwire/browser").TransportRequest[] = [];
const events = (): Json[] => recordsOf(requests);
const logged: unknown[][] = [];
const quiet = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args);
};
after(async () => {
  console.error = quiet;
  await GlobalRegistrator.unregister();
});

Fixwire.init({
  dsn: "https://publickey@ingest.fixwire.example",
  defaultIntegrations: false,
  transport: Fixwire.makeFetchTransport(async (url, init) => {
    requests.push({
      url: String(url),
      body: String(init?.body),
      headers: init?.headers as Record<string, string>,
    });
    return new Response("{}");
  }),
});

test("the ErrorHandler reports, then logs as Angular's does; HttpClient's errors described", async () => {
  requests.length = 0;
  logged.length = 0;
  const handler = new Fixwire.FixwireErrorHandler();
  handler.handleError(new TypeError("cart.items is undefined"));
  // What HttpClient hands over: not an Error.
  handler.handleError({
    name: "HttpErrorResponse",
    message: "Http failure response for /api/orders/7: 503 Service Unavailable",
    status: 503,
    statusText: "Service Unavailable",
    url: "http://localhost/api/orders/7",
    ok: false,
    error: { detail: "the order store is down" },
    headers: {},
  });
  // As Angular compiles them: a selector, or the default one.
  const CartComponent = Object.assign(class CartComponent {}, {
    ɵcmp: { selectors: [["app-cart-summary"]] },
  });
  const ShopPage = Object.assign(class ShopPage {}, { ɵcmp: { selectors: [["ng-component"]] } });
  handler.onViewError(new Error("render failed"), {
    declarationType: CartComponent,
    boundary: { type: ShopPage },
  });
  await Fixwire.flush();
  const [cart, http, view] = events();
  assert.equal(thrown(cart as Json).type, "TypeError");
  assert.deepEqual(
    [thrown(cart as Json).mechanism.type, thrown(cart as Json).mechanism.handled],
    ["angular", false],
  );
  assert.equal(thrown(http as Json).type, "HttpErrorResponse");
  assert.equal(
    thrown(http as Json).message,
    "Http failure response for /api/orders/7: 503 Service Unavailable",
  );
  assert.equal(http?.attributes["fixwire.contexts"].http.status, 503);
  assert.equal(http?.attributes["fixwire.tags"]["http.response.status_code"], "503");
  assert.ok(!JSON.stringify(http).includes("the order store is down"), "no response body");
  assert.deepEqual(view?.attributes["fixwire.contexts"].angular, {
    component: "app-cart-summary",
    boundary: "ShopPage",
  });
  assert.equal(thrown(view as Json).mechanism.handled, true);
  assert.equal(logged.length, 3);
  assert.equal(logged[0]?.[0], "ERROR", "logged as Angular's ErrorHandler logs");

  logged.length = 0;
  Fixwire.createErrorHandler({ logErrors: false }).handleError(new Error("quiet"));
  assert.equal(logged.length, 0);
  await Fixwire.flush();
});

test("route names: the matched route's pattern, from the root down", () => {
  const snapshot = {
    routeConfig: null,
    firstChild: {
      routeConfig: { path: "users" },
      firstChild: {
        routeConfig: { path: ":id" },
        firstChild: { routeConfig: { path: "" }, firstChild: null },
      },
    },
  };
  assert.equal(Fixwire.routeName(snapshot), "/users/:id");
  assert.equal(Fixwire.routeName({ routeConfig: null, firstChild: null }), "/");
});

test("provideFixwire: the ErrorHandler, and navigations named after the Router's routes", async () => {
  requests.length = 0;
  const routerEvents = new Subject<unknown>();
  let root = {
    routeConfig: null,
    firstChild: { routeConfig: { path: "orders/:id" }, firstChild: null },
  };
  const router = {
    events: routerEvents,
    get routerState() {
      return { snapshot: { root } };
    },
  };
  const injector = createEnvironmentInjector(
    [Fixwire.provideFixwire(), { provide: Router, useValue: router }],
    // biome-ignore lint/suspicious/noExplicitAny: a root without a parent
    null as any,
  );
  assert.ok(injector.get(ErrorHandler) instanceof Fixwire.FixwireErrorHandler);
  for (const init of injector.get(APP_INITIALIZER)) runInInjectionContext(injector, () => init());

  routerEvents.next(new NavigationEnd(1, "/orders/7", "/orders/7"));
  assert.equal(Fixwire.getIsolationScope().transactionName, "/orders/:id");
  root = { routeConfig: null, firstChild: { routeConfig: { path: "**" }, firstChild: null } };
  routerEvents.next(new NavigationEnd(2, "/nope", "/nope"));
  assert.equal(Fixwire.getIsolationScope().transactionName, "/**");
  routerEvents.next(
    new NavigationError(3, "/reports", new Error("Failed to load the reports chunk")),
  );
  await Fixwire.flush();
  const failed = events().find((e) => thrown(e)?.message === "Failed to load the reports chunk");
  assert.equal(thrown(failed as Json).mechanism.type, "angular.router");

  // Without a Router, only the ErrorHandler.
  const bare = createEnvironmentInjector(
    [Fixwire.provideFixwire()],
    // biome-ignore lint/suspicious/noExplicitAny: a root without a parent
    null as any,
  );
  for (const init of bare.get(APP_INITIALIZER)) runInInjectionContext(bare, () => init());
});
