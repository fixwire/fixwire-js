import assert from "node:assert/strict";
import { test } from "node:test";

import { type Json, recordsOf, spansOf, thrown } from "../../core/test/helpers.ts";
import * as Fixwire from "../src/index.ts";
import {
  defaultStackParser,
  globalHandlersIntegration,
  noiseFilter,
  type StackFrame,
  type TransportRequest,
} from "../src/index.ts";
import { makeIndexedDbSpool } from "../src/offline.ts";
import { geckoStackLineParser } from "../src/stack-parsers.ts";

/** What a fetch was given, as the decoding helpers read requests. */
const asRequest = (url: string, init: RequestInit | undefined): TransportRequest => ({
  url,
  body: init?.body as string,
  headers: init?.headers as Record<string, string>,
});

test("Chrome, Firefox and Safari stacks", () => {
  const chrome = defaultStackParser(`TypeError: Cannot read properties of undefined (reading 'id')
    at addToCart (https://shop.example.com/assets/app-3f9a2c.js:1:2345)
    at HTMLButtonElement.<anonymous> (https://shop.example.com/assets/app-3f9a2c.js:1:9876)
    at async checkout (https://shop.example.com/assets/app-3f9a2c.js:2:10)`);
  assert.deepEqual(
    chrome.map((f) => [f.function, f.lineno, f.colno]),
    [
      ["async checkout", 2, 10],
      ["HTMLButtonElement.<anonymous>", 1, 9876],
      ["addToCart", 1, 2345],
    ],
  );
  const firefox = defaultStackParser(`addToCart@https://shop.example.com/assets/app.js:1:2345
checkout@https://shop.example.com/assets/app.js:2:10
@https://shop.example.com/assets/app.js:3:1`);
  assert.deepEqual(
    firefox.map((f) => f.function),
    ["?", "checkout", "addToCart"],
  );
  const safari = defaultStackParser(`addToCart@https://shop.example.com/app.js:1:2345
global code@https://shop.example.com/app.js:9:1`);
  assert.equal(safari.at(-1)?.filename, "https://shop.example.com/app.js");
});

test("the client sends OTLP through fetch with a bearer key; a hidden page, keepalive with the key in the query", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const target = new EventTarget();
  const g = globalThis as Record<string, unknown>;
  const saved = { location: g.location, document: g.document };
  // The query and fragment may hold tokens (an OAuth callback): not sent.
  g.location = { href: "https://shop.example/cart?coupon=x#access_token=ya29.secret" };
  try {
    const client = Fixwire.init({
      dsn: "https://publickey@ingest.fixwire.example",
      release: "web@1.4.0",
      autoSessionTracking: false, // this test is about the transport
      defaultIntegrations: false,
      integrations: [globalHandlersIntegration(target)],
      transport: Fixwire.makeFetchTransport(async (url, init) => {
        sent.push({ url: String(url), init: init as RequestInit });
        return new Response("{}", { status: 200 });
      }),
    });
    const error = new Error("payment failed for ada@example.com");
    target.dispatchEvent(Object.assign(new Event("error"), { error, message: error.message }));
    target.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: "not an error" }),
    );
    assert.ok(await client.flush(2000));
    // The page is hidden, perhaps closing: no preflight, so the key goes in the query.
    g.document = { visibilityState: "hidden" };
    client.captureMessage("leaving");
    assert.ok(await client.flush(2000));
    await Fixwire.close();
  } finally {
    Object.assign(g, saved);
  }

  assert.equal(sent.length, 3);
  const { url, init } = sent[0] as { url: string; init: RequestInit };
  assert.equal(url, "https://ingest.fixwire.example/v1/logs");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer publickey");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(init.keepalive, false);
  // A redirect is not followed: the key goes to the DSN's host only.
  assert.equal(init.redirect, "manual");
  const [event, rejection, leaving] = recordsOf(
    sent.map((s) => asRequest(s.url, s.init)),
  ) as Json[];
  assert.equal(event?.resource["telemetry.sdk.name"], "fixwire.javascript.browser");
  assert.equal(event?.resource["telemetry.sdk.language"], "webjs");
  assert.equal(event?.resource["service.version"], "web@1.4.0");
  assert.equal(event?.severityNumber, 21);
  assert.equal(thrown(event as Json).message, "payment failed for [REDACTED:email]");
  assert.equal(thrown(event as Json).mechanism.type, "onerror");
  assert.equal(event?.attributes["fixwire.handled"], false);
  assert.equal(event?.attributes["url.full"], "https://shop.example/cart");
  assert.equal(event?.attributes["user_agent.original"], navigator.userAgent);
  assert.equal(thrown(rejection as Json).message, "not an error");
  assert.equal(thrown(rejection as Json).mechanism.synthetic, true);
  assert.equal(leaving?.body, "leaving");
  const hidden = sent[2] as { url: string; init: RequestInit };
  assert.equal(hidden.url, "https://ingest.fixwire.example/v1/logs?key=publickey");
  assert.equal(hidden.init.keepalive, true);
  assert.deepEqual(hidden.init.headers, { "Content-Type": "text/plain;charset=UTF-8" });
});

