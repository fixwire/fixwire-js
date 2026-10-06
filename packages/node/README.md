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

# Fixwire SDK for Node.js

Welcome to `@fixwire/node`, the official Node.js SDK for
**[Fixwire](https://fixwire.io)**. It captures errors and crashes, traces,
release health, cron monitor check-ins, user feedback and AI agent runs
from servers, workers, CLIs and serverless functions. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Node.js 20 or newer. CI tests Node.js 22 and 24 on Linux and 24 on macOS
  and Windows, and runs the built package on Node.js 20.

### Installation

```sh
npm install @fixwire/node
pnpm add @fixwire/node
yarn add @fixwire/node
```

### Basic configuration

Call `init()` once, as early as you can in your app's startup (anywhere
works: requests are followed through Node's diagnostics channels, with no
`--import` flag and no load order):

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
`https://<publishable key>@<host>`. Without the `dsn` option the SDK reads
`FIXWIRE_DSN` (and `FIXWIRE_RELEASE` and `FIXWIRE_ENVIRONMENT`);
`OTEL_SERVICE_NAME` names the service. Without a DSN, the SDK does nothing.
`init()` never throws: a broken DSN or option is said in a warning on the
console and the SDK stays off.

### Quick usage example

```js
Fixwire.captureMessage("Hello Fixwire!"); // an info-level message in your project

try {
  JSON.parse("{ not json");
} catch (err) {
  Fixwire.captureException(err); // the error, with its stack, causes and breadcrumbs
}
```

Uncaught exceptions and unhandled rejections are reported by themselves.
The SDK never keeps the process alive: at the end of a short script,
`await Fixwire.close()` sends what is queued (it waits 2 seconds at most).

## ✨ Why Fixwire

- **Secrets stay on your machine.** Secrets and personal data are masked
  before sending, with the same rules as the Fixwire server; request
  headers come from an allowlist, never cookies or authorization.
- **A crash loop costs a few events, not your quota.** Each issue sends a
  burst of 10 events, then 1 a minute, and a count of the rest.
- **It never gets in your app's way.** `init()` and captures never throw,
  nothing is patched, and queues, strings, stacks and retries all have
  fixed limits.
- **OpenTelemetry inside.** Errors, messages and spans travel as
  OpenTelemetry (OTLP/HTTP JSON), so your OpenTelemetry SDK can send to the
  same endpoint (`Fixwire.otlpExporterOptions(dsn)`).
- **Your data stays in Europe.** Fixwire runs in Europe.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| Uncaught errors | Uncaught exceptions (reported as fatal, flushed, then the process exits as Node.js would) and unhandled rejections | On by default |
| HTTP servers | A scope per request (`setUser`, `setTag` and breadcrumbs stay with it), the caller's trace continued, a segment per request named after its route, request sessions; Express and any server on `node:http` | On by default |
| Express | 5xx errors (sync and async) with the request and the route; 4xx are not reported | `Fixwire.setupExpressErrorHandler(app)` after your routes |
| Outgoing HTTP | `http`, `https` and `fetch` calls become child spans with an `http` breadcrumb, and carry trace headers (W3C `traceparent` and `tracestate`; `baggage` passes through) to `tracePropagationTargets`; headers on `http` and `https` calls need Node.js 22.14+ | On by default |
| Next.js | Server errors with the route pattern and the request | `export const onRequestError = Fixwire.captureRequestError` in `instrumentation.ts` |
| Serverless functions | A scope and a segment per call, errors reported, flushed before it returns (`flushTimeoutMs`, default 2000) | `Fixwire.wrapHandler(async (event, context) => …)` |
| Server-rendered pages | Hands the request's trace to the browser SDK | `Fixwire.getTraceMetaTags()` in the page's `<head>` |
| Offline delivery | Requests kept on disk (private to your user) until the server has them, across outages and restarts | `offline: true`, or a directory path |
| OpenAI, Anthropic | Model calls (streamed too) become chat spans with the model, tokens and finish reasons | `Fixwire.wrapOpenAI(new OpenAI())`, `Fixwire.wrapAnthropic(new Anthropic())` |
| AI agents | Agent runs, model calls and tool calls with the OpenTelemetry GenAI conventions | `Fixwire.ai.agent()`, `ai.chat()`, `ai.tool()`, `ai.embeddings()` |
| OpenTelemetry | Your OpenTelemetry spans' traces on Fixwire's errors; your OTLP exporters pointed at Fixwire | `Fixwire.openTelemetryIntegration(otel)`, `Fixwire.otlpExporterOptions(dsn)` |

