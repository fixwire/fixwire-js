import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

const { createApp, defineComponent, h, nextTick } = await import("vue");
const { createRouter, createWebHistory } = await import("vue-router");
const Fixwire = await import("../src/index.ts");
const { recordsOf, spansOf, thrown } = await import("../../core/test/helpers.ts");

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the request JSON freely
type Json = Record<string, any>;
const requests: import("@fixwire/browser").TransportRequest[] = [];
const transport = Fixwire.makeFetchTransport(async (url, init) => {
  requests.push({
    url: String(url),
    body: String(init?.body),
    headers: init?.headers as Record<string, string>,
  });
  return new Response("{}");
});
const events = (): Json[] => recordsOf(requests);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const quiet = console.error;
const logged: unknown[] = [];
console.error = (...args: unknown[]) => {
  logged.push(args[0]);
};
after(async () => {
  console.error = quiet;
  await GlobalRegistrator.unregister();
});

const Broken = defineComponent({
  name: "UserCard",
  props: { userId: String },
  setup() {
    return () => {
      throw new TypeError("user.profile is undefined");
    };
  },
});
const Checkout = defineComponent({
  setup() {
    return () =>
      h(
        "button",
        {
          onClick: () => {
            throw new Error("Checkout failed");
          },
        },
        "Check out",
      );
  },
});

function mount(
  component: ReturnType<typeof defineComponent>,
  setup?: (app: ReturnType<typeof createApp>) => void,
) {
  const el = document.createElement("div");
  document.body.append(el);
  const app = createApp({
    name: "ShopApp",
    render: () => h("main", null, [h(component, { userId: "42" })]),
  });
  setup?.(app);
  app.mount(el);
  return { app, el };
}

test("Vue's errors: the component, its parents and the hook as context; logged as Vue would", async () => {
  requests.length = 0;
  logged.length = 0;
  const app = createApp({ render: () => null });
  Fixwire.init({
    dsn: "https://publickey@ingest.fixwire.example",
    app,
    transport,
    defaultIntegrations: false,
  });
  const { app: shop } = mount(Broken, (a) => {
    Fixwire.attachErrorHandler(a);
    Fixwire.attachErrorHandler(a); // twice: still one report
  });
  await Fixwire.flush();
  assert.equal(events().length, 1);
  const [event] = events();
  assert.equal(thrown(event as Json).type, "TypeError");
  assert.equal(thrown(event as Json).mechanism.type, "vue");
  assert.equal(thrown(event as Json).mechanism.handled, false);
  const vue = (event as Json).attributes["fixwire.contexts"].vue;
  assert.equal(vue.componentName, "UserCard");
  assert.deepEqual(vue.componentTrace, ["UserCard", "ShopApp"]);
  assert.match(vue.lifecycleHook, /render/);
  assert.equal(vue.propsData, undefined, "props stay home unless asked for");
  assert.equal((logged[0] as Error).message, "user.profile is undefined");
  shop.unmount();
});

test("an event handler's error, and the app's own errorHandler still called", async () => {
  requests.length = 0;
  logged.length = 0;
  const seen: unknown[] = [];
  const { app, el } = mount(Checkout, (a) => {
    a.config.errorHandler = (error) => {
      seen.push(error);
    };
    Fixwire.attachErrorHandler(a, { attachProps: true });
  });
  el.querySelector("button")?.click();
  await Fixwire.flush();
  assert.equal(events().length, 1);
  assert.equal(thrown(events()[0] as Json).message, "Checkout failed");
  assert.equal(events()[0]?.attributes["fixwire.contexts"].vue.lifecycleHook.length > 0, true);
  assert.equal(seen.length, 1, "the app's handler ran");
  assert.equal(logged.length, 0, "the app's handler decides about logging");
  app.unmount();
});

test("attachProps sends the component's props", async () => {
  requests.length = 0;
  const { app } = mount(Broken, (a) =>
    Fixwire.attachErrorHandler(a, { attachProps: true, logErrors: false }),
  );
  await Fixwire.flush();
  assert.deepEqual(events()[0]?.attributes["fixwire.contexts"].vue.propsData, { userId: "42" });
  app.unmount();
});

test("init({ app, router }): routes name pages, navigations and errors; the router's errors are reported", async () => {
  requests.length = 0;
  const User = defineComponent({ name: "UserPage", setup: () => () => h("h1", null, "User") });
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: "/", component: { render: () => h("p", null, "home") } },
      { path: "/users/:id", component: User },
      {
        path: "/reports",
        component: () => Promise.reject(new Error("Failed to fetch the reports chunk")),
      },
    ],
  });
  const app = createApp({ render: () => h("div") }).use(router);
  Fixwire.init({
    dsn: "https://publickey@ingest.fixwire.example",
    app,
    router,
    transport,
    tracesSampleRate: 1,
    integrations: [Fixwire.browserTracingIntegration({ router, idleTimeout: 10 })],
  });
  app.mount(document.createElement("div"));
  await router.isReady();
  await router.push("/users/42");
  Fixwire.captureMessage("after the navigation");
  await assert.rejects(router.push("/reports"));
  await nextTick();
  await sleep(50);
  await Fixwire.flush();

  const segments = spansOf(requests).filter((s) => !s.parentSpanId);
  const names = segments.map((s) => `${s.attributes["fixwire.op"]} ${s.name}`);
  assert.ok(names.includes("pageload /"), names.join(", "));
  assert.ok(names.includes("navigation /users/:id"), names.join(", "));
  const message = events().find((e) => e.body === "after the navigation");
  assert.equal(message?.attributes["fixwire.transaction"], "/users/:id");
  const chunk = events().find((e) => thrown(e)?.message === "Failed to fetch the reports chunk");
  assert.equal(thrown(chunk as Json).mechanism.type, "vue.router");
});

test("route names leave custom parameter patterns out", () => {
  const name = (pattern: string) =>
    Fixwire.routeName({ path: "/x/1", matched: [{ path: pattern }] });
  assert.equal(name("/users/:id()"), "/users/:id"); // Nuxt
  assert.equal(name("/files/:path(.*)*"), "/files/:path*");
  assert.equal(name("/orders/:id(\\d+(?:-\\d+)?)/items"), "/orders/:id/items");
  assert.equal(name("/a\\(b\\)/:id"), "/a\\(b\\)/:id");
  assert.equal(Fixwire.routeName({ path: "/nowhere", matched: [] }), "/nowhere");
  // Linear: a long pattern of parentheses takes no time.
  const started = performance.now();
  name(`/${"(".repeat(100_000)}${")".repeat(100_000)}`);
  assert.ok(performance.now() - started < 200);
});
