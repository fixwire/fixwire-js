import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { hostname } from "node:os";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import {
  bodiesOf,
  recordsOf as events,
  type Json,
  pathOf,
  spansOf,
  thrown,
} from "../../core/test/helpers.ts";
import * as Fixwire from "../src/index.ts";

/** What the ingest received: each request as the SDK sent it, its body unzipped. */
type Received = Fixwire.TransportRequest & { headers: Record<string, string> };

async function ingest(): Promise<{ server: Server; dsn: string; got: Received[] }> {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      got.push({
        url: `http://${req.headers.host}${req.url}`,
        headers: req.headers as Record<string, string>,
        body: body.toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, dsn: `http://publickey@127.0.0.1:${port}`, got };
}

function charge(card: string): never {
  throw new Error(`card ${card} declined for ada@example.com`);
}

test("an error reaches the ingest, gzipped, with context and redacted", async () => {
  const { server, dsn, got } = await ingest();
  const client = Fixwire.init({ dsn, release: "api@1.4.0", defaultIntegrations: false });
  Fixwire.setTag("region", "eu");
  try {
    charge("4111 1111 1111 1111");
  } catch (e) {
    Fixwire.captureException(e);
  }
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  server.close();
  const [req] = got;
  assert.equal(pathOf(req as Received), "/v1/logs");
  assert.equal(req?.headers.authorization, "Bearer publickey");
  assert.equal(req?.headers["content-type"], "application/json");
  assert.equal(req?.headers["content-encoding"], "gzip");
  const [event] = events(got) as Json[];
  assert.equal(event?.resource["telemetry.sdk.name"], "fixwire.javascript.node");
  assert.equal(event?.resource["telemetry.sdk.language"], "nodejs");
  assert.equal(event?.resource["service.version"], "api@1.4.0");
  assert.equal(event?.resource["host.name"], hostname());
  assert.equal(event?.attributes["fixwire.tags"].region, "eu");
  assert.equal(event?.attributes["fixwire.contexts"].runtime.name, "node");
  const ex = thrown(event as Json);
  assert.equal(ex.message, "card [REDACTED:credit_card] declined for [REDACTED:email]");
  assert.equal(event?.attributes["exception.message"], ex.message);
  const frame = ex.frames.at(-1);
  assert.equal(frame.function, "charge");
  assert.ok(frame.in_app && frame.context_line.includes("throw new Error"));
  assert.ok(Array.isArray(frame.pre_context));
});

test("a crash loop costs a few events", async () => {
  const { server, dsn, got } = await ingest();
  const client = Fixwire.init({
    dsn,
    defaultIntegrations: false,
    rateLimit: { perIssueBurst: 5, perIssuePerMinute: 0.0001 },
  });
  for (let i = 0; i < 100; i++) {
    try {
      charge("x");
    } catch (e) {
      client.captureException(e);
    }
  }
  assert.ok(await client.flush(5000));
  await client.close();
  server.close();
  assert.equal(events(got).length, 5);
});

test("each HTTP request has its own isolation scope", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  const client = Fixwire.init({ dsn });
  const app = createServer(async (req, res) => {
    Fixwire.setTag("route", req.url ?? "");
    await new Promise((r) => setTimeout(r, Math.random() * 20));
    Fixwire.captureMessage(`handled ${req.url}`);
    res.end("ok");
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as { port: number }).port;
  const hit = (path: string) =>
    new Promise<void>((resolve) =>
      request({ host: "127.0.0.1", port, path }, (res) => res.resume().on("end", resolve)).end(),
    );
  await Promise.all(["/a", "/b", "/c", "/d"].map(hit));
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  app.close();
  ingestServer.close();
  const byMessage = Object.fromEntries(
    events(got).map((e) => [e.body, e.attributes["fixwire.tags"].route]),
  );
  assert.deepEqual(byMessage, {
    "handled /a": "/a",
    "handled /b": "/b",
    "handled /c": "/c",
    "handled /d": "/d",
  });
});

test("each HTTP request is a session, sent as per-minute aggregates", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  const client = Fixwire.init({ dsn, release: "api@2.0.0" });
  const app = createServer((req, res) => {
    Fixwire.setUser({ id: req.url === "/crash" ? "u2" : "u1" });
    if (req.url === "/handled") Fixwire.captureException(new Error("retrying"));
    if (req.url === "/crash")
      Fixwire.captureException(new Error("boom"), { mechanism: { type: "http", handled: false } });
    res.writeHead(req.url === "/crash" ? 500 : 200).end("ok");
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as { port: number }).port;
  const hit = (path: string) =>
    new Promise<void>((resolve) =>
      request({ host: "127.0.0.1", port, path }, (res) => res.resume().on("end", resolve)).end(),
    );
  for (const path of ["/ok", "/ok", "/handled", "/crash"]) await hit(path);
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  app.close();
  ingestServer.close();
  const batches = bodiesOf(got, "/v1/sessions");
  assert.equal(batches.length, 1);
  const sum = (k: string) =>
    batches[0]?.aggregates.reduce((n: number, a: Record<string, number>) => n + (a[k] ?? 0), 0);
  // The SDK's own deliveries to the in-process ingest are not sessions.
  assert.deepEqual([sum("exited"), sum("errored"), sum("crashed")], [2, 1, 1]);
  assert.equal(batches[0]?.release, "api@2.0.0");
  assert.deepEqual(batches[0]?.sdk.name, "fixwire.javascript.node");
});

test("an uncaught exception is reported before the process exits", async () => {
  const { server, dsn, got } = await ingest();
  // A URL, not a path: on Windows, import() reads D:\\… as a URL scheme.
  const index = new URL("../src/index.ts", import.meta.url).href;
  const script = `
    const Fixwire = await import(${JSON.stringify(index)});
    Fixwire.init({ dsn: ${JSON.stringify(dsn)} });
    setTimeout(() => { throw new Error('boom in a timer'); }, 10);
  `;
  const run = new Promise<number | null>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--conditions=fixwire-source", "--input-type=module", "-e", script],
      { stdio: "ignore" },
    );
    child.on("exit", resolve);
  });
  const code = await run;
  server.close();
  assert.equal(code, 1);
  const [event] = events(got) as Json[];
  assert.equal(event?.severityNumber, 21);
  assert.equal(thrown(event as Json).mechanism.type, "onuncaughtexception");
  assert.equal(event?.attributes["fixwire.handled"], false);
});