test("noise nobody can act on is dropped", () => {
  const ext = {
    exception: {
      values: [
        { value: "x", stacktrace: { frames: [{ filename: "chrome-extension://abc/content.js" }] } },
      ],
    },
  };
  assert.equal(noiseFilter(ext), null);
  assert.equal(noiseFilter({ exception: { values: [{ value: "Script error." }] } }), null);
  assert.equal(
    noiseFilter({ exception: { values: [{ value: "ResizeObserver loop limit exceeded" }] } }),
    null,
  );
  const real = {
    exception: {
      values: [{ value: "x", stacktrace: { frames: [{ filename: "https://shop/app.js" }] } }],
    },
  };
  assert.equal(noiseFilter(real), real);
});

test("the IndexedDB store keeps requests across a page reload", async () => {
  await import("fake-indexeddb/auto");
  const dsn = { publicKey: "publickey" };
  const request = (body: string) => ({
    path: "/v1/logs",
    contentType: "application/json",
    body,
    headers: {},
    category: "error",
  });
  const first = makeIndexedDbSpool({}, dsn);
  assert.ok(first);
  const id = await first.put(request("request-1"));
  await first.put(request("request-2"));
  await first.delete(id);
  const second = makeIndexedDbSpool({}, dsn);
  const rows = await second?.load();
  assert.deepEqual(
    rows?.map(({ id: _, ...r }) => r),
    [request("request-2")],
  );
});

test("an offline browser client delivers once the server answers", async () => {
  await import("fake-indexeddb/auto");
  let up = false;
  const bodies: string[] = [];
  const transport = Fixwire.makeFetchTransport(async (_url, init) => {
    if (!up) throw new TypeError("Failed to fetch");
    bodies.push(String((init as RequestInit).body));
    return new Response("{}", { status: 200 });
  });
  const opts = {
    dsn: "https://k@ingest.fixwire.example",
    defaultIntegrations: false,
    offline: makeIndexedDbSpool,
    transport,
  };
  const first = Fixwire.init(opts);
  first.captureMessage("sent while offline");
  await first.flush(300);
  // The page goes away; the next load finds the request and sends it.
  up = true;
  const second = Fixwire.init(opts);
  assert.ok(await second.flush(3000));
  assert.ok(bodies.some((b) => b.includes("sent while offline")));
  await Fixwire.close();
});

