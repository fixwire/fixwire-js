import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
const Fixwire = await import("../src/client.ts");
after(() => GlobalRegistrator.unregister());

test("the browser: tracing installed, navigations named after their routes, handleError reports bugs", async () => {
  // The server named the page's route in its head (fixwireHandle).
  const meta = document.createElement("meta");
  meta.setAttribute("name", "fixwire-route");
  meta.setAttribute("content", "/shop/[category]");
  document.head.append(meta);
  const sent: string[] = [];
  const client = Fixwire.init({
    dsn: "https://publickey@ingest.fixwire.example",
    transport: Fixwire.makeFetchTransport(async (_url, init) => {
      sent.push(String(init?.body));
      return new Response("{}");
    }),
  });
  assert.deepEqual(
    client.options.integrations?.map((i) => i.name),
    ["BrowserTracing"],
  );
  Fixwire.trackNavigation({
    to: { route: { id: "/users/[id]" }, url: new URL("http://localhost/users/7") },
  });
  assert.equal(Fixwire.getIsolationScope().transactionName, "/users/[id]");
  Fixwire.trackNavigation({ to: { route: { id: null }, url: new URL("http://localhost/nope") } });
  assert.equal(Fixwire.getIsolationScope().transactionName, "/nope");

  const handleError = Fixwire.handleErrorWithFixwire();
  const navigation = { route: { id: "/reports" }, url: new URL("http://localhost/reports") };
  handleError({ kind: "unknown", error: new Error("load failed"), event: navigation });
  handleError({ kind: "framework", error: new Error("Not found"), event: navigation });
  await Fixwire.flush();
  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.includes("load failed") && sent[0]?.includes("sveltekit.client"));
  const response = await Fixwire.fixwireHandle()({
    event: navigation,
    resolve: async () => new Response("passed on"),
  });
  assert.equal(await response.text(), "passed on");
});
