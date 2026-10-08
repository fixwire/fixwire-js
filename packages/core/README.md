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

# Fixwire SDK core for JavaScript

Welcome to `@fixwire/core`, the runtime-agnostic core of the official
JavaScript SDK for **[Fixwire](https://fixwire.io)**: the client, scopes,
on-device redaction, the crash-loop budget, delivery, tracing and AI agent
tracing that every runtime package shares. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Node.js 20 or newer, a modern browser or an edge runtime.

### Installation

Install the SDK for your runtime instead; it brings this package and
re-exports everything here:

| Package | For |
|---|---|
| [`@fixwire/node`](https://github.com/fixwire/fixwire-js/tree/main/packages/node) | Node.js: servers, workers, CLIs and serverless functions |
| [`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser) | Web apps |
| [`@fixwire/edge`](https://github.com/fixwire/fixwire-js/tree/main/packages/edge) | Cloudflare Workers, Vercel Edge, Deno Deploy, Netlify Edge Functions |
| [`@fixwire/react`](https://github.com/fixwire/fixwire-js/tree/main/packages/react) | React, with `@fixwire/browser` |

```sh
npm install @fixwire/node
pnpm add @fixwire/node
yarn add @fixwire/node
```

### Basic configuration

```js
import * as Fixwire from "@fixwire/node"; // or @fixwire/browser, @fixwire/edge

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "api@1.4.0",
  environment: "production",
  tracesSampleRate: 0.2, // record 20% of traces
  // sendDefaultPii: true, // also send users' IP addresses from proxy headers (Node.js)
  // redact: false,        // turn off masking of secrets and personal data
});
```

The DSN is your project's publishable key and the ingest host,
`https://<publishable key>@<host>`; without one, the SDK does nothing.
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

## ✨ Why Fixwire

- **Secrets stay on the device.** The core masks secrets and personal data
  with the same rules as the Fixwire server, before anything is sent.
- **A crash loop costs a few events, not your quota.** Each issue sends a
  burst of 10 events, then 1 a minute, and a count of the rest.
- **It never gets in your app's way.** Captures never throw, and queues,
  strings (1,024 bytes by default), stacks (100 frames) and retries (4
  sends) all have fixed limits.
- **OpenTelemetry inside.** It speaks the Fixwire protocol (OpenTelemetry's
  OTLP/HTTP plus a few small JSON endpoints).
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

What the core provides, through every runtime package:

| Integration | What it does | How to use |
|---|---|---|
| OpenAI | Chat completions, responses and embeddings (streamed too) become spans with the model, tokens and finish reasons | `Fixwire.wrapOpenAI(new OpenAI())` |
| Anthropic | Messages (streamed too) become chat spans with the model, tokens (cache tokens too) and stop reason | `Fixwire.wrapAnthropic(new Anthropic())` |
| AI agents | Agent runs, model calls and tool calls with the OpenTelemetry GenAI conventions | `Fixwire.ai.agent()`, `ai.chat()`, `ai.tool()`, `ai.embeddings()` |
| OpenTelemetry | Your OpenTelemetry spans' traces on Fixwire's errors; your OTLP exporters pointed at Fixwire | `Fixwire.openTelemetryIntegration(otel)`, `Fixwire.otlpExporterOptions(dsn)` |
| Custom runtimes | A client without globals, or for a runtime of your own | `new Client(options, platform)` |

## ⚙️ Configuration

Every option of `init()` and `new Client()` is listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).

## 🧪 Examples

The [examples](https://github.com/fixwire/fixwire-js/tree/main/examples)
show the runtime packages: an Express API, a worker, a Vite app and an
agent on Claude.

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
change of package and DSN.

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
