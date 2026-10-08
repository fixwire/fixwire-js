<div align="center">

_Bugs reach production. Fixwire finds them first: errors, traces, logs and
AI agent runs in one place, an AI debugger on every plan, and your data
kept in the region you choose._

[![Discord](https://img.shields.io/badge/Discord-join%20us-5865F2?logo=discord&logoColor=white)](https://fixwire.io/discord)
[![Slack](https://img.shields.io/badge/Slack-community-4A154B?logo=slack&logoColor=white)](https://fixwire.io/slack)
[![X](https://img.shields.io/badge/X-follow%20us-000000?logo=x&logoColor=white)](https://fixwire.io/x)
[![Release](https://img.shields.io/github/v/release/fixwire/fixwire-js?label=release)](https://github.com/fixwire/fixwire-js/releases)
[![Node.js](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-blue?logo=node.js&logoColor=white)](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml)
[![CI](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml/badge.svg)](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/fixwire/fixwire-js/blob/main/LICENSE)

<br/>

</div>

# Fixwire SDK for edge runtimes

Welcome to `@fixwire/edge`, the official SDK for
**[Fixwire](https://fixwire.io)** on edge runtimes: Cloudflare Workers,
Vercel Edge Functions and Next.js middleware, Deno Deploy and Netlify Edge
Functions. It captures errors, traces, release health, cron monitor
check-ins, user feedback and AI agent runs. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- An edge runtime with `fetch`: Cloudflare Workers (with `nodejs_compat`
  for `node:async_hooks`), Vercel Edge, Deno Deploy or Netlify Edge
  Functions.

### Installation

```sh
npm install @fixwire/edge
pnpm add @fixwire/edge
yarn add @fixwire/edge
```

### Basic configuration

On Cloudflare Workers, wrap the module; the SDK starts on the first
invocation, with `FIXWIRE_DSN`, `FIXWIRE_RELEASE` and `FIXWIRE_ENVIRONMENT`
from `env` filling unset options:

```js
import { AsyncLocalStorage } from "node:async_hooks";
import * as Fixwire from "@fixwire/edge";

export default Fixwire.withFixwire(
  (env) => ({
    dsn: env.FIXWIRE_DSN, // https://<publishable key>@ingest.eu.fixwire.io
    release: "web@1.4.0",
    environment: "production",
    tracesSampleRate: 0.2, // record 20% of traces
    asyncLocalStorage: AsyncLocalStorage, // scopes per request
    // redact: false, // turn off masking of secrets and personal data
  }),
  {
    async fetch(request, env, ctx) {
      return new Response("ok");
    },
  },
);
```

On Vercel Edge Functions and Next.js middleware, Deno and Netlify Edge
Functions, call `init()` and wrap each handler:

```js
import { waitUntil } from "@vercel/functions";
import * as Fixwire from "@fixwire/edge";

Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "web@1.4.0" });

export const GET = Fixwire.wrapRequestHandler(async (request) => Response.json(await load()), {
  waitUntil,
});
```

In Next.js middleware, pass `event.waitUntil`; on Netlify,
`context.waitUntil`. Without `waitUntil` the handler waits for delivery
before returning. The DSN is your project's publishable key and the ingest
host, `https://<publishable key>@<host>`; without one, the SDK does
nothing. `init()` never throws: a broken DSN or option is said in a warning
on the console and the SDK stays off.

### Quick usage example

```js
Fixwire.captureMessage("Hello Fixwire!"); // an info-level message in your project

try {
  JSON.parse("{ not json");
} catch (err) {
  Fixwire.captureException(err); // the error, with its stack, causes and breadcrumbs
}
```

An error a wrapped handler throws is reported, then thrown on.

## ✨ Why Fixwire

- **Secrets stay in your worker.** Secrets and personal data are masked
  before sending, with the same rules as the Fixwire server; request
  headers come from an allowlist, never cookies or authorization.
- **Sent after the response.** Errors and spans travel as OpenTelemetry
  (OTLP/HTTP JSON), gzipped and sent through the runtime's `waitUntil`, so
  the isolate isn't stopped first.
- **It never gets in your app's way.** `init()` and captures never throw,
  deliveries follow no redirect and time out after 10 seconds, and queues,
  strings and retries all have fixed limits.
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| Cloudflare Workers | Fetch handlers, cron triggers (`scheduled`) and queue consumers (`queue`): a scope, a segment and error reporting each; other handlers pass through | `Fixwire.withFixwire((env) => options, handlers)` |
| Vercel Edge, Next.js middleware, Deno, Netlify Edge | A scope and a segment per request, the caller's trace (W3C `traceparent` and `tracestate`) continued, errors reported | `Fixwire.wrapRequestHandler(handler, { waitUntil })` |
| Per-request scopes | `setUser`, `setTag` and breadcrumbs stay with the request that set them, through the runtime's `AsyncLocalStorage` (found on its own on Vercel Edge; pass it elsewhere) | `asyncLocalStorage` option |
| `fetch` | Calls become child spans with a breadcrumb, and carry trace headers to `tracePropagationTargets` | On by default |
| OpenAI, Anthropic, AI agents | Model calls, agent runs and tool calls as spans | `Fixwire.wrapOpenAI()`, `Fixwire.wrapAnthropic()`, `Fixwire.ai.agent()`, `ai.chat()`, `ai.tool()` |

## ⚙️ Configuration

All options are listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).
The ones you'll reach for first:

| Option | Default | What it does |
|---|---|---|
| `dsn`, `release`, `environment` | `FIXWIRE_DSN`, `FIXWIRE_RELEASE`, `FIXWIRE_ENVIRONMENT` (then `"production"`) | Where data goes, and which release and environment it belongs to; read from `env` in `withFixwire`, else from `process.env` where the runtime has it |
| `asyncLocalStorage` | found on its own where it can be | The runtime's `AsyncLocalStorage`; without one, requests an isolate serves at the same time share their scope |
| `tracesSampleRate` | none | Share of traces recorded, 0 to 1; unset: tracing is off |
| `tracePropagationTargets` | none | Where `fetch` calls carry trace headers: `"example.com"` is that host and its subdomains (`"example.com:8443"` on that port only), a string with `://` a URL prefix, a RegExp is searched for in the URL without its query and fragment |
| `maxValueLength` | `1024` | Longest string sent, in bytes of UTF-8, `...` included |
| `beforeSend` | none | Changes or drops an event before it is sent |
| `autoSessionTracking` | `true` | Each request, cron trigger and queue batch is a session for crash-free rates (needs `release`); users are sent only as hashes |
| `useEnvironment` | `true` | Read `FIXWIRE_*` variables from `process.env`, where the runtime has it |

`wrapRequestHandler` takes `flushTimeoutMs` (default 2000): the longest
wait for queued events.

## 🧪 Examples

The [examples](https://github.com/fixwire/fixwire-js/tree/main/examples)
show the Node.js and browser SDKs; the samples above are the edge setup.

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
`withScope` and `startSpan`. Moving over is mostly a change of package and
DSN. Trace headers go nowhere until you list `tracePropagationTargets`.

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