test("events carry the request, privately, and the Express route", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  const client = Fixwire.init({ dsn });
  const app = createServer((req, res) => {
    // What Express sets once a route matched.
    Object.assign(req, { baseUrl: "/api", route: { path: "/orders/:id" } });
    const handler = Fixwire.expressErrorHandler();
    handler(new Error("order lookup failed"), req, res, () => res.writeHead(500).end());
    handler(Object.assign(new Error("not found"), { status: 404 }), req, res, () => undefined);
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as { port: number }).port;
  await new Promise<void>((resolve) =>
    request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/orders/9?expand=items",
        headers: { cookie: "sid=1", authorization: "Bearer x", "user-agent": "test" },
      },
      (res) => res.resume().on("end", resolve),
    ).end(),
  );
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  app.close();
  ingestServer.close();
  const all = events(got);
  assert.equal(all.length, 1); // the 404 is not reported
  const [event] = all as Json[];
  const a = event?.attributes as Json;
  assert.equal(a["fixwire.transaction"], "/api/orders/:id");
  assert.equal(a["http.request.method"], "GET");
  assert.equal(a["url.full"], `http://127.0.0.1:${port}/api/orders/9`);
  assert.equal(a["url.query"], "expand=items");
  assert.equal(a["user_agent.original"], "test");
  assert.equal(a["http.request.header.host"], `127.0.0.1:${port}`);
  assert.equal(a["http.request.header.cookie"], undefined);
  assert.equal(a["http.request.header.authorization"], undefined);
  assert.equal(thrown(event as Json).mechanism.type, "express");
});

