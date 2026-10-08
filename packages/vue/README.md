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

# Fixwire SDK for Vue

Welcome to `@fixwire/vue`, the official Vue SDK for
**[Fixwire](https://fixwire.io)**: the errors Vue catches (renders,
watchers, lifecycle hooks, event handlers), with their component, and
pages and navigations named after vue-router's routes (`/users/:id`). It
builds on
[`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser)
and exports all of it. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide. For Nuxt, use
[`@fixwire/nuxt`](https://github.com/fixwire/fixwire-js/tree/main/packages/nuxt).

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Vue 3.3 or newer; vue-router 4 or 5 for route names (CI tests both).

### Installation

```sh
npm install @fixwire/vue
pnpm add @fixwire/vue
yarn add @fixwire/vue
```

### Basic configuration

```ts
// src/main.ts
import { createApp } from "vue";
import * as Fixwire from "@fixwire/vue";
import App from "./App.vue";
import router from "./router";

const app = createApp(App);
app.use(router);

Fixwire.init({
  app,
  router,
  dsn: "https://<publishable key>@ingest.eu.fixwire.io",
  release: "web@1.4.0",
  tracesSampleRate: 0.2, // record 20% of page loads and navigations
});

app.mount("#app");
```

Call `init()` before `mount()`, so errors in the first render are reported
too. The DSN is your project's publishable key and the ingest host; the key
is safe in a bundle. Without a DSN, the SDK does nothing. `init()` never
throws: a broken DSN or option is said in a warning on the console and the
SDK stays off.

### Quick usage example

```vue
<script setup lang="ts">
import * as Fixwire from "@fixwire/vue";

async function pay() {
  try {
    await charge();
  } catch (error) {
    Fixwire.captureException(error); // handled: the page carries on
  }
}

function checkout() {
  throw new Error("Checkout failed"); // Vue catches it, Fixwire reports it
}
</script>
```

## ✨ Why Fixwire

- **Errors carry their place.** The component, its parents and where in it
  (render, setup, a hook, an event handler) come with every error Vue
  catches; the route it happened on is its transaction.
- **Your handler keeps working.** An `errorHandler` the app set stays and
  runs after Fixwire's; without one, errors are still logged as Vue logs
  them.
- **Secrets stay in the browser.** Props are sent only with
  `attachProps: true`, and secrets and personal data are masked before
  sending.
- **It never gets in your app's way.** Reporting never throws, and the SDK
  stays small (about 20 KB gzipped, tracing included).
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

| Integration | What it does | How to use |
|---|---|---|
| Vue's errors | Renders, `setup`, watchers, lifecycle hooks and event handlers, with the `vue` context (component, its parents, the hook); handlers set before keep running | `init({ app })`, or `attachErrorHandler(app)` |
| Routes | Page loads, navigations and the errors after them named after the route (`/users/:id`); the router's errors (a guard that throws, a lazy page that fails to load) reported | `init({ router })` |
| Tracing | Page loads and navigations as traces with web vitals, `fetch` calls as child spans | `tracesSampleRate`, with `router`; or `integrations: [Fixwire.browserTracingIntegration({ router })]` |

## ⚙️ Configuration

`init()` takes the browser SDK's options, listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration),
and:

| Option | Default | What it does |
|---|---|---|
| `app` | | The app, or apps, whose errors to report |
| `router` | | vue-router's router: routes name pages and errors |
| `logErrors` | `true` | Log errors to the console as Vue does, when the app has no `errorHandler` of its own |
| `attachProps` | `false` | Send the component's props with its errors |

For hosts that hand Vue's errors over another way, `captureVueError(error,
vm, info)` reports one with the same context. `@fixwire/vue/shared` has
the parts that don't need the browser SDK (reporting Vue's errors, naming
routes), for server rendering.

## 🧪 Examples

- [vue](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/vue): an app made with `create-vue` (Vue 3, vue-router 5, Vite), whose pages, buttons and router guard fail on purpose; its test builds it for production and checks what Fixwire receives in Chromium.

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

`init({ app, router })`, `attachErrorHandler` and
`browserTracingIntegration({ router })` work the way most error-tracking
SDKs' Vue packages do. `npx @fixwire/cli migrate .` shows the changes and
`--write` makes them.

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