test("page loads, route changes and fetch calls are traced; the server page's trace continues", async () => {
  const TRACE = "0af7651916cd43dd8448eb211c80319c";
  const PARENT = "b7ad6b7169203331";
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, location: g.location, document: g.document, history: g.history };
  const location = {
    href: "https://shop.example/products",
    pathname: "/products",
    origin: "https://shop.example",
  };
  const calls: { url: string; headers: Headers }[] = [];
  g.location = location;
  g.history = { pushState() {} };
  g.document = {
    readyState: "complete",
    querySelector: (sel: string) =>
      sel.includes("traceparent")
        ? { getAttribute: () => `00-${TRACE}-${PARENT}-01` }
        : sel.includes("tracestate")
          ? { getAttribute: () => "vendor=x" }
          : null,
  };
  g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    return new Response("ok", { status: url.includes("missing") ? 404 : 200 });
  };
  const requests: TransportRequest[] = [];
  try {
    const client = Fixwire.init({
      dsn: "https://publickey@ingest.fixwire.example",
      tracesSampleRate: 1,
      defaultIntegrations: false,
      integrations: [Fixwire.browserTracingIntegration({ idleTimeout: 30 })],
      transport: Fixwire.makeFetchTransport(async (url, init) => {
        requests.push(asRequest(String(url), init));
        return new Response("{}");
      }),
    });
    await fetch("/api/cart", { headers: { baggage: "vendor=1" } });
    await fetch("https://cdn.other.example/app.js");
    await fetch("/missing");
    await new Promise((r) => setTimeout(r, 80)); // idle: the page-load segment ends
    location.pathname = "/checkout";
    location.href = "https://shop.example/checkout";
    (g.history as { pushState(...a: unknown[]): void }).pushState({}, "", "/checkout");
    await fetch("/api/pay");
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(await client.flush(2000));
    await Fixwire.close();

    const spans = spansOf(requests);
    const pageload = spans.find((s) => s.attributes["fixwire.op"] === "pageload");
    const navigation = spans.find((s) => s.attributes["fixwire.op"] === "navigation");
    assert.ok(pageload && navigation, JSON.stringify(spans.map((s) => s.name)));
    assert.equal(pageload.name, "/products");
    assert.equal(pageload.traceId, TRACE);
    assert.equal(pageload.parentSpanId, PARENT);
    assert.equal(pageload.flags, 0x301, "continued from the server's page: a remote parent");
    const children = spans.filter((s) => s.parentSpanId === pageload.spanId);
    assert.deepEqual(children.map((s) => s.name).sort(), [
      "GET https://cdn.other.example/app.js",
      "GET https://shop.example/api/cart",
      "GET https://shop.example/missing",
    ]);
    assert.deepEqual(children.find((s) => s.name.endsWith("/missing"))?.status, { code: 2 });
    assert.equal(children.find((s) => s.name.endsWith("/api/cart"))?.kind, 3);

    // Same origin: headers continue from the fetch span, with the page's
    // tracestate, and the request's own baggage kept; elsewhere: none.
    const cart = children.find((s) => s.name.endsWith("/api/cart"));
    assert.equal(calls[0]?.headers.get("traceparent"), `00-${TRACE}-${cart?.spanId}-01`);
    assert.equal(calls[0]?.headers.get("tracestate"), "vendor=x");
    assert.equal(calls[0]?.headers.get("baggage"), "vendor=1");
    assert.equal(calls[1]?.headers.get("traceparent"), null);

    // A route change is a new trace.
    assert.equal(navigation.name, "/checkout");
    assert.notEqual(navigation.traceId, TRACE);
    assert.equal(spans.filter((s) => s.parentSpanId === navigation.spanId).length, 1);
  } finally {
    Object.assign(g, saved);
  }
});

test("hostile stack lines parse quickly, and a message's lines are not frames", () => {
  // Each took the gecko expression most of a second (cubic backtracking).
  const hostile = [`${" ".repeat(1023)}@`, `${"1".repeat(1023)}@`, `${"a:/".repeat(340)}@`];
  let started = performance.now();
  defaultStackParser(Array.from({ length: 30 }, (_, i) => hostile[i % 3]).join("\n"));
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
  // A message is text from anywhere: in a V8 stack its lines come first.
  const parens = `${"(".repeat(512)}${")".repeat(511)}@/a`;
  const err = new TypeError(
    `bad input\n${Array(20).fill(parens).join("\n")}\n    at fake (https://evil.example/x.js:1:1)`,
  );
  started = performance.now();
  const [ex] = Fixwire.exceptionsFromError(defaultStackParser, err, { type: "generic" });
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
  const files = (ex?.stacktrace?.frames ?? []).map((f) => f.filename);
  assert.ok(files.length > 0 && !files.some((f) => f?.includes("evil")), String(files));
});

/** The gecko parser as it was, an expression that backtracked polynomially: the oracle. */
const geckoBefore = (line: string): StackFrame | undefined => {
  const parts =
    /^(.*?)(?:\((.*?)\))?(?:^|@)?((?:[-a-z]+)?:\/.*?|\[native code\]|[^@]*(?:bundle|\d\.js)|\/[\w\-. /=]+)(?::(\d+))?(?::(\d+))?$/i.exec(
      line.trim(),
    );
  if (!parts) return undefined;
  let [, func, , filename = "", lineno, colno] = parts;
  const sub =
    filename.includes(" > eval") && /(\S+) line (\d+)(?: > eval line \d+)* > eval/i.exec(filename);
  if (sub) [func, filename, lineno, colno] = [func || "eval", sub[1] as string, sub[2], ""];
  func ||= "?";
  const safari = func.includes("safari-extension")
    ? "safari-extension"
    : func.includes("safari-web-extension") && "safari-web-extension";
  if (safari)
    [func, filename] = [
      func.includes("@") ? (func.split("@")[0] as string) : "?",
      `${safari}:${filename}`,
    ];
  const frame: StackFrame = {
    filename,
    function: func === "<anonymous>" ? "?" : func,
    in_app: true,
  };
  if (lineno) frame.lineno = +lineno;
  if (colno) frame.colno = +colno;
  return frame;
};

