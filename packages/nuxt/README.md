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

# Fixwire SDK for Nuxt

Welcome to `@fixwire/nuxt`, the official Nuxt module for
**[Fixwire](https://fixwire.io)**. One line in `nuxt.config` sets the SDK
up on both sides: in the browser, Vue's errors with their component, page
loads and navigations named after your routes (`/users/:id`); on the
server, errors from server rendering, API routes and server middleware,
each request named after its route. It builds on
[`@fixwire/vue`](https://github.com/fixwire/fixwire-js/tree/main/packages/vue)
and [`@fixwire/node`](https://github.com/fixwire/fixwire-js/tree/main/packages/node),
and is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Nuxt 3.13 or newer (the
  [example](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/nuxt)
  runs Nuxt 4), on Node.js.

### Installation

```sh
npm install @fixwire/nuxt
pnpm add @fixwire/nuxt
yarn add @fixwire/nuxt
```

### Basic configuration

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@fixwire/nuxt"],
  fixwire: {
    release: "shop@1.4.0",
    tracesSampleRate: 0.2, // record 20% of page loads, navigations and requests
  },
  sourcemap: { client: "hidden" }, // for readable browser stack traces
});
```

Set the DSN when the server starts, as Nuxt reads runtime config from the
environment:

```sh
NUXT_PUBLIC_FIXWIRE_DSN=https://<publishable key>@ingest.eu.fixwire.io node .output/server/index.mjs
```

(or put `dsn` in `fixwire` above). The key is publishable: the browser gets
it too. Without a DSN, the SDK does nothing, and it never throws: a broken
DSN or option is said in a warning and the SDK stays off.

Options that are functions go in `fixwire.client.config.ts` and
`fixwire.server.config.ts`, next to `nuxt.config.ts`; both are optional:

```ts
// fixwire.server.config.ts
import type { ServerConfig } from "@fixwire/nuxt";

export default {
  beforeSend(event) {
    if (event.request?.url?.includes("/health")) return null;
    return event;
  },
} satisfies ServerConfig;
```

### Source maps

With browser source maps on, the module stamps the browser files with
debug ids while Nuxt builds. Nitro records each file's size when it builds
the server, so stamping them afterwards would break them. Upload the maps
after `nuxt build` with
[fixwire-cli](https://github.com/fixwire/fixwire-cli), which deletes them
from the output so they aren't served:

```sh
npx @fixwire/cli sourcemaps upload --delete .output/public
```

### Quick usage example

```vue
<script setup lang="ts">
import { captureException } from "@fixwire/vue";

async function pay() {
  try {
    await $fetch("/api/pay", { method: "POST" });
  } catch (error) {
    captureException(error); // handled: the page carries on
  }
}
</script>
```

```ts
// server/api/orders/[id].get.ts
import { setTag } from "@fixwire/node";

export default defineEventHandler(async (event) => {
  setTag("order.id", getRouterParam(event, "id")); // stays with this request
  return await loadOrder(event); // if it throws, the error arrives as /api/orders/:id
});
```

## ✨ Why Fixwire

- **One module, both sides.** The browser and the server are set up from
  the same `fixwire` options, and the DSN can change without a rebuild.
- **Nuxt keeps its behavior.** Errors are read from Nuxt's own hooks, so
  Nuxt's error page shows when it would have, and not otherwise.
- **Nothing is sent twice.** An error a page throws while rendering on the
  server is reported once, however many layers Nuxt passes it through;
  expected HTTP errors (4xx) aren't reported.
- **Secrets stay where they are.** Request headers come from an allowlist
  (cookies and authorization never leave), props are sent only with
  `attachProps`, and secrets and personal data are masked before sending.
- **Your data stays in Europe.** Fixwire runs in Europe.

## 🧩 Integrations

| What | What it does |
|---|---|
| Browser | Vue's errors (renders, setup, watchers, hooks, event handlers) with their component; plugin and startup errors; uncaught errors and rejections; page loads and navigations as traces, named after the route |
| Server rendering | Vue's errors while rendering, with their component; the request named after the page's route |
| Nitro | Errors from API routes, server middleware and the renderer, with the request; API requests named after their route (`/api/orders/:id`); a scope per request |
| Source maps | Debug ids stamped into the browser build when client source maps are on |

The SDKs' functions are yours too: import them from `@fixwire/vue` in the
app and from `@fixwire/node` on the server.

## ⚙️ Configuration

`fixwire` in `nuxt.config` takes `dsn`, `release`, `environment`, `dist`,
`sampleRate`, `tracesSampleRate`, `maxBreadcrumbs`, `sendDefaultPii`,
`debug` and `attachProps` (send components' props with their errors,
default `false`). As runtime config, they can be set when the server
starts: `NUXT_PUBLIC_FIXWIRE_DSN`, `NUXT_PUBLIC_FIXWIRE_RELEASE` and
`NUXT_PUBLIC_FIXWIRE_ENVIRONMENT` always, the others
(`NUXT_PUBLIC_FIXWIRE_TRACES_SAMPLE_RATE`…) when `nuxt.config` sets them.
`fixwire.client.config.ts` and `fixwire.server.config.ts` export any of the
browser's and the Node.js SDK's options (or a function returning them),
which win; they're listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration).

## 🧪 Examples

- [nuxt](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/nuxt): an app made with `create-nuxt` (Nuxt 4), whose page, API route and buttons fail on purpose; its test type-checks it, builds it, runs it on Node.js and checks what Fixwire receives in Chromium.

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

The module, its `nuxt.config` key and the client and server config files
work the way most error-tracking SDKs' Nuxt modules do. `npx @fixwire/cli
migrate .` shows the changes and `--write` makes them.

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
