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

# Fixwire SDK for React

Welcome to `@fixwire/react`, the official React SDK for
**[Fixwire](https://fixwire.io)**: error boundaries and React 19's root
error handlers for
[`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser),
so render errors arrive with their component stack. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- React 18 or 19 (CI tests both); the root error handlers need React 19.

### Installation

```sh
npm install @fixwire/browser @fixwire/react
pnpm add @fixwire/browser @fixwire/react
yarn add @fixwire/browser @fixwire/react
```

### Basic configuration

```jsx
import { createRoot } from "react-dom/client";
import * as Fixwire from "@fixwire/browser";
import { ErrorBoundary, reactErrorHandler } from "@fixwire/react";

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "web@1.4.0",
  environment: "production",
  tracesSampleRate: 0.2, // record 20% of traces
  integrations: [Fixwire.browserTracingIntegration()],
  // redact: false, // turn off masking of secrets and personal data
});

createRoot(document.getElementById("root"), {
  onUncaughtError: reactErrorHandler(),
  onCaughtError: reactErrorHandler({ handled: true }),
}).render(
  <ErrorBoundary fallback={({ resetError }) => <button onClick={resetError}>Try again</button>}>
    <App />
  </ErrorBoundary>,
);
```

The DSN is your project's publishable key and the ingest host,
`https://<publishable key>@<host>`; the key is safe in a bundle. Without a
DSN, the SDK does nothing. `init()` never throws: a broken DSN or option is
said in a warning on the console and the SDK stays off.

### Quick usage example

```jsx
import * as Fixwire from "@fixwire/browser";
import { withErrorBoundary } from "@fixwire/react";

Fixwire.captureMessage("Hello Fixwire!"); // an info-level message in your project

function Cart({ items }) {
  return <p>{items.length} items</p>; // a render error is reported with the component stack
}

export default withErrorBoundary(Cart, { fallback: <p>Something went wrong.</p> });
```

## ✨ Why Fixwire

- **Nothing is sent twice.** Errors a Fixwire boundary caught are left to
  it by the root handlers.
- **Secrets stay in the browser.** Secrets and personal data are masked
  before sending, with the same rules as the Fixwire server.
- **It never gets in your app's way.** Reporting never throws, and the
  browser SDK stays small (about 16 KB gzipped for errors).
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| `ErrorBoundary` | Reports what it catches with the component stack and renders `fallback` (an element, or a function of the error, its component stack, the event's id and `resetError`) | `<ErrorBoundary fallback={…}>` |
| `withErrorBoundary` | Wraps a component in an `ErrorBoundary` | `withErrorBoundary(Component, props)` |
| `reactErrorHandler` | Reports the errors React passes to the root (React 19); errors a Fixwire boundary caught are left to it | `onUncaughtError: reactErrorHandler()`, `onCaughtError` and `onRecoverableError: reactErrorHandler({ handled: true })` |

## ⚙️ Configuration

`ErrorBoundary` takes `fallback`, `beforeCapture(scope, error,
componentStack)` to add tags, context or a level to the error's event,
`onError(error, componentStack, eventId)` and `onReset(error)`.
`reactErrorHandler` takes `handled` (default `false`) and
`callback(error, errorInfo, eventId)`, e.g. to keep logging to the console.
The SDK's options are listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).

## 🧪 Examples

- [browser-vite](https://github.com/fixwire/fixwire-js/tree/main/examples/browser-vite): the browser SDK in a Vite app, with traces, the offline queue and source maps.

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

`ErrorBoundary`, `withErrorBoundary` and `reactErrorHandler` work the way
most error-tracking SDKs' React components do, with `fallback`,
`beforeCapture` and `onError`. Moving over is mostly a change of package
and DSN.

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