test("the gecko parser gives the frames the expression gave, on realistic and hostile lines", () => {
  const realistic = [
    "addToCart@https://shop.example.com/assets/app.js:1:2345",
    "@https://shop.example.com/assets/app.js:3:1",
    "global code@https://shop.example.com/app.js:9:1",
    "http://path/to/file.js:2:3",
    "dumpException3@http://localhost:8080/file.js:41",
    "[native code]",
    "forEach@[native code]",
    "foo@http://localhost:8080/file.js line 26 > eval:2:96",
    "@http://localhost:8080/file.js line 26 > eval line 1 > eval:1:1",
    "trace@file:///C:/example.html:9:17",
    'obj["@fn"]@file:///C:/example.html:7:17',
    "ClipperError@safari-extension:(//3284871F-A480-4FFC-8BC4-3F362C752446/2665fee0/commons.js:223036:10)",
    "p_@safari-web-extension://46434E60-F5BD-48A4-80C8-A422C5D16897/scripts/contentScript.js:29:33314",
    "value@index.android.bundle:12:1917",
    "value@1.js:1:1",
    "foo/<@http://path/to/file.js:41:13",
    "[2]</Bar.prototype._baz/</<@http://path/to/file.js:703:28",
    'foo("arg")@http://path/to/file.js:2:3',
    "foo@/static/js/main.js:10:20",
    "<anonymous>@http://example.com/a.js:1:1",
    "async*foo@moz-extension://abc-def/content.js:5:7",
    "foo@http://x/a.js LINE 2 > EVAL line 3 > eval:1:1",
    `foo@http://x/a${String.fromCharCode(0x2028)}b.js:1:2`, // `.` takes no line terminator
  ];
  // What the lines are made of; hostile lines repeat the first 17.
  const pieces = "( ) @ : / :/ a Z 1 . - _ =".split(" ");
  pieces.push(" ", "\t", "\r", String.fromCharCode(0x2028), "js", "1.js", "bundle", "BUNDLE");
  pieces.push("[native code]", "[Native Code]", "http://x.js", " line 2", " > eval", " > EVAL");
  pieces.push("safari-extension", "safari-web-extension", "<anonymous>", ":12", ":3:4", "é", "ſ");
  let seed = 1;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = <T>(xs: T[]) => xs[rnd(xs.length)] as T;
  const random = () => Array.from({ length: rnd(20) }, () => pick(pieces)).join("");
  const mutated = (s = pick(realistic)) => {
    for (let k = 1 + rnd(4); k--; ) {
      const at = rnd(s.length + 1);
      s = s.slice(0, at) + (rnd(2) ? pick(pieces) : "") + s.slice(at + rnd(3));
    }
    return s;
  };
  const run = () => pick(pieces.slice(0, 17)).repeat(1 + rnd(16));
  const hostile = () => Array.from({ length: 1 + rnd(4) }, run).join("");
  const kinds = [random, mutated, hostile, () => hostile() + pick(realistic)];
  const gecko = geckoStackLineParser[1];
  let differences = 0;
  let first = "";
  for (let n = 0; n < 20_000; n++) {
    const line = n < realistic.length ? (realistic[n] as string) : pick(kinds)();
    if (JSON.stringify(gecko(line)) !== JSON.stringify(geckoBefore(line))) {
      differences++;
      first ||= `${JSON.stringify(line)}: ${JSON.stringify(gecko(line))}`;
    }
  }
  assert.equal(differences, 0, first);
});

