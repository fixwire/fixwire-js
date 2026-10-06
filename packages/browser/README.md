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

# Fixwire SDK for browsers

Welcome to `@fixwire/browser`, the official browser SDK for
**[Fixwire](https://fixwire.io)**. It captures errors, breadcrumbs, page-load
and route-change traces, release health and user feedback from web apps,
in about 16 KB gzipped. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- A modern browser (the SDK is built for ES2022), and any bundler.

### Installation

```sh
npm install @fixwire/browser
pnpm add @fixwire/browser
yarn add @fixwire/browser
```

For React, add [`@fixwire/react`](https://github.com/fixwire/fixwire-js/tree/main/packages/react).

### Basic configuration

Call `init()` once, as early as you can in your page's startup:

```js
import * as Fixwire from "@fixwire/browser";

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "web@1.4.0",
  environment: "production",
  tracesSampleRate: 0.2, // record 20% of traces
  integrations: [Fixwire.browserTracingIntegration()], // optional: traces
  // redact: false, // turn off masking of secrets and personal data
});
```

The DSN is your project's publishable key and the ingest host,
`https://<publishable key>@<host>`; the key is safe in a bundle. Without a
DSN, the SDK does nothing. `init()` never throws: a broken DSN or option is
said in a warning on the console and the SDK stays off.

### Quick usage example

```js
Fixwire.captureMessage("Hello Fixwire!"); // an info-level message in your project

try {
  JSON.parse("{ not json");
} catch (err) {
  Fixwire.captureException(err); // the error, with its stack, causes and breadcrumbs
}
```

Uncaught errors and unhandled rejections are reported by themselves.

## ✨ Why Fixwire

- **Secrets stay in the browser.** Secrets and personal data are masked
  before sending, with the same rules as the Fixwire server, and the page
  URL is sent without its query and fragment.
- **A crash loop costs a few events, not your quota.** Each issue sends a
  burst of 10 events, then 1 a minute, and 100 a minute at most in all.
- **It never gets in your page's way.** `init()` and captures never throw,
  the SDK listens instead of replacing `window.onerror`, and breadcrumbs
  never break `fetch` or `console`.
- **Small.** About 16 KB gzipped for errors; tracing is opt-in (about 3 KB
  more), and the offline store a separate import (0.5 KB more).
- **Your data stays in Europe.** Fixwire runs in Europe.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| Global handlers | Uncaught errors and unhandled rejections, through listeners (never `window.onerror`, so later libraries can't silently turn them off) | On by default |
| Breadcrumbs | Console calls and `fetch` requests as breadcrumbs | On by default |
| Noise filter | Drops extension errors, cross-origin "Script error." and ResizeObserver noise | On by default; `filterNoise: false` keeps them |
| Tracing | Page loads and route changes (`history.pushState`, back and forward) as traces ended when the page goes idle, with web vitals; `fetch` calls as child spans with trace headers; a server-rendered page's `<meta name="traceparent">` continued | `integrations: [Fixwire.browserTracingIntegration()]` with `tracesSampleRate` |
| Offline delivery | Events kept in IndexedDB until sent (100 requests, 5 MB and 72 hours at most); a closing page's last ones go out with `keepalive` | `offline: makeIndexedDbSpool` from `@fixwire/browser/offline` |
| React | Error boundaries and React 19's root error handlers | [`@fixwire/react`](https://github.com/fixwire/fixwire-js/tree/main/packages/react) |
| Source maps | Stacks show your original code | Upload maps with `fixwire-cli`; the debug IDs it injects link each error to its bundle's maps |

```js
import * as Fixwire from "@fixwire/browser";
import { makeIndexedDbSpool } from "@fixwire/browser/offline";

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  offline: makeIndexedDbSpool, // keep events through a dropped connection
});
```

## ⚙️ Configuration

All options are listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).
The ones you'll reach for first:

| Option | Default | What it does |
|---|---|---|
| `dsn`, `release`, `environment` | none, none, `"production"` | Where data goes, and which release and environment it belongs to |
| `tracesSampleRate` | none | Share of traces recorded, 0 to 1; unset: tracing is off |
| `tracePropagationTargets` | the page's own origin | Where `fetch` calls carry trace headers: `"/api"` (paths on the page's own origin), `"example.com"` (that host and its subdomains), a URL prefix with `://`, or a RegExp searched for in the URL without its query and fragment |
| `maxValueLength` | `1024` | Longest string sent, in bytes of UTF-8, `...` included |
| `beforeSend` | none | Changes or drops an event before it is sent |
| `filterNoise` | `true` | Drop extension errors, "Script error." and ResizeObserver noise |
| `offline` | none | `makeIndexedDbSpool` keeps events until they are sent |
| `autoSessionTracking` | `true` | Each page load is a session that ends exited, or crashed on an unhandled error (needs `release`); the user is sent only as a hash made in the browser |

## 🧪 Examples

- [browser-vite](https://github.com/fixwire/fixwire-js/tree/main/examples/browser-vite): global handlers, unhandled rejections, fetch breadcrumbs, page-load and fetch traces, the offline queue, source maps with `fixwire-cli`.

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
DSN. Tracing is an integration you add, so pages that only report errors
don't ship it.

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
