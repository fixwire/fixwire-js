// The examples are real apps: run each against a fake ingest and check what
// Fixwire receives, so they keep working.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Json, thrown } from "../../packages/core/test/helpers.ts";
import { ingest } from "./ingest.ts";

const here = fileURLToPath(new URL("..", import.meta.url));

const op = (s: Json): string => s.attributes["fixwire.op"];
/** No parent here: the span starts this process's part of its trace. */
const isSegment = (s: Json): boolean => !s.parentSpanId || (s.flags & 0x200) !== 0;
const failed = (s: Json): boolean => s.status.code === 2;

const summary = (e: Json): string =>
  e.eventName === "exception" ? `${thrown(e).type}: ${thrown(e).message}` : e.body;

function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers },
      },
      (res) => res.resume().on("end", () => resolve(res.statusCode ?? 0)),
    );
    r.on("error", reject);
    r.end(data);
  });
}

test("express-api", async () => {
  const { server, dsn, events, spans } = await ingest();
  const app = spawn(process.execPath, ["--conditions=fixwire-source", "server.mjs"], {
    cwd: join(here, "express-api"),
    env: { ...process.env, FIXWIRE_DSN: dsn, PORT: "0" },
    // A channel for the "shutdown" message Windows process managers send.
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  const port = await new Promise<number>((resolve) => {
    app.stdout.on("data", (d: Buffer) => {
      const m = /listening on (\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    });
  });
  assert.equal(
    await call(port, "GET", "/orders/ord_1", undefined, { "x-user-id": "u-42", "x-plan": "pro" }),
    500,
  );
  assert.equal(await call(port, "GET", "/orders/nope"), 404);
  assert.equal(await call(port, "POST", "/orders", { items: [] }), 400);
  assert.equal(
    await call(port, "POST", "/orders", { items: [{ sku: "sku-404" }] }, { "x-user-id": "u-7" }),
    500,
  );
  assert.equal(await call(port, "POST", "/orders/ord_1/refund"), 502);
  // Stopped as the system stops it: SIGTERM, or on Windows (no signals between programs) the
  // process manager's message.
  const exited = new Promise((r) => app.on("exit", r));
  if (process.platform === "win32") app.send("shutdown");
  else app.kill("SIGTERM");
  assert.equal(await exited, 0);
  server.close();

  const all = events().map(summary).sort();
  assert.deepEqual(all, [
    "Error: acme-pay refused the refund of ord_1: card [REDACTED:credit_card] expired",
    "Error: stock service has no record of sku-404 for 1 items",
    "TypeError: Cannot read properties of undefined (reading 'city')",
  ]);
  const bug = events().find((e) => thrown(e)?.type === "TypeError") as Json;
  const users = (e: Json) =>
    Object.fromEntries(Object.entries(e.attributes).filter(([k]) => k.startsWith("user.")));
  assert.equal(bug.attributes["fixwire.transaction"], "/orders/:id");
  assert.deepEqual(users(bug), { "user.id": "u-42" });
  assert.equal(bug.attributes["fixwire.tags"].plan, "pro");
  assert.equal(bug.attributes["fixwire.breadcrumbs"].at(-1).message, "order loaded");
  assert.equal(bug.resource["telemetry.sdk.name"], "fixwire.javascript.node");
  const stock = events().find((e) => summary(e).includes("sku-404")) as Json;
  assert.deepEqual(users(stock), { "user.id": "u-7" });
  assert.equal(stock.attributes["fixwire.tags"].plan, "free"); // u-42's tags stayed with u-42's request
  const refund = events().find((e) => summary(e).includes("refund")) as Json;
  assert.equal(refund.severityNumber, 13, "warning");
  assert.equal(refund.attributes["fixwire.contexts"].refund.provider, "acme-pay");

  // Traces: each request is a segment named after its route.
  const segments = spans().filter(isSegment);
  const named = (name: string) => segments.filter((s) => s.name === name);
  assert.equal(named("GET /orders/:id").length, 2);
  const lookup = named("GET /orders/:id").find(failed) as Json;
  assert.equal(lookup.attributes["http.response.status_code"], 500);
  const query = spans().find((s) => op(s) === "db.query" && s.parentSpanId === lookup.spanId);
  assert.equal(query?.name, "SELECT order");
  assert.equal(bug.traceId, lookup.traceId); // the error is in that trace
  // The order's call to the inventory service: a child span, and the
  // inventory request continues the same trace from it.
  const create = named("POST /orders").find(failed) as Json;
  const reserve = spans().find((s) => op(s) === "http.client" && s.parentSpanId === create.spanId);
  assert.match(reserve?.name, /^POST http:\/\/127\.0\.0\.1:\d+\/inventory\/reserve$/);
  assert.equal(reserve?.attributes["http.response.status_code"], 409);
  const inventory = named("POST /inventory/reserve").find(
    (s) => s.parentSpanId === reserve?.spanId,
  );
  assert.equal(inventory?.traceId, create.traceId);
  assert.equal(inventory?.flags & 0x200, 0x200, "its parent is in another service");
});

test("node-worker", async () => {
  const { server, dsn, events, spans } = await ingest();
  const worker = spawn(process.execPath, ["--conditions=fixwire-source", "worker.mjs"], {
    cwd: join(here, "node-worker"),
    env: { ...process.env, FIXWIRE_DSN: dsn, FIXWIRE_OFFLINE: "" },
    stdio: "ignore",
  });
  assert.equal(await new Promise((r) => worker.on("exit", r)), 1); // two jobs failed
  server.close();
  assert.deepEqual(events().map(summary).sort(), [
    "Error: no decoder for dog.heic",
    "RangeError: width must be positive, got 0",
    "batch finished with 2 failed jobs",
  ]);
  const errors = events().filter((x) => x.eventName === "exception");
  const tag = (e: Json) => e.attributes["fixwire.tags"].job;
  for (const e of errors) assert.equal(e.attributes["fixwire.contexts"].job.id, tag(e));
  // A trace per job, failed ones marked; each error belongs to its job's trace.
  const jobs = spans().filter((s) => isSegment(s) && op(s) === "queue.process");
  assert.equal(jobs.length, 4);
  assert.equal(new Set(jobs.map((s) => s.traceId)).size, 4);
  assert.ok(
    jobs.every((s) => s.kind === 5),
    "a queue consumer's span",
  );
  const failedJobs = jobs.filter(failed).map((s) => s.attributes["job.id"]);
  assert.deepEqual(failedJobs.sort(), ["job-2", "job-3"]);
  const ok = jobs.find((s) => s.attributes["job.id"] === "job-1") as Json;
  assert.deepEqual(
    spans()
      .filter((s) => s.parentSpanId === ok.spanId)
      .map((s) => s.name)
      .sort(),
    ["decode", "resize"],
  );
  for (const e of errors) {
    const job = jobs.find((s) => s.attributes["job.id"] === tag(e)) as Json;
    assert.equal(e.traceId, job.traceId);
  }
});

test("browser-vite: the built page, clicked", async () => {
  const { server, dsn, events, spans } = await ingest();
  const dir = join(here, "browser-vite");
  // Build the page as a user would, with the DSN baked in.
  process.env.FIXWIRE_DSN = dsn;
  const require = createRequire(join(dir, "package.json"));
  const { build } = (await import(
    pathToFileURL(require.resolve("vite")).href
  )) as typeof import("vite");
  await build({
    root: dir,
    logLevel: "silent",
    build: { outDir: join(dir, "dist"), emptyOutDir: true },
  });
  const assets = readdirSync(join(dir, "dist", "assets"));
  const bundle = assets.find((f) => f.endsWith(".js")) as string;
  assert.ok(assets.includes(`${bundle}.map`), "hidden source maps are written for upload");

  // The page runs in its own process, which treats exceptions and
  // unhandled rejections the way a browser does (see page.mjs).
  const page = spawn(
    process.execPath,
    [
      join(here, "test", "page.mjs"),
      join(dir, "dist", "assets", bundle),
      "#add",
      "#checkout",
      "#handled",
      "#api",
    ],
    {
      stdio: "inherit",
    },
  );
  assert.equal(await new Promise((r) => page.on("exit", r)), 0);
  server.close();
  const got = events();
  assert.deepEqual(got.map(summary).sort(), [
    "Error: coupon WELCOME10 expired",
    "Error: order service rejected the cart of [REDACTED:email]",
    "TypeError: Cannot read properties of undefined (reading 'amount')",
    "recommendations unavailable",
  ]);
  for (const e of got) {
    assert.equal(e.resource["telemetry.sdk.name"], "fixwire.javascript.browser");
    assert.equal(e.resource["telemetry.sdk.language"], "webjs");
    assert.equal(e.attributes["user.id"], "u-42");
    assert.equal(e.attributes["url.full"], "https://shop.example.com/");
  }
  const rejection = got.find((e) => summary(e).includes("order service")) as Json;
  assert.equal(thrown(rejection).mechanism.type, "onunhandledrejection");
  const coupon = got.find((e) => summary(e).includes("coupon")) as Json;
  assert.equal(coupon.severityNumber, 13, "warning");
  const recs = got.find((e) => e.body === "recommendations unavailable") as Json;
  const crumb = recs.attributes["fixwire.breadcrumbs"].at(-1);
  assert.equal(crumb.category, "fetch");
  assert.equal(crumb.data.status_code, 0);

  // The page load is a trace (sent when the page is left), its fetch a
  // failed child, and the errors on the page belong to it.
  const pageload = spans().find((s) => isSegment(s) && op(s) === "pageload") as Json;
  assert.equal(pageload.name, "/");
  const call = spans().find((s) => s.parentSpanId === pageload.spanId && op(s) === "http.client");
  assert.equal(call?.name, "GET https://shop.example.com/api/recommendations");
  assert.ok(call && failed(call));
  for (const e of got) assert.equal(e.traceId, pageload.traceId);
});

test("support-agent", async () => {
  const { server, dsn, spans } = await ingest();
  const runner = spawn(process.execPath, ["--conditions=fixwire-source", "agent-runner.mjs"], {
    cwd: join(here, "test"),
    env: { ...process.env, FIXWIRE_DSN: dsn },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  runner.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  const code = await new Promise((r) => runner.on("exit", r));
  server.close();
  assert.equal(code, 0);
  const result = JSON.parse(out) as Json;
  assert.equal(result.text, "Your order has shipped, so I can't refund it.");
  assert.deepEqual(result.models, ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
  assert.equal(result.tools, 2);

  const value = (s: Json, k: string) => s.attributes[k];
  const [run] = spans().filter((s) => op(s) === "gen_ai.invoke_agent") as Json[];
  assert.ok(run && isSegment(run));
  assert.equal(value(run as Json, "gen_ai.agent.name"), "support-agent");
  assert.equal(value(run as Json, "gen_ai.input.messages"), undefined); // content stays out by default
  const chats = spans().filter((s) => op(s) === "gen_ai.chat");
  assert.equal(chats.length, 3);
  for (const c of chats) assert.equal(c.parentSpanId, run?.spanId);
  // Input tokens include cache reads: (900 + 800) × 2 + (1400 + 800).
  assert.equal(
    chats.reduce((n, c) => n + value(c, "gen_ai.usage.input_tokens"), 0),
    5600,
  );
  const tools = Object.fromEntries(
    spans()
      .filter((s) => op(s) === "gen_ai.execute_tool")
      .map((s) => [value(s, "gen_ai.tool.name"), s]),
  );
  assert.deepEqual(tools.lookup_order?.status, { code: 1 });
  assert.deepEqual(tools.refund_order?.status, { code: 2 });
  assert.equal(value(tools.refund_order as Json, "error.type"), "AlreadyShipped");
  assert.equal(value(tools.refund_order as Json, "gen_ai.tool.call.id"), "toolu_2");
});
