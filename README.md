<div align="center">

_Bugs reach production. Fixwire finds them first: errors, traces, logs and
AI agent runs in one place, an AI debugger on every plan, and your data
kept in Europe._

[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?logo=discord&logoColor=white)](https://fixwire.io/discord)
[![Slack](https://img.shields.io/badge/Slack-community-4A154B?logo=slack&logoColor=white)](https://fixwire.io/slack)
[![X](https://img.shields.io/badge/X-follow%20us-000000?logo=x&logoColor=white)](https://fixwire.io/x)
[![Release](https://img.shields.io/github/v/release/fixwire/fixwire-js?label=release)](https://github.com/fixwire/fixwire-js/releases)
[![Node.js](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-blue?logo=node.js&logoColor=white)](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml)
[![CI](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml/badge.svg)](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/fixwire/fixwire-js/blob/main/LICENSE)

<br/>

</div>

# Fixwire SDK for JavaScript

Welcome to the official JavaScript SDK for **[Fixwire](https://fixwire.io)**.
It captures errors and crashes, traces, release health, cron monitor
check-ins, user feedback and AI agent runs from Node.js, browsers, edge
runtimes and React apps, written in JavaScript or TypeScript.

| Package | For |
|---|---|
| [`@fixwire/node`](https://github.com/fixwire/fixwire-js/tree/main/packages/node) | Node.js 20+: servers, workers, CLIs and serverless functions; Express and Next.js |
| [`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser) | Web apps, within a size budget |
| [`@fixwire/edge`](https://github.com/fixwire/fixwire-js/tree/main/packages/edge) | Cloudflare Workers, Vercel Edge Functions and Next.js middleware, Deno Deploy, Netlify Edge Functions |
| [`@fixwire/react`](https://github.com/fixwire/fixwire-js/tree/main/packages/react) | React 18+: error boundaries, and React 19's root error handlers |
| [`@fixwire/core`](https://github.com/fixwire/fixwire-js/tree/main/packages/core) | What they share: the client, scopes, redaction, budgets and delivery (installed with them) |

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Node.js 20 or newer. CI tests Node.js 22 and 24 on Linux and 24 on macOS
  and Windows, and runs the built package on Node.js 20.
- Or a modern browser, an edge runtime (Cloudflare Workers, Vercel Edge,
  Deno Deploy, Netlify Edge Functions), and React 18 or 19 for
  `@fixwire/react`.

### Installation

Install the package for your runtime:

```sh
npm install @fixwire/node      # or @fixwire/browser, @fixwire/edge
pnpm add @fixwire/node
yarn add @fixwire/node
```

For React, add `@fixwire/react` next to `@fixwire/browser`. Every package is
fully typed, and each depends only on `@fixwire/core`.

### Basic configuration

Call `init()` once, as early as you can in your app's startup:

```js
import * as Fixwire from "@fixwire/node";

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "api@1.4.0",
  environment: "production",
  tracesSampleRate: 0.2, // record 20% of traces
  // sendDefaultPii: true, // also send users' IP addresses from proxy headers
  // redact: false,        // turn off masking of secrets and personal data
});
```

The DSN is your project's publishable key and the ingest host,
`https://<publishable key>@<host>`; the key is safe in a browser bundle.
Without the `dsn` option, Node.js and edge runtimes read `FIXWIRE_DSN` (and
`FIXWIRE_RELEASE` and `FIXWIRE_ENVIRONMENT`); without either, the SDK does
nothing. `init()` never throws: a broken DSN or option is said in a warning
on the console and the SDK stays off, so a typo in configuration can't stop
your app from starting.

`@fixwire/browser` and `@fixwire/edge` take the same options. In Node.js,
`init()` can sit anywhere: requests are followed through Node's
diagnostics channels, with no `--import` flag and no load order.

### Quick usage example

```js
Fixwire.captureMessage("Hello Fixwire!"); // an info-level message in your project

try {
  JSON.parse("{ not json");
} catch (err) {
  Fixwire.captureException(err); // the error, with its stack, causes and breadcrumbs
}
```

Uncaught exceptions and unhandled rejections are reported by themselves, in
Node.js and in browsers. The SDK never keeps a process alive: at the end of
a short script, `await Fixwire.close()` sends what is queued (it waits 2
seconds at most).

## ✨ Why Fixwire

- **Secrets stay on your machine.** Secrets and personal data are masked on
  the device, with the same rules as the Fixwire server, before anything is
  sent. Your app's own configuration (release, environment, service name)
  is sent as given.
- **A crash loop costs a few events, not your quota.** Each issue sends a
  burst of 10 events, then 1 a minute, and a count of the rest.
- **It never gets in your app's way.** `init()` and captures never throw
  into your code; capturing is cheap and synchronous, and encoding and
  sending happen later. Queues, strings, stacks and retries all have fixed
  limits, and the SDK's timers never keep your process alive.
- **OpenTelemetry inside.** It speaks the Fixwire protocol (OpenTelemetry's
  OTLP/HTTP plus a few small JSON endpoints), so its traces join the ones
  your OpenTelemetry services send.
- **Trace headers only where you allow.** Outgoing requests carry trace
  headers only to the hosts and URLs you list (in browsers, by default, to
  the page's own origin).
- **Small and self-contained.** No third-party dependencies, nothing
  patched in Node.js, and about 16 KB gzipped in the browser for errors,
  with tracing opt-in.
- **Your data stays in Europe.** Fixwire runs in Europe.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| Uncaught errors (Node.js) | Uncaught exceptions (reported as fatal, flushed, then the process exits as Node.js would) and unhandled rejections | On by default in `@fixwire/node` |
| HTTP servers (Node.js) | A scope per request, the caller's trace continued, a segment per request named after its route, request sessions; Express and any server on `node:http` | On by default in `@fixwire/node` |
| Express | 5xx errors (sync and async) with the request and the route; 4xx are not reported | `Fixwire.setupExpressErrorHandler(app)` after your routes |
| Outgoing HTTP (Node.js) | `http`, `https` and `fetch` calls become child spans with an `http` breadcrumb, and carry trace headers to your targets | On by default in `@fixwire/node` |
| Next.js | Server errors with the route pattern and the request | `export const onRequestError = Fixwire.captureRequestError` ([details](https://github.com/fixwire/fixwire-js#nextjs)) |
| Serverless functions | AWS Lambda, Google Cloud Functions, Azure Functions, Netlify and Vercel functions: a scope and a segment per call, errors reported, flushed before it returns | `Fixwire.wrapHandler(handler)` |
| Browser global handlers | Uncaught errors and unhandled rejections, through listeners (never `window.onerror`) | On by default in `@fixwire/browser` |
| Browser breadcrumbs | Console calls and `fetch` requests as breadcrumbs | On by default in `@fixwire/browser` |
| Browser tracing | Page loads and route changes as traces with web vitals, `fetch` calls as child spans with trace headers, a server-rendered page's trace continued | `integrations: [Fixwire.browserTracingIntegration()]` |
| React | Error boundaries with the component stack, and React 19's root error handlers | `@fixwire/react` ([details](https://github.com/fixwire/fixwire-js#react)) |
| Cloudflare Workers | Fetch handlers, cron triggers and queue consumers: a scope, a segment and error reporting each, sent through `ctx.waitUntil` | `Fixwire.withFixwire(options, handlers)` from `@fixwire/edge` |
| Vercel Edge, Next.js middleware, Deno, Netlify Edge | A scope and a segment per request, errors reported, sent through `waitUntil` | `Fixwire.wrapRequestHandler(handler, { waitUntil })` from `@fixwire/edge` |
| Offline delivery | Requests kept until the server has them: on disk in Node.js, in IndexedDB in browsers | `offline: true` (Node.js); `offline: makeIndexedDbSpool` from `@fixwire/browser/offline` |
| OpenAI | Chat completions, responses and embeddings (streamed too) become spans with the model, tokens and finish reasons | `Fixwire.wrapOpenAI(new OpenAI())` |
| Anthropic | Messages (streamed too) become chat spans with the model, tokens (cache tokens too) and stop reason | `Fixwire.wrapAnthropic(new Anthropic())` |
| AI agents | Agent runs, model calls and tool calls with the OpenTelemetry GenAI conventions, for any model | `Fixwire.ai.agent()`, `ai.chat()`, `ai.tool()`, `ai.embeddings()` ([details](https://github.com/fixwire/fixwire-js#ai-agents)) |
| OpenTelemetry | Your OpenTelemetry spans' traces on Fixwire's errors; your OTLP exporters pointed at Fixwire | `Fixwire.openTelemetryIntegration(otel)`, `Fixwire.otlpExporterOptions(dsn)` |

### Node.js servers and Express

```js
import express from "express";
import * as Fixwire from "@fixwire/node";

Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "api@1.4.0", tracesSampleRate: 0.2 });

const app = express();
app.use((req, res, next) => {
  Fixwire.setUser({ id: req.get("x-user-id") ?? "anonymous" }); // stays with this request
  next();
});
app.get("/orders/:id", (req, res) => res.json(loadOrder(req.params.id)));
Fixwire.setupExpressErrorHandler(app); // after your routes
app.listen(3000);
```

Each incoming request gets its own scope: `setUser`, `setTag` and
breadcrumbs stay with the request that set them. Request headers come from
an allowlist: cookies and authorization never leave. With tracing on, each
request is a segment named after its route (`GET /orders/:id`); calls
through `http`, `https` and `fetch` inside it become child spans and carry
the trace (W3C `traceparent` and `tracestate`, and the incoming `baggage`)
to `tracePropagationTargets` only. Trace headers on `http` and `https`
calls need Node.js 22.14 or newer; on older versions they still get spans.
For a server-rendered page, put `Fixwire.getTraceMetaTags()` in its
`<head>`, and the browser SDK continues the request's trace.

### Next.js

```js
// instrumentation.ts
import * as Fixwire from "@fixwire/node";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") Fixwire.init({ dsn: process.env.FIXWIRE_DSN });
}

export const onRequestError = Fixwire.captureRequestError;
```

Server errors (Next.js 15 and newer) arrive with the route pattern
(`/blog/[slug]`) and the request. In the browser, use `@fixwire/browser`
(in `instrumentation-client.ts`) and `@fixwire/react`; for middleware and
edge routes, `@fixwire/edge`.

### Serverless functions

```js
import * as Fixwire from "@fixwire/node";

Fixwire.init({ dsn: process.env.FIXWIRE_DSN });

export const handler = Fixwire.wrapHandler(async (event, context) => {
  return { statusCode: 200, body: "ok" };
});
```

An error the handler throws is reported and thrown on. Before returning,
the wrapper waits at most `flushTimeoutMs` (default 2000) for queued
events, and on AWS Lambda stays half a second inside the time the
invocation has left.

### Browsers

```js
import * as Fixwire from "@fixwire/browser";

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "web@1.4.0",
  tracesSampleRate: 0.2,
  integrations: [Fixwire.browserTracingIntegration()], // optional: traces
});
```

Errors cost about 16 KB gzipped, tracing about 3 KB more. Extension
errors, cross-origin "Script error." and ResizeObserver noise are dropped
(`filterNoise: false` keeps them). The page URL is sent without its query
and fragment. With tracing, a page load is a trace ended when the page goes
idle or is left, with web vitals; each route change starts a new one;
`fetch` calls to the page's own origin carry trace headers, and a
server-rendered page's `<meta name="traceparent">` continues the server's
trace. Upload source maps with `fixwire-cli`: the debug IDs it injects
link each error to its bundle's maps.

### React

```jsx
import { createRoot } from "react-dom/client";
import * as Fixwire from "@fixwire/browser";
import { ErrorBoundary, reactErrorHandler } from "@fixwire/react";

Fixwire.init({ dsn: "https://<publishable key>@ingest.eu.fixwire.io" });

createRoot(document.getElementById("root"), {
  onUncaughtError: reactErrorHandler(),
  onCaughtError: reactErrorHandler({ handled: true }),
}).render(
  <ErrorBoundary fallback={({ resetError }) => <button onClick={resetError}>Try again</button>}>
    <App />
  </ErrorBoundary>,
);
```

`ErrorBoundary` reports what it catches with the component stack and
renders `fallback` (an element, or a function of the error);
`beforeCapture` adds tags or context to that event, and
`withErrorBoundary(Component, props)` wraps a component.
`reactErrorHandler()` reports the errors React passes to the root (React
19); errors a Fixwire boundary caught are left to it, and nothing is sent
twice.

### Edge runtimes

Cloudflare Workers (enable `nodejs_compat` for `node:async_hooks`):

```js
import { AsyncLocalStorage } from "node:async_hooks";
import * as Fixwire from "@fixwire/edge";

export default Fixwire.withFixwire(
  (env) => ({ dsn: env.FIXWIRE_DSN, tracesSampleRate: 0.2, asyncLocalStorage: AsyncLocalStorage }),
  {
    async fetch(request, env, ctx) {
      return new Response("ok");
    },
  },
);
```

Vercel Edge Functions and Next.js middleware, Deno and Netlify Edge
Functions:

```js
import { waitUntil } from "@vercel/functions";
import * as Fixwire from "@fixwire/edge";

Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "web@1.4.0" });

export const GET = Fixwire.wrapRequestHandler(async (request) => Response.json(await load()), {
  waitUntil,
});
```

In Next.js middleware, pass `event.waitUntil`; on Netlify,
`context.waitUntil`; without `waitUntil`, the handler waits for delivery
before returning. Each request continues the caller's trace, is a segment,
and has its errors reported, then thrown on. Scopes stay per request
through the runtime's `AsyncLocalStorage`: it is found on its own on Vercel
Edge; pass it as `asyncLocalStorage` elsewhere. `fetch` calls become child
spans.

### AI agents

```js
import Anthropic from "@anthropic-ai/sdk";
import * as Fixwire from "@fixwire/node";

const anthropic = Fixwire.wrapAnthropic(new Anthropic()); // or Fixwire.wrapOpenAI(new OpenAI())

const reply = await Fixwire.ai.agent(
  { name: "support-bot", provider: "anthropic", model: "claude-opus-5-5", input: question },
  async (run) => {
    const msg = await anthropic.messages.create({ // a chat span: model, tokens, stop reason
      model: "claude-opus-5-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: question }],
    });
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      await Fixwire.ai.tool({ name: block.name, callId: block.id, arguments: block.input }, (call) =>
        call.setResult(runTool(block.name, block.input)), // a tool span, failures included
      );
    }
    run.setOutput(msg.content);
    return msg;
  },
);
```

Prompts, outputs and tool arguments and results are recorded only with
`recordAiContent: true` (or `recordContent: true` per call), redacted and
kept to 16 kB each. Without it, tool arguments still get a hash, so an
agent calling the same tool with the same arguments in a loop shows up.
For a model without a wrapper, `Fixwire.ai.chat({ provider, model }, …)`
records a call by hand.

### OpenTelemetry

Keep your OpenTelemetry setup: Fixwire never installs a tracer provider,
propagator or context manager.

```js
import * as otel from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import * as Fixwire from "@fixwire/node";

const dsn = "https://<publishable key>@ingest.eu.fixwire.io";
Fixwire.init({ dsn, integrations: [Fixwire.openTelemetryIntegration(otel)] }); // your OTel traces on Fixwire's errors
const exporter = new OTLPTraceExporter(Fixwire.otlpExporterOptions(dsn).traces); // your spans sent to Fixwire
```

## ⚙️ Configuration

Pass options to `init()` (or `new Client()`). Every option is typed and
documented in your editor.

| Option | Default | What it does |
|---|---|---|
| `dsn` | `FIXWIRE_DSN` (Node.js, edge) | Where data goes; none: the SDK does nothing |
| `release` | `FIXWIRE_RELEASE` (Node.js, edge) | Your version, e.g. `"web@1.4.0"`; needed for release health |
| `environment` | `FIXWIRE_ENVIRONMENT`, then `"production"` | e.g. `"staging"` |
| `dist` | none | A build of a release, when one release ships several |
| `serverName` | the host name (Node.js) | The machine's name |
| `sampleRate` | `1` | Share of errors and messages sent, after the crash-loop budget |
| `tracesSampleRate` | none | Share of traces recorded, 0 to 1; unset (and no `tracesSampler`): tracing is off |
| `tracesSampler` | none | Decides per trace (see [Sampling](https://github.com/fixwire/fixwire-js#sampling)) |
| `tracePropagationTargets` | browsers: the page's own origin; servers: none | Where outgoing requests carry trace headers (see [below](https://github.com/fixwire/fixwire-js#trace-propagation-targets)) |
| `maxBreadcrumbs` | `100` | Breadcrumbs kept per scope, the newest |
| `maxValueLength` | `1024` | Longest string sent, in bytes of UTF-8, `...` included (AI content keeps 16 kB) |
| `maxStackFrames` | `100` | Frames kept per error, the newest |
| `maxQueue` | `100` | Requests waiting to be sent, and as many waiting for a retry; past it new data is dropped |
| `beforeSend` | none | Changes or drops an event before it is sent |
| `beforeBreadcrumb` | none | Changes or drops a breadcrumb |
| `redact` | `true` | Mask secrets and personal data on the device |
| `sensitiveKeys` | built in | Replaces the key fragments (`password`, `token`, `secret`, …) whose values are masked |
| `sendDefaultPii` | `false` | Send users' IP addresses from proxy headers |
| `rateLimit` | 10 per issue, then 1 a minute; 100 a minute in all in browsers, 600 on servers | The crash-loop budget: `{ perIssueBurst, perIssuePerMinute, globalPerMinute, enabled }` |
| `offline` | `false` | Keep requests until sent: `true` or a directory (Node.js), or a store such as `makeIndexedDbSpool` (browsers) |
| `transport` | the runtime's | Replaces the HTTP transport (proxies, tests) |
| `defaultIntegrations` | `true` | Install the runtime's default integrations |
| `integrations` | `[]` | More integrations; one with a default's name replaces it |
| `debug` | `false` | Log the SDK's own problems, and why data is dropped, to the console |
| `recordAiContent` | `false` | Record prompts, outputs and tool arguments and results on AI spans, redacted |
| `autoSessionTracking` | `true` | Count sessions for crash-free rates (needs `release`) |
| `useEnvironment` | `true` | Node.js and edge: read `FIXWIRE_*` variables for unset options |
| `filterNoise` | `true` | Browsers: drop extension errors, "Script error." and ResizeObserver noise |
| `asyncLocalStorage` | found on its own where it can be | Edge: the runtime's `AsyncLocalStorage`, so concurrent requests keep their own scopes |

`OTEL_SERVICE_NAME` names the service. `flush(timeoutMs)` and
`close(timeoutMs)` wait 2000 ms by default and resolve within their
timeout.

### Trace propagation targets

Targets are matched against the URL without its user info, query and
fragment:

```js
Fixwire.init({
  dsn,
  tracePropagationTargets: [
    "internal.example", // this host and its subdomains (not badinternal.example)
    "billing.example:8443", // a host on one port
    "https://api.partner.example/v2", // URLs starting with this
    "/api/", // paths on the page's own origin (browsers)
    /^https:\/\/[a-z]+\.svc\.cluster\.local\//, // searched for in the URL
  ],
});
```

Without the option, browsers send trace headers to the page's own origin
and servers send them nowhere. An incoming `traceparent` is continued only
when well formed, and a caller's `tracestate` or `baggage` is passed on
only within W3C's sizes.

### Filtering events

`beforeSend` has the last word on an event: return it, changed or not, or
`null` to drop it. It runs before redaction, so what it adds is masked
too.

```js
Fixwire.init({
  dsn,
  beforeSend(event, hint) {
    const err = hint.originalException;
    if (err instanceof Error && err.name === "AbortError") return null; // a cancelled request
    return event;
  },
});
```

### Sampling

`sampleRate` keeps a share of errors and messages; `tracesSampleRate` keeps
a share of traces. A `tracesSampler` decides per trace, from the segment's
name, its attributes and the caller's decision; it returns a rate, `true`
or `false`, or `undefined` to use `tracesSampleRate`:

```js
Fixwire.init({
  dsn,
  tracesSampler: ({ name, parentSampled }) => {
    if (name.startsWith("GET /health")) return 0;
    return parentSampled ?? 0.2;
  },
});
```

Every service decides alike for the same trace, so traces stay whole.

### Redaction

Every string sent from your app's data goes through redaction first:
messages, attributes, span names, breadcrumbs, feedback, URLs and their
queries, and the keys of maps. The rules are the Fixwire server's, so what
is masked on your machine is what the server would mask. Redaction runs
before strings are cut to `maxValueLength`, so a secret the cut goes
through is still masked whole. `redact: false` turns it off;
`sensitiveKeys` replaces the key fragments whose values are always masked.

### Scopes

```js
Fixwire.setTag("plan", "team"); // this request or task
Fixwire.withScope((scope) => {
  scope.setContext("order", { id: "ord_1", items: 3 }); // this block only
  Fixwire.captureException(err);
});
```

Top-level `setUser`, `setTag`, `setContext` and `addBreadcrumb` write to the
current request or task (a page in browsers). `withIsolationScope` starts a
new one, for a job or a queue message of your own; `startSpan({ name, op },
callback)` adds a span of your own.

### Release health

With `release` set, each page load (browsers) or each request,
`wrapHandler` call, cron trigger and queue batch (servers and edge) is a
session: exited, errored or crashed, so each release gets crash-free rates.
Users leave only as hashes made on your machine.
`autoSessionTracking: false` turns it off.

### Cron monitors

Check in when a scheduled job starts and ends; its monitor notices runs
that fail, take too long or never happen:

```js
const checkInId = Fixwire.captureCheckIn(
  { monitorSlug: "nightly-report", status: "in_progress" },
  { schedule: { type: "crontab", value: "0 3 * * *" } },
);
await report();
Fixwire.captureCheckIn({ monitorSlug: "nightly-report", status: "ok", checkInId, duration: 42.5 });
```

### User feedback

Rate an AI answer, or say what went wrong with a crash. A negative score
opens a `user_feedback` issue for the agent:

```js
Fixwire.captureFeedback({ score: -1, traceId, message: "Refunded the wrong order" });
Fixwire.captureFeedback({ message: "It crashed on save", eventId: Fixwire.lastEventId() });
```

## 🧪 Examples

Real apps, each with its own README, run by the test suite against a fake
ingest so they keep working:

- [express-api](https://github.com/fixwire/fixwire-js/tree/main/examples/express-api): `init()` with no load-order rules, per-request users and tags, 5xx errors reported (sync and async) and 4xx not, a trace per request with a span of your own and a traced call to another service, flushing on shutdown.
- [node-worker](https://github.com/fixwire/fixwire-js/tree/main/examples/node-worker): one scope and one trace per job, carrying on after failures, the offline queue.
- [browser-vite](https://github.com/fixwire/fixwire-js/tree/main/examples/browser-vite): global handlers, unhandled rejections, fetch breadcrumbs, page-load and fetch traces, the offline queue, source maps with `fixwire-cli`.
- [support-agent](https://github.com/fixwire/fixwire-js/tree/main/examples/support-agent): an agent on Claude with agent runs, model calls with tokens, and tool calls and their failures.

## 📚 Documentation

The full guide lives in this README and the examples.

- [Configuration](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration)
- [Examples](https://github.com/fixwire/fixwire-js/tree/main/examples)
- [Changelog](https://github.com/fixwire/fixwire-js/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/fixwire/fixwire-js/blob/main/SECURITY.md)
- [Contributing guide](https://github.com/fixwire/fixwire-js/blob/main/CONTRIBUTING.md)

## 🚧 Coming from another error tracker?

The API follows the shape most error-tracking SDKs share: `init`,
`captureException`, `captureMessage`, `setUser`, `setTag`, `addBreadcrumb`,
`withScope`, `withIsolationScope` and `startSpan`, with the familiar
`beforeSend`, `sampleRate` and `tracesSampleRate` options. Moving over is
mostly a change of package and DSN: set `FIXWIRE_DSN`, `FIXWIRE_RELEASE`
and `FIXWIRE_ENVIRONMENT`, or pass them to `init()`. Two differences: in
Node.js nothing needs loading first (no `--import` flag), and on servers
trace headers go nowhere until you list `tracePropagationTargets`.

## 🙌 Want to contribute?

We'd love your help, whether it's a bug report, a fix or a new
integration. Start with the
[contributing guide](https://github.com/fixwire/fixwire-js/blob/main/CONTRIBUTING.md),
then pick from the
[open issues](https://github.com/fixwire/fixwire-js/issues) or the
[good first issues](https://github.com/fixwire/fixwire-js/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

To work on the SDK, use Node.js 24 and pnpm: `pnpm install`, then
`pnpm test`, `pnpm typecheck` and `pnpm lint`. `pnpm build && pnpm smoke`
checks the built package as an app installs it, `pnpm size` the browser
bundle against its budget, `pnpm pack-check` what each npm tarball
contains, and `pnpm license-gate` the licenses of what the packages depend
on.

## 🛟 Need help?

- Questions: ask on [Discord](https://fixwire.io/discord) or
  [Slack](https://fixwire.io/slack).
- Bugs: open a [GitHub issue](https://github.com/fixwire/fixwire-js/issues).
- Found a security issue? Please don't open an issue; follow the
  [security policy](https://github.com/fixwire/fixwire-js/blob/main/SECURITY.md).

## 🔗 Resources

- [Website](https://fixwire.io)
- [Pricing](https://fixwire.io/pricing)
- [Discord](https://fixwire.io/discord)
- [Slack](https://fixwire.io/slack)
- [X](https://fixwire.io/x)
- [Changelog](https://github.com/fixwire/fixwire-js/blob/main/CHANGELOG.md)
- [Examples](https://github.com/fixwire/fixwire-js/tree/main/examples)
- [Security policy](https://github.com/fixwire/fixwire-js/blob/main/SECURITY.md)

## 📃 License

The SDK is open source under the MIT license; see
[LICENSE](https://github.com/fixwire/fixwire-js/blob/main/LICENSE).
Parts are derived from other MIT-licensed SDKs; see
[NOTICE](https://github.com/fixwire/fixwire-js/blob/main/NOTICE).

## 😘 Contributors

Thanks to everyone who helps make Fixwire better!

<a href="https://github.com/fixwire/fixwire-js/graphs/contributors"><img src="https://contrib.rocks/image?repo=fixwire/fixwire-js" alt="Contributors" /></a>