test("the file spool keeps requests through an outage and a restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fixwire-spool-"));
  // A port nothing listens on: the server is down.
  const down = Fixwire.init({
    dsn: "http://publickey@127.0.0.1:9",
    defaultIntegrations: false,
    offline: dir,
  });
  down.captureMessage("written during the outage");
  await down.flush(300);
  await Fixwire.close(100);

  // The server is back; the next start delivers what was left.
  const { server, dsn, got } = await ingest();
  const up = Fixwire.init({ dsn, defaultIntegrations: false, offline: dir });
  assert.ok(await up.flush(5000));
  await Fixwire.close();
  server.close();
  assert.ok(events(got).some((e) => e.body === "written during the outage"));
  assert.equal(got[0]?.headers.authorization, "Bearer publickey");
  const left = await Fixwire.makeFileSpool(
    { offline: dir },
    { publicKey: "publickey", baseUrl: "http://127.0.0.1:9" },
  )?.load();
  assert.equal(left?.length, 0);
});

/** A service the app calls: it records the trace headers it receives. */
async function downstream(): Promise<{
  server: Server;
  base: string;
  seen: Record<string, string>[];
}> {
  const seen: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    seen.push({
      path: req.url ?? "",
      traceparent: String(req.headers.traceparent ?? ""),
      tracestate: String(req.headers.tracestate ?? ""),
      baggage: String(req.headers.baggage ?? ""),
    });
    res.writeHead(req.url === "/missing" ? 404 : 200).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}`, seen };
}

const INCOMING_TRACE = "0af7651916cd43dd8448eb211c80319c";
const INCOMING_PARENT = "b7ad6b7169203331";

test("a request is a segment; its queries and outgoing calls are children, and the trace goes on", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  const svc = await downstream();
  const client = Fixwire.init({
    dsn,
    release: "api@2.0.0",
    tracesSampleRate: 1,
    tracePropagationTargets: [svc.base],
  });
  const app = createServer(async (req, res) => {
    Object.assign(req, { route: { path: "/orders/:id" } }); // what Express sets
    await Fixwire.startSpan(
      { name: "SELECT order", op: "db.query" },
      () => new Promise((r) => setTimeout(r, 5)),
    );
    await new Promise<void>((resolve) =>
      request(`${svc.base}/stock?sku=1`, (r) => r.resume().on("end", resolve)).end(),
    );
    await (await fetch(`${svc.base}/missing`)).text();
    res.end("ok");
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as { port: number }).port;
  await new Promise<void>((resolve) =>
    request(
      {
        host: "127.0.0.1",
        port,
        path: "/orders/42?expand=1",
        headers: {
          traceparent: `00-${INCOMING_TRACE}-${INCOMING_PARENT}-01`,
          tracestate: "vendor=x",
          baggage: "tenant=acme",
        },
      },
      (res) => res.resume().on("end", resolve),
    ).end(),
  );
  await new Promise((r) => setTimeout(r, 20)); // the segment ends on "finish"
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  app.close();
  svc.server.close();
  ingestServer.close();

  const spans = spansOf(got);
  // The test's ingest runs in this process: its requests are not traced.
  assert.ok(!spans.some((s) => s.name.startsWith("POST /v1/")));
  const segment = spans.find((s) => s.attributes["url.path"] === "/orders/42");
  assert.ok(segment, JSON.stringify(spans.map((s) => s.name)));
  assert.equal(segment.name, "GET /orders/:id");
  assert.equal(segment.traceId, INCOMING_TRACE);
  assert.equal(segment.parentSpanId, INCOMING_PARENT);
  assert.equal(segment.flags, 0x301, "a remote parent: the caller's");
  assert.equal(segment.kind, 2);
  assert.equal(segment.resource["service.version"], "api@2.0.0");
  assert.equal(segment.attributes["fixwire.op"], "http.server");
  assert.equal(segment.attributes["http.route"], "/orders/:id");
  assert.equal(segment.attributes["http.response.status_code"], 200);

  const byOp = (op: string) => spans.filter((s) => s.attributes["fixwire.op"] === op);
  assert.equal(byOp("db.query").length, 1);
  const calls = byOp("http.client");
  assert.deepEqual(calls.map((s) => s.name).sort(), [
    `GET ${svc.base}/missing`,
    `GET ${svc.base}/stock`,
  ]);
  for (const s of [...calls, ...byOp("db.query")]) {
    assert.equal(s.parentSpanId, segment.spanId);
    assert.equal(s.traceId, INCOMING_TRACE);
    assert.equal(s.flags, 0x101, "a local parent");
  }
  const missing = calls.find((s) => s.name.endsWith("/missing"));
  assert.deepEqual(missing?.status, { code: 2 });
  assert.equal(missing?.kind, 3);
  assert.equal(missing?.attributes["http.response.status_code"], 404);
  assert.equal(missing?.attributes["fixwire.origin"], "auto.http.node.fetch");

  // Downstream continues from the client spans, with the caller's
  // decision, tracestate and baggage.
  assert.equal(svc.seen.length, 2);
  for (const h of svc.seen) {
    const call = calls.find((s) => s.name.endsWith(h.path.split("?")[0] as string));
    assert.equal(h.traceparent, `00-${INCOMING_TRACE}-${call?.spanId}-01`);
    assert.equal(h.tracestate, "vendor=x");
    assert.equal(h.baggage, "tenant=acme");
  }
  // The downstream service (in this process too) records its own segments under them.
  for (const call of calls) {
    const child = spans.find((s) => s.parentSpanId === call.spanId);
    assert.equal(child?.traceId, INCOMING_TRACE);
    assert.equal(child?.flags, 0x301);
  }
});

test("without tracing, errors still carry the caller's trace and nothing leaves unasked", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  const svc = await downstream();
  const client = Fixwire.init({ dsn });
  const app = createServer(async (_req, res) => {
    await (await fetch(`${svc.base}/stock`)).text();
    Fixwire.captureMessage("stock checked");
    res.end("ok");
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as { port: number }).port;
  await new Promise<void>((resolve) =>
    request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { traceparent: `00-${INCOMING_TRACE}-${INCOMING_PARENT}-01` },
      },
      (res) => res.resume().on("end", resolve),
    ).end(),
  );
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  app.close();
  svc.server.close();
  ingestServer.close();
  assert.equal(spansOf(got).length, 0);
  const [event] = events(got) as Json[];
  assert.equal(event?.traceId, INCOMING_TRACE);
  assert.match(event?.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(event?.spanId, INCOMING_PARENT);
  assert.equal(svc.seen[0]?.traceparent, ""); // no tracePropagationTargets
  const crumb = event?.attributes["fixwire.breadcrumbs"].find(
    (b: { category: string; data?: { url?: string } }) =>
      b.category === "http" && b.data?.url === `${svc.base}/stock`,
  );
  assert.equal(crumb?.data.method, "GET");
  assert.equal(crumb?.data.status_code, 200);
});

test("Next.js onRequestError: the route pattern, the request (privately), flushed", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  Fixwire.init({ dsn, defaultIntegrations: false });
  const error = Object.assign(new Error("post not found in the CMS"), { digest: "2473915" });
  await Fixwire.captureRequestError(
    error,
    {
      path: "/blog/hello-world?preview=1",
      method: "GET",
      headers: { "user-agent": "test", cookie: "sid=1", Authorization: "Bearer x" },
    },
    {
      routerKind: "App Router",
      routePath: "/blog/[slug]",
      routeType: "render",
      renderSource: "react-server-components",
    },
  );
  assert.equal(events(got).length, 1); // flushed before it returned
  await Fixwire.close();
  ingestServer.close();
  const [event] = events(got) as Json[];
  const a = event?.attributes as Json;
  assert.equal(a["fixwire.transaction"], "/blog/[slug]");
  assert.equal(a["url.full"], "/blog/hello-world");
  assert.equal(a["url.query"], "preview=1");
  assert.equal(a["user_agent.original"], "test");
  assert.deepEqual(
    Object.keys(a).filter((k) => k.startsWith("http.request.header.")),
    [],
    "no cookie, no authorization",
  );
  assert.equal(a["fixwire.contexts"].nextjs.digest, "2473915");
  assert.equal(a["fixwire.contexts"].nextjs.routerKind, "App Router");
  assert.equal(a["fixwire.tags"]["nextjs.route_type"], "render");
  assert.equal(thrown(event as Json).mechanism.type, "nextjs.request");
  assert.equal(event?.severityNumber, 21);
});

test("serverless: each invocation is its own segment, errors are reported and flushed before returning", async () => {
  const { server: ingestServer, dsn, got } = await ingest();
  Fixwire.init({ dsn, defaultIntegrations: false, tracesSampleRate: 1 });
  const context = {
    functionName: "charge-card",
    awsRequestId: "req-1",
    getRemainingTimeInMillis: () => 30_000,
  };
  const handler = Fixwire.wrapHandler(async (event: { card: string }, _ctx: typeof context) => {
    Fixwire.setTag("card", event.card);
    if (event.card === "4000") charge(event.card);
    return { ok: true };
  });
  const started = Date.now();
  assert.deepEqual(await handler({ card: "1234" }, context), { ok: true });
  await assert.rejects(handler({ card: "4000" }, context), /declined/);
  assert.equal(events(got).length, 1); // flushed before the handler returned
  // Flushing returns once the events are sent, not at its timeout: an
  // in-process ingest (or a relay) isn't traced as the app's traffic.
  assert.ok(Date.now() - started < 1500, `two invocations took ${Date.now() - started} ms`);
  assert.ok(spansOf(got).length >= 1, "the invocations are traced");
  await Fixwire.close();
  ingestServer.close();
  const [event] = events(got) as Json[];
  const a = event?.attributes as Json;
  assert.equal(a["fixwire.contexts"].aws_lambda.function_name, "charge-card");
  assert.equal(a["fixwire.contexts"].aws_lambda.aws_request_id, "req-1");
  assert.equal(a["fixwire.tags"]["serverless.function"], "charge-card");
  assert.equal(a["fixwire.tags"].card, "4000"); // its own scope: not the first call's tag
  assert.equal(thrown(event as Json).mechanism.type, "serverless");
});

test("context lines come only from regular files of a source file's size", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { addContextLines } = await import("../src/context-lines.ts");
  const dir = mkdtempSync(join(tmpdir(), "fixwire-context-"));
  const small = join(dir, "small.js");
  writeFileSync(small, "a();\nthrow new Error('x');\nb();\n");
  const big = join(dir, "big.js");
  writeFileSync(big, "x();\n".repeat(1_000_000)); // 5 MB
  // A frame's path is text a message can fake: a FIFO would block forever,
  // /dev/zero would be read until memory runs out.
  const fifo = join(dir, "fifo");
  const special = process.platform === "win32" ? [] : ["/dev/zero"];
  if (process.platform !== "win32" && spawnSync("mkfifo", [fifo]).status === 0) special.push(fifo);
  const frames = [small, big, ...special].map((filename) => ({
    filename,
    lineno: 2,
    in_app: true,
  }));
  const event = { exception: { values: [{ type: "Error", stacktrace: { frames } }] } };
  const done = addContextLines(event).then(() => "done");
  const timeout = new Promise((r) => setTimeout(() => r("timed out"), 3000).unref());
  assert.equal(await Promise.race([done, timeout]), "done");
  assert.deepEqual(
    frames.map((f) => (f as { context_line?: string }).context_line),
    ["throw new Error('x');", ...frames.slice(1).map(() => undefined)],
  );
});

test("the file spool is private to its user and sends only to the ingest", async () => {
  const {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
  } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = join(mkdtempSync(join(tmpdir(), "fixwire-spool-")), "spool");
  const dsn = { publicKey: "publickey", baseUrl: "http://127.0.0.1:9" };
  const request = {
    path: "/v1/logs",
    contentType: "application/json",
    body: "{}",
    headers: {},
    category: "error",
  };
  const id = await Fixwire.makeFileSpool({ offline: dir }, dsn)?.put(request);
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, String(id))).mode & 0o777, 0o600);
  }
  // A request file naming another host (its path is appended to the DSN's
  // base URL) is dropped, not sent with the key.
  const forged = join(dir, `${Date.now().toString().padStart(15, "0")}-forged.req`);
  writeFileSync(forged, `${JSON.stringify({ ...request, path: "@evil.example/x" })}\n{}`);
  const loaded = await Fixwire.makeFileSpool({ offline: dir }, dsn)?.load();
  assert.deepEqual(
    loaded?.map((r) => r.path),
    ["/v1/logs"],
  );
  assert.ok(!existsSync(forged));

  // The default directory is under the shared temp directory: one another
  // user made (here, a link in its place) is not used.
  if (process.platform === "win32") return;
  const linked = { publicKey: "linked", baseUrl: `http://127.0.0.1:${process.pid}` };
  const hash = createHash("sha256").update(`linked@${linked.baseUrl}`).digest("hex").slice(0, 16);
  const shared = join(tmpdir(), "fixwire", hash);
  mkdirSync(join(tmpdir(), "fixwire"), { recursive: true });
  rmSync(shared, { recursive: true, force: true });
  symlinkSync(dir, shared);
  try {
    assert.ok(lstatSync(shared).isSymbolicLink());
    assert.equal(Fixwire.makeFileSpool({ offline: true }, linked), undefined);
  } finally {
    rmSync(shared, { force: true });
  }
});

