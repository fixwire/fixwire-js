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

# Fixwire SDK for SvelteKit

Welcome to `@fixwire/sveltekit`, the official SvelteKit SDK for
**[Fixwire](https://fixwire.io)**: unexpected errors from load functions,
actions, endpoints and the browser, each named after its route
(`/users/[id]`); page loads, navigations and requests as traces, the
browser continuing the server's; and source maps stamped while Vite builds.
One import serves both sides: your bundler picks the server or the browser
build of it. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- SvelteKit 2 or 3 (both `handleError` shapes are understood; the
  [example](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/sveltekit)
  runs SvelteKit 3), on Node.js on the server (adapter-node, or a
  serverless adapter's Node.js runtime).

### Installation

```sh
npm install @fixwire/sveltekit
pnpm add @fixwire/sveltekit
yarn add @fixwire/sveltekit
```

### Basic configuration

```ts
// src/hooks.server.ts
import * as Fixwire from "@fixwire/sveltekit";
import { sequence, type Handle, type HandleServerError, type ServerInit } from "@sveltejs/kit/hooks";

export const init: ServerInit = () => {
  Fixwire.init({ tracesSampleRate: 0.2 }); // FIXWIRE_DSN or PUBLIC_FIXWIRE_DSN
};
export const handle: Handle = sequence(Fixwire.fixwireHandle());
export const handleError: HandleServerError = Fixwire.handleErrorWithFixwire();
```

```ts
// src/hooks.client.ts
import * as Fixwire from "@fixwire/sveltekit";
import { PUBLIC_FIXWIRE_DSN } from "$app/env/public";
import type { ClientInit, HandleClientError } from "@sveltejs/kit/hooks";

export const init: ClientInit = () => {
  Fixwire.init({ dsn: PUBLIC_FIXWIRE_DSN, tracesSampleRate: 0.2 });
};
export const handleError: HandleClientError = Fixwire.handleErrorWithFixwire();
```

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import * as Fixwire from "@fixwire/sveltekit";
  import { afterNavigate } from "$app/navigation";

  let { children } = $props();
  afterNavigate(Fixwire.trackNavigation);
</script>

{@render children()}
```

On SvelteKit 3, declare the DSN in `src/env.ts` so the browser gets it
when the server starts (on SvelteKit 2, read it from `$env/dynamic/public`
instead):

```ts
// src/env.ts
import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  PUBLIC_FIXWIRE_DSN: { public: true, schema: (value) => value },
});
```

The DSN is your project's publishable key and the ingest host,
`https://<publishable key>@ingest.eu.fixwire.io`. Without a DSN, the SDK
does nothing. `init()` never throws: a broken DSN or option is said in a
warning and the SDK stays off.

### Source maps

```ts
// vite.config.ts
import { fixwireSvelteKit } from "@fixwire/sveltekit/vite";

export default defineConfig({
  build: { sourcemap: "hidden" },
  plugins: [fixwireSvelteKit(), sveltekit({ adapter: adapter() })],
});
```

`fixwireSvelteKit()` stamps the client build with debug ids while Vite
writes it. adapter-node lists and compresses the files when it builds, so
stamping them afterwards would break them. Upload the maps after the build
with [fixwire-cli](https://github.com/fixwire/fixwire-cli), which deletes
them so they aren't served:

```sh
npx @fixwire/cli sourcemaps upload --delete build/client
```

### Quick usage example

```ts
// src/routes/users/[id]/+page.server.ts
import * as Fixwire from "@fixwire/sveltekit";

export const load = async ({ params }) => {
  Fixwire.setTag("user.id", params.id); // stays with this request
  return { user: await loadUser(params.id) }; // if it throws, the error arrives as /users/[id]
};
```

## ✨ Why Fixwire

- **Only bugs are reported.** Errors you throw with `error()`,
  SvelteKit's own (such as 404s) and failed validation aren't; unknown
  errors are, once each.
- **Every error has its route.** Server errors, browser errors and
  traces are named after the route that matched, the first page load
  included.
- **Your handler still decides.** `handleErrorWithFixwire(handler)` returns
  what your handler returns, the `App.Error` SvelteKit shows.
- **Secrets stay where they are.** Request headers come from an allowlist
  (cookies and authorization never leave), and secrets and personal data
  are masked before sending.
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

| What | What it does | How to use |
|---|---|---|
| `handleErrorWithFixwire` | Reports unexpected errors (SvelteKit 3's `kind: "unknown"`, SvelteKit 2's 5xx) from load functions, actions and endpoints, or from the browser's navigations, named after the route; returns your handler's `App.Error` | `export const handleError = Fixwire.handleErrorWithFixwire(handler?)` in both hooks files |
| `fixwireHandle` | Names each request after its route (`GET /users/[id]`) and puts the route and the request's trace in a rendered page's head, so the browser names its page load and continues the trace | `sequence(Fixwire.fixwireHandle(), …)` in hooks.server.ts |
| `trackNavigation` | Names navigations and the errors after them after the route | `afterNavigate(Fixwire.trackNavigation)` in the root layout |
| `fixwireSvelteKit` | Debug ids in the client build | `plugins: [fixwireSvelteKit(), sveltekit()]` in vite.config.ts |
| Browser | Uncaught errors (event handlers, components) and rejections, console and fetch breadcrumbs, page loads and navigations as traces | On with `init()` in hooks.client.ts |
| Server | A scope per request, the caller's trace continued, a segment per request, outgoing calls as spans | On with `init()` in hooks.server.ts |

Everything in [`@fixwire/node`](https://github.com/fixwire/fixwire-js/tree/main/packages/node)
(on the server) and [`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser)
(in the browser) is exported too.

## ⚙️ Configuration

`init()` takes the SDK's options, listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration);
each side reads the ones it knows. On the server, unset `dsn`, `release`
and `environment` come from `FIXWIRE_DSN`, `FIXWIRE_RELEASE` and
`FIXWIRE_ENVIRONMENT`, or their `PUBLIC_` versions. The explicit entry
points `@fixwire/sveltekit/server` and `@fixwire/sveltekit/client` are
there for tools that don't pick by environment.

For plain Svelte without SvelteKit, use
[`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser),
and report what a `<svelte:boundary onerror={…}>` catches with
`captureException`.

## 🧪 Examples

- [sveltekit](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/sveltekit): an app made with `sv create` (SvelteKit 3, Svelte 5, adapter-node), whose load functions, endpoint and buttons fail on purpose; its test type-checks it, builds it, runs it on Node.js and checks what Fixwire receives in Chromium.

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

`handleErrorWithFixwire`, `fixwireHandle` and the Vite plugin work the way
most error-tracking SDKs' SvelteKit packages do. `npx @fixwire/cli migrate
.` shows the changes and `--write` makes them.

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
