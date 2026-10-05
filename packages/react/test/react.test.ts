import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const Fixwire = await import("@fixwire/browser");
const { ErrorBoundary, reactErrorHandler, withErrorBoundary } = await import("../src/index.ts");
const { recordsOf, thrown } = await import("../../core/test/helpers.ts");

const { act, createElement: h, useState } = React;

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the request JSON freely
type Json = Record<string, any>;
let requests: import("@fixwire/browser").TransportRequest[] = [];
/** The errors sent: OTLP log records. */
const events = (): Json[] => recordsOf(requests);

function setup(): void {
  requests = [];
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
}

function Exploding({ when }: { when: boolean }): React.ReactNode {
  if (when) throw new TypeError("cart.items is undefined");
  return h("p", null, "cart");
}

const quiet = console.error;
before(() => {
  console.error = () => {}; // React logs caught render errors in development
});
after(async () => {
  console.error = quiet;
  await GlobalRegistrator.unregister();
});

test("an ErrorBoundary reports what it catches and renders the fallback", async () => {
  setup();
  const container = document.createElement("div");
  const root = createRoot(container);
  const seen: Json = {};
  let reset: () => void = () => {};
  function Shop(): React.ReactNode {
    const [broken, setBroken] = useState(true);
    return h(
      ErrorBoundary,
      {
        fallback: ({ error, eventId, componentStack, resetError }) => {
          Object.assign(seen, { error, eventId, componentStack });
          reset = () => {
            setBroken(false);
            resetError();
          };
          return h("p", null, "Something went wrong");
        },
        beforeCapture: (scope) => scope.setTag("area", "cart"),
      },
      h(Exploding, { when: broken }),
    );
  }
  await act(async () => root.render(h(Shop)));
  assert.equal(container.textContent, "Something went wrong");
  assert.match(String(seen.eventId), /^[0-9a-f]{32}$/);
  assert.match(String(seen.componentStack), /Exploding/);
  await act(async () => reset());
  assert.equal(container.textContent, "cart");
  await act(async () => root.unmount());

  assert.ok(await Fixwire.flush(2000));
  const [event] = events() as Json[];
  assert.equal(event?.attributes["fixwire.event_id"], seen.eventId);
  assert.equal(thrown(event as Json).type, "TypeError");
  assert.equal(thrown(event as Json).mechanism.type, "react.errorboundary");
  assert.equal(thrown(event as Json).mechanism.handled, true);
  assert.match(event?.attributes["fixwire.contexts"].react.componentStack, /Exploding/);
  assert.equal(event?.attributes["fixwire.tags"].area, "cart");
});

test("root handlers report uncaught errors once, even next to a boundary", async () => {
  setup();
  const container = document.createElement("div");
  const root = createRoot(container, {
    onUncaughtError: reactErrorHandler(),
    onCaughtError: reactErrorHandler({ handled: true }),
  });
  // Caught by a boundary: reported by the boundary, not again by onCaughtError.
  await act(async () =>
    root.render(h(ErrorBoundary, { fallback: "oops" }, h(Exploding, { when: true }))),
  );
  // No boundary: onUncaughtError reports it as unhandled. (Rendered outside
  // act(), which would rethrow it instead of calling the handler.)
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  root.render(h(Exploding, { when: true }));
  await new Promise((r) => setTimeout(r, 50));
  env.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.unmount());
  assert.ok(await Fixwire.flush(2000));
  const got = events().map((e) => thrown(e).mechanism);
  assert.deepEqual(
    got.map((m) => [m.type, m.handled]),
    [
      ["react.errorboundary", true],
      ["react.root", false],
    ],
  );
  assert.equal(events()[1]?.severityNumber, 21, "fatal");
});

test("withErrorBoundary wraps a component and keeps its name visible", async () => {
  setup();
  const Safe = withErrorBoundary(Exploding, { fallback: h("p", null, "fallback") });
  assert.equal(Safe.displayName, "withErrorBoundary(Exploding)");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(h(Safe, { when: true })));
  assert.equal(container.textContent, "fallback");
  await act(async () => root.unmount());
  assert.ok(await Fixwire.flush(2000));
  assert.equal(events().length, 1);
});