test("a delivery whose answer trickles in is cut off at the timeout", async () => {
  const { makeNodeTransport } = await import("../src/transport.ts");
  // The socket timeout only notices silence: a byte every 50 ms kept it waiting forever.
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    const drip = setInterval(() => res.write("."), 50);
    res.on("close", () => clearInterval(drip));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const started = Date.now();
  await assert.rejects(
    makeNodeTransport(300).send({
      url: `http://127.0.0.1:${port}/v1/logs`,
      body: "{}",
      headers: {},
    }),
    /timeout/,
  );
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  server.closeAllConnections();
  server.close();
});

test("an integration that fails never fails the app's requests", async () => {
  const { server: ingestServer, dsn } = await ingest();
  const svc = await downstream();
  const client = Fixwire.init({
    dsn,
    tracesSampleRate: 1,
    // Throwing in a diagnostics_channel subscriber was an uncaught exception: the app ended.
    tracePropagationTargets: [
      {
        test: () => {
          throw new Error("bad target");
        },
      } as unknown as RegExp,
    ],
  });
  await Fixwire.startSpan({ name: "job" }, async () => {
    await new Promise<void>((resolve) =>
      request(`${svc.base}/stock`, (r) => r.resume().on("end", resolve)).end(),
    );
    assert.equal((await fetch(`${svc.base}/stock`)).status, 200);
  });
  assert.ok(await client.flush(5000));
  await Fixwire.close();
  svc.server.close();
  ingestServer.close();
  assert.equal(svc.seen.length, 2);
});
