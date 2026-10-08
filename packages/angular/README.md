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

# Fixwire SDK for Angular

Welcome to `@fixwire/angular`, the official Angular SDK for
**[Fixwire](https://fixwire.io)**: an ErrorHandler that reports what
Angular catches (event handlers, change detection, `@boundary` blocks, the
window's errors), HttpClient's failures with their status and URL, and
pages and navigations named after the Router's routes (`/users/:id`). It
builds on
[`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser)
and exports all of it. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Angular 20 or newer, zoneless or with zone.js (the
  [example](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/angular)
  runs Angular 22).

### Installation

```sh
npm install @fixwire/angular
pnpm add @fixwire/angular
yarn add @fixwire/angular
```

### Basic configuration

```ts
// src/main.ts
import { bootstrapApplication } from "@angular/platform-browser";
import * as Fixwire from "@fixwire/angular";
import { appConfig } from "./app/app.config";
import { App } from "./app/app";

Fixwire.init({
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "web@1.4.0",
  tracesSampleRate: 0.2, // record 20% of page loads and navigations
});

bootstrapApplication(App, appConfig).catch((err) => Fixwire.captureException(err));
```

```ts
// src/app/app.config.ts
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideFixwire } from "@fixwire/angular";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes), provideFixwire()],
};
```

Call `init()` before `bootstrapApplication`, so errors while the app starts
are reported too. The DSN is your project's publishable key and the ingest
host; the key is safe in a bundle (`ng build --define
'FIXWIRE_DSN="…"'` sets it at build time). Without a DSN, the SDK does
nothing. `init()` never throws: a broken DSN or option is said in a warning
on the console and the SDK stays off.

### Source maps

Turn on hidden source maps for production in `angular.json`
(`"sourceMap": { "scripts": true, "hidden": true }`), then after `ng
build`, stamp and upload them with
[fixwire-cli](https://github.com/fixwire/fixwire-cli), which deletes them
so they aren't served:

```sh
npx @fixwire/cli sourcemaps upload --inject --delete dist/<app>/browser
```

### Quick usage example

```ts
import { Component } from "@angular/core";
import * as Fixwire from "@fixwire/angular";

@Component({ template: `<button (click)="pay()">Pay</button>` })
export class Checkout {
  async pay() {
    try {
      await this.charge();
    } catch (error) {
      Fixwire.captureException(error); // handled: the page carries on
    }
  }
}
```

## ✨ Why Fixwire

- **Nothing is sent twice.** An error both Angular's global listeners and
  the browser SDK see is reported once.
- **HttpClient's failures read well.** `HttpErrorResponse` isn't an Error;
  it arrives named as one, with the request's status and URL, and without
  the response body.
- **Errors carry their place.** A `@boundary` block's error names its
  component, and every error carries the route it happened on.
- **Angular keeps logging.** The ErrorHandler still logs as Angular's own
  does.
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| `provideFixwire` | Fixwire's ErrorHandler, HttpClient's errors described, and the Router's routes as the names of pages, navigations and errors; failed navigations reported | `providers: [provideFixwire()]` |
| `FixwireErrorHandler` | Reports what Angular hands its ErrorHandler; `@boundary` errors (`onViewError`) as handled, with their component | Provided by `provideFixwire()`, or `createErrorHandler()` |
| Tracing | Page loads and navigations as traces with web vitals, `fetch` calls as child spans | `tracesSampleRate` in `init()` |

## ⚙️ Configuration

`init()` takes the browser SDK's options, listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).
`provideFixwire()` and `createErrorHandler()` take `logErrors` (default
`true`): log errors to the console as Angular's ErrorHandler does.

## 🧪 Examples

- [angular](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/angular): an app made with `ng new` (Angular 22, zoneless), whose buttons, HTTP call, `@boundary` block and route guard fail on purpose; its test builds it for production and checks what Fixwire receives in Chromium.

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

`createErrorHandler()` and the providers work the way most error-tracking
SDKs' Angular packages do. `npx @fixwire/cli migrate .` shows the changes
and `--write` makes them.

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
