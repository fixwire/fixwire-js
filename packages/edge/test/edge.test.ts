import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";

import { bodiesOf, type Json, recordsOf, spansOf, thrown } from "../../core/test/helpers.ts";
import * as Fixwire from "../src/index.ts";

/** A request received: as the SDK sent it, its body unzipped. */
type Received = Fixwire.TransportRequest & { headers: IncomingHttpHeaders };

/** An HTTP server that records what it receives (the SDK's requests, or a downstream service's). */
async function listen(): Promise<{ server: Server; url: string; got: Received[] }> {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      got.push({
        url: `http://${req.headers.host}${req.url}`,
        headers: req.headers,
        body: body.toString("utf8"),
      } as Received);
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close()); // a failed assertion must not keep the test process alive
  return { server, url: `127.0.0.1:${(server.address() as { port: number }).port}`, got };
}

test("requests keep their own scopes, errors are reported, and events go out through waitUntil", async () => {
  const ingest = await listen();
  Fixwire.init({
    dsn: `http://publickey@${ingest.url}`,
    asyncLocalStorage: AsyncLocalStorage,
    tracesSampleRate: 1,
    defaultIntegrations: false,
  });
  const waits: Promise<unknown>[] = [];
  const handler = Fixwire.wrapRequestHandler(
    async (request) => {
      const card = new URL(request.url).searchParams.get("card") ?? "";
      Fixwire.setTag("card", card);
      // The two requests interleave: each must keep its own tag.
      await new Promise((r) => setTimeout(r, card === "4000" ? 5 : 30));
      if (card === "4000") throw new Error(`card ${card} declined`);
      return new Response("ok");
    },
    { waitUntil: (p) => waits.push(p) },
  );
  const [declined, ok] = await Promise.allSettled([
    handler(
      new Request("https://shop.example/pay?card=4000", {
        headers: { cookie: "s=1", "user-agent": "curl/8.7" },
      }),
    ),
    handler(new Request("https://shop.example/pay?card=1234")),
  ]);
  assert.equal(declined.status, "rejected");
  assert.equal(ok.status, "fulfilled");
  assert.equal(waits.length, 2, "each request hands its flush to waitUntil");
  await Promise.all(waits);

  const [event] = recordsOf(ingest.got) as Json[];
  const a = event?.attributes as Json;
  assert.equal(a["fixwire.tags"].card, "4000");
  assert.equal(event?.resource["telemetry.sdk.name"], "fixwire.javascript.edge");
  assert.equal(event?.resource["telemetry.sdk.language"], "nodejs");
  assert.equal(a["url.full"], "https://shop.example/pay");
  assert.equal(a["user_agent.original"], "curl/8.7");
  assert.equal(a["http.request.header.cookie"], undefined, "cookies are never sent");
  assert.equal(thrown(event as Json).mechanism.type, "edge");
  assert.equal(ingest.got[0]?.headers["content-encoding"], "gzip");
  assert.equal(ingest.got[0]?.headers.authorization, "Bearer publickey");
  const segment = spansOf(ingest.got).find((s) => s.name === "GET /pay");
  assert.ok(segment, "each request is traced");
  assert.equal(segment.kind, 2);
  await Fixwire.close();
});

test("withFixwire: a Workers module starts from env, and its fetch and cron errors are reported", async () => {
  const ingest = await listen();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const env = { FIXWIRE_DSN: `http://publickey@${ingest.url}`, FIXWIRE_RELEASE: "worker@2.0.0" };
  const worker = Fixwire.withFixwire(
    () => ({ asyncLocalStorage: AsyncLocalStorage, defaultIntegrations: false }),
    {
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/boom") throw new Error("fetch failed");
        return new Response("ok");
      },
      async scheduled(controller: { cron: string }) {
        throw new Error(`cron ${controller.cron} failed`);
      },
      tail: "untouched",
    },
  );
  assert.equal((await worker.fetch(new Request("https://w.example/"), env, ctx)).status, 200);
  await assert.rejects(
    worker.fetch(new Request("https://w.example/boom"), env, ctx),
    /fetch failed/,
  );
  await assert.rejects(
    worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() }, env, ctx),
    /cron/,
  );
  assert.equal(worker.tail, "untouched");
  await Promise.all(waits);

  const events = recordsOf(ingest.got);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.resource["service.version"], "worker@2.0.0", "release from env");
  assert.equal(thrown(events[0] as Json).mechanism.type, "edge");
  assert.equal(thrown(events[1] as Json).mechanism.type, "cloudflare");
  assert.equal(
    events[1]?.attributes["fixwire.tags"]["worker.trigger"],
    "function.cloudflare.scheduled",
  );
  // Each invocation is a session for release health.
  const counts = bodiesOf(ingest.got, "/v1/sessions")
    .flatMap((b) => b.aggregates)
    .reduce((c: Record<string, number>, a: Record<string, number>) => {
      for (const k of ["exited", "errored", "crashed"]) c[k] = (c[k] ?? 0) + (a[k] ?? 0);
      return c;
    }, {});
  assert.deepEqual(counts, { exited: 1, errored: 0, crashed: 2 });
  await Fixwire.close();
});

test("fetch calls are spans, and carry the trace to allowed hosts", async () => {
  const ingest = await listen();
  const downstream = await listen();
  Fixwire.init({
    dsn: `http://publickey@${ingest.url}`,
    asyncLocalStorage: AsyncLocalStorage,
    tracesSampleRate: 1,
    tracePropagationTargets: ["127.0.0.1"],
  });
  const traceId = await Fixwire.startSpan(
    { name: "checkout", forceSegment: true },
    async (span) => {
      await fetch(`http://${downstream.url}/stock?sku=1`);
      return span.traceId;
    },
  );
  await Fixwire.flush(2000);
  const traceparent = String(downstream.got[0]?.headers.traceparent ?? "");
  assert.match(traceparent, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
  const spans = spansOf(ingest.got);
  const call = spans.find((s) => s.name === `GET http://${downstream.url}/stock`);
  assert.ok(call, `no http.client span among ${spans.map((s) => s.name)}`);
  assert.equal(
    ingest.got.length > 0 && ingest.got.every((r) => r.headers.traceparent === undefined),
    true,
    "deliveries aren't traced",
  );
  await Fixwire.close();
});