```js
import express from "express";
import * as Fixwire from "@fixwire/node";

Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "api@1.4.0", tracesSampleRate: 0.2 });

const app = express();
app.get("/orders/:id", (req, res) => res.json(loadOrder(req.params.id)));
Fixwire.setupExpressErrorHandler(app); // after your routes
app.listen(3000);
```

The [repository README](https://github.com/fixwire/fixwire-js#-integrations)
shows each integration with a sample.

## ⚙️ Configuration

All options are listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).
The ones you'll reach for first:

| Option | Default | What it does |
|---|---|---|
| `dsn`, `release`, `environment` | `FIXWIRE_DSN`, `FIXWIRE_RELEASE`, `FIXWIRE_ENVIRONMENT` (then `"production"`) | Where data goes, and which release and environment it belongs to |
| `serverName` | the host name | The machine's name |
| `tracesSampleRate` | none | Share of traces recorded, 0 to 1; unset: tracing is off |
| `tracePropagationTargets` | none | Where outgoing requests carry trace headers: `"example.com"` is that host and its subdomains (`"example.com:8443"` on that port only), a string with `://` a URL prefix, a RegExp is searched for in the URL without its query and fragment |
| `maxValueLength` | `1024` | Longest string sent, in bytes of UTF-8, `...` included |
| `maxStackFrames` | `100` | Frames kept per error, the newest |
| `beforeSend` | none | Changes or drops an event before it is sent |
| `offline` | `false` | Keep requests on disk until sent |
| `autoSessionTracking` | `true` | Each request (and each `wrapHandler` call) is a session for crash-free rates (needs `release`); users are sent only as hashes |
| `useEnvironment` | `true` | Read the `FIXWIRE_*` variables for unset options |

## 🧪 Examples

- [express-api](https://github.com/fixwire/fixwire-js/tree/main/examples/express-api): per-request users and tags, 5xx errors reported and 4xx not, a trace per request, flushing on shutdown.
- [node-worker](https://github.com/fixwire/fixwire-js/tree/main/examples/node-worker): one scope and one trace per job, the offline queue.
- [support-agent](https://github.com/fixwire/fixwire-js/tree/main/examples/support-agent): an agent on Claude with agent runs, model calls and tool calls.

## 📚 Documentation

The full guide lives in the
[repository README](https://github.com/fixwire/fixwire-js#readme) and the
examples.

- [Configuration](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration)
- [Examples](https://github.com/fixwire/fixwire-js/tree/main/examples)
- [Changelog](https://github.com/fixwire/fixwire-js/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/fixwire/fixwire-js/blob/main/SECURITY.md)
- [Contributing guide](https://github.com/fixwire/fixwire-js/blob/main/CONTRIBUTING.md)

## 🚧 Coming from another error tracker?

The API follows the shape most error-tracking SDKs share: `init`,
`captureException`, `captureMessage`, `setUser`, `setTag`, `addBreadcrumb`,
`withScope`, `withIsolationScope` and `startSpan`. Moving over is mostly a
change of package and DSN. Nothing needs loading first, and trace headers
go nowhere until you list `tracePropagationTargets`.

## 🙌 Want to contribute?

We'd love your help, whether it's a bug report, a fix or a new
integration. Start with the
[contributing guide](https://github.com/fixwire/fixwire-js/blob/main/CONTRIBUTING.md),
then pick from the
[open issues](https://github.com/fixwire/fixwire-js/issues) or the
[good first issues](https://github.com/fixwire/fixwire-js/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

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
