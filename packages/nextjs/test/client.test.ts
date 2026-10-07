import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const Fixwire = await import("../src/client.ts");
const { recordsOf, thrown } = await import("../../core/test/helpers.ts");

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the request JSON freely
type Json = Record<string, any>;
const requests: import("@fixwire/browser").TransportRequest[] = [];

after(() => GlobalRegistrator.unregister());

test("init in the browser: the DSN from NEXT_PUBLIC_FIXWIRE_DSN, and tracing installed", () => {
  process.env.NEXT_PUBLIC_FIXWIRE_DSN = "https://publickey@ingest.fixwire.example";
  process.env.NEXT_PUBLIC_FIXWIRE_RELEASE = "web@2.0.0";
  try {
    const client = Fixwire.init({
      transport: Fixwire.makeFetchTransport(async (url, init) => {
        requests.push({
          url: String(url),
          body: String(init?.body),
          headers: init?.headers as Record<string, string>,
        });
        return new Response("{}");
      }),
    });
    assert.equal(client.options.dsn, "https://publickey@ingest.fixwire.example");
    assert.equal(client.options.release, "web@2.0.0");
    assert.deepEqual(
      client.options.integrations?.map((i) => i.name),
      ["BrowserTracing"],
    );
  } finally {
    delete process.env.NEXT_PUBLIC_FIXWIRE_DSN;
    delete process.env.NEXT_PUBLIC_FIXWIRE_RELEASE;
  }
  // A custom one of the same name replaces it; defaultIntegrations: false adds none.
  const own = { ...Fixwire.browserTracingIntegration(), marker: true };
  const mine = Fixwire.init({
    dsn: "https://publickey@ingest.fixwire.example",
    integrations: [own],
  });
  assert.deepEqual(mine.options.integrations, [own]);
  const bare = Fixwire.init({ defaultIntegrations: false });
  assert.equal(bare.options.integrations, undefined);
});

test("useCaptureException reports what an error page shows, once; a server error's digest skips it", async () => {
  requests.length = 0;
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
  const clientError = new TypeError("cart.items is undefined");
  const serverError = Object.assign(
    new Error("An error occurred in the Server Components render."),
    {
      digest: "3141592",
    },
  );
  function ErrorPage({ error }: { error: Error }): React.ReactNode {
    Fixwire.useCaptureException(error);
    return React.createElement("h2", null, "Something went wrong");
  }
  const root = createRoot(document.createElement("div"));
  await React.act(async () => root.render(React.createElement(ErrorPage, { error: clientError })));
  // A re-render with the same error doesn't report it again.
  await React.act(async () => root.render(React.createElement(ErrorPage, { error: clientError })));
  await React.act(async () => root.render(React.createElement(ErrorPage, { error: serverError })));
  await Fixwire.flush();
  const events = recordsOf(requests) as Json[];
  assert.equal(events.length, 1);
  assert.equal(thrown(events[0] as Json).type, "TypeError");
  assert.equal(thrown(events[0] as Json).mechanism.type, "nextjs.error_page");
  await React.act(async () => root.unmount());
});

test("captureRequestError does nothing in the browser", async () => {
  await Fixwire.captureRequestError(
    new Error("x"),
    { path: "/", method: "GET", headers: {} },
    { routerKind: "App Router", routePath: "/", routeType: "render" },
  );
});