test("the gecko parser takes time linear in the line", () => {
  // The expression took most of a second on 1 KB of parentheses, and four
  // times as long on twice as many: these lines would take it for ever.
  const gecko = geckoStackLineParser[1];
  // Milliseconds a parse takes, the best of a few rounds in which each line is
  // parsed three times. CPU time, as other tests run meanwhile; on Windows
  // the CPU clock ticks in 15.6 ms (every line read 0.00), so the wall clock
  // there, the best round being the one the other tests left alone.
  const clock =
    process.platform === "win32"
      ? () => performance.now()
      : () => {
          const { user, system } = process.cpuUsage();
          return (user + system) / 1000;
        };
  const time = (lines: string[]) => {
    const best = lines.map(() => Number.POSITIVE_INFINITY);
    for (let round = 0; round < 5; round++)
      lines.forEach((line, i) => {
        const started = clock();
        for (let k = 0; k < 3; k++) gecko(line);
        best[i] = Math.min(best[i] as number, (clock() - started) / 3);
      });
    return best;
  };
  const shapes = [
    (n: number) => "(".repeat(n / 2) + ")".repeat(n / 2),
    (n: number) => `${"(".repeat(n / 2)}${")".repeat(n / 2 - 3)}@/a`,
    (n: number) => "()@:".repeat(n / 4),
    (n: number) => "(@:/".repeat(n / 4),
    (n: number) => `@http://${"a".repeat(n)} > eval`,
  ];
  for (const shape of shapes) {
    const ms = time([10_000, 100_000].map(shape));
    const [ms10k = 0, ms100k = 0] = ms;
    const what = `${JSON.stringify(shape(8))}: ${ms.map((t) => t.toFixed(2)).join(", ")} ms`;
    assert.ok(ms10k < 50 && ms100k < 250, what);
    // Ten times the line, about ten times the time: a quadratic parse takes a
    // hundred times as long. The bound leaves room for a busy machine (CI ran
    // 10 KB in 0.72 ms and 100 KB in 11.88 ms with the other test files beside it).
    assert.ok(ms100k < 25 * ms10k + 2, what);
  }
});

test("breadcrumbs never break the app's fetch or console calls, and stay cheap", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, debug: console.debug };
  const urls: string[] = [];
  g.fetch = async (input: unknown) => {
    urls.push(String(input));
    return new Response("ok");
  };
  console.debug = () => {};
  const crumbs: Fixwire.Breadcrumb[] = [];
  try {
    Fixwire.init({
      dsn: "https://publickey@ingest.fixwire.example",
      defaultIntegrations: false,
      integrations: [Fixwire.breadcrumbsIntegration()],
      transport: Fixwire.makeFetchTransport(async () => new Response("{}")),
      beforeBreadcrumb: (c) => {
        crumbs.push(c);
        return c;
      },
    });
    // fetch takes anything with a string form; the breadcrumb read its `url` and threw.
    const target = { toString: () => "https://api.example/orders?token=x#frag" };
    assert.equal((await fetch(target as unknown as string)).status, 200);
    assert.deepEqual(urls, ["https://api.example/orders?token=x#frag"]);
    assert.equal(
      crumbs.find((c) => c.category === "fetch")?.data?.url,
      "https://api.example/orders",
    );
    // A large object logged: only what the message keeps is serialized (the
    // 1,024 bytes sent and the next 16 kB, which redaction reads).
    let reads = 0;
    const rows = Array.from({ length: 100_000 }, (_, i) => ({
      get i() {
        reads++;
        return i;
      },
    }));
    console.debug("rows", rows);
    assert.ok(reads < 2_000, `${reads} values read`);
    const logged = crumbs.find((c) => c.category === "console")?.message ?? "";
    assert.ok(logged.startsWith('rows [{"i":0},{"i":1},') && logged.length <= 1024 + (16 << 10));
  } finally {
    g.fetch = saved.fetch;
    console.debug = saved.debug;
    await Fixwire.close();
  }
});

test("init never throws: a broken DSN leaves the SDK off, a failing integration is skipped", async () => {
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => warned.push(args.join(" "));
  try {
    const off = Fixwire.init({ dsn: "https://no-key.example", defaultIntegrations: false });
    assert.equal(off.enabled, false);
    const on = Fixwire.init({
      dsn: "https://publickey@ingest.fixwire.example",
      defaultIntegrations: false,
      autoSessionTracking: false,
      transport: Fixwire.makeFetchTransport(async () => new Response("{}")),
      integrations: [
        {
          name: "Broken",
          setup() {
            throw new Error("no");
          },
        },
      ],
    });
    assert.equal(on.enabled, true);
  } finally {
    console.warn = warn;
    await Fixwire.close();
  }
  assert.match(warned[0] ?? "", /not started/);
  assert.match(warned[1] ?? "", /integration Broken failed/);
});
