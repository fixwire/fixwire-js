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

# Fixwire SDK for Next.js

Welcome to `@fixwire/nextjs`, the official Next.js SDK for
**[Fixwire](https://fixwire.io)**: errors from server components, route
handlers, server actions, the proxy and the browser, with the route
pattern (`/users/[id]`); page loads and requests as traces; and source maps
for your browser code. One import serves every runtime: your bundler picks
the Node.js, edge or browser build of it. It is part of the
[Fixwire SDK for JavaScript](https://github.com/fixwire/fixwire-js), whose
README has the full guide.

## 📦 Getting started

### Prerequisites

- A Fixwire account and project: sign up at [fixwire.io](https://fixwire.io).
- Next.js 15.3 or newer with the App Router (the
  [example](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/nextjs)
  runs Next.js 16).

### Installation

```sh
npm install @fixwire/nextjs
pnpm add @fixwire/nextjs
yarn add @fixwire/nextjs
```

### Basic configuration

Put your DSN in `.env.local` (`NEXT_PUBLIC_` makes it part of the browser
bundle, which is fine: it holds the publishable key):

```sh
NEXT_PUBLIC_FIXWIRE_DSN=https://<publishable key>@ingest.eu.fixwire.io
```

Then three files at the root of your app (or in `src/`):

```ts
// instrumentation.ts: the server, on the Node.js and edge runtimes
import * as Fixwire from "@fixwire/nextjs";

export function register() {
  Fixwire.init({ tracesSampleRate: 0.2 });
}

export const onRequestError = Fixwire.captureRequestError;
```

```ts
// instrumentation-client.ts: the browser
import * as Fixwire from "@fixwire/nextjs";

Fixwire.init({ tracesSampleRate: 0.2 });

export const onRouterTransitionStart = Fixwire.onRouterTransitionStart;
```

```tsx
// app/global-error.tsx (and any error.tsx)
"use client";
import * as Fixwire from "@fixwire/nextjs";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  Fixwire.useCaptureException(error);
  return (
    <html lang="en">
      <body>
        <h2>Something went wrong</h2>
      </body>
    </html>
  );
}
```

`init()` reads the DSN, release and environment from `FIXWIRE_DSN`,
`FIXWIRE_RELEASE` and `FIXWIRE_ENVIRONMENT` on the server, and from their
`NEXT_PUBLIC_` versions everywhere, unless you pass them. Without a DSN,
the SDK does nothing. `init()` never throws: a broken DSN or option is said
in a warning and the SDK stays off.

### Source maps

```ts
// next.config.ts
import { withFixwireConfig } from "@fixwire/nextjs";

export default withFixwireConfig({ reactStrictMode: true });
```

`withFixwireConfig` turns on source maps for the browser build. After
`next build`, upload them with
[fixwire-cli](https://github.com/fixwire/fixwire-cli), which stamps each
file with a debug id first and then removes the maps, so they aren't
served:

```sh
npx @fixwire/cli sourcemaps upload --inject --delete .next/static
```

### Quick usage example

```tsx
// app/users/[id]/page.tsx: a server component
import * as Fixwire from "@fixwire/nextjs";

export default async function UserPage({ params }: PageProps<"/users/[id]">) {
  const { id } = await params;
  Fixwire.setTag("user.id", id); // stays with this request
  const user = await loadUser(id); // if it throws, the error arrives as /users/[id]
  return <h1>{user.name}</h1>;
}
```

## ✨ Why Fixwire

- **One import, every runtime.** The same `@fixwire/nextjs` works in
  `instrumentation.ts`, server components, the proxy and client
  components.
- **Nothing is sent twice.** A server error reaches your error page with a
  digest and without its message; it was reported on the server, so
  `useCaptureException` leaves it.
- **Secrets stay where they are.** Request headers come from an allowlist
  (cookies and authorization never leave), and secrets and personal data
  are masked before sending.
- **It never gets in your app's way.** Reporting never throws, and the
  browser part stays small (about 19 KB gzipped, tracing included).
- **Your data stays where you want it.** Fixwire keeps it in the region you
  choose for your project: the EU today, more regions soon.

## 🧩 Integrations

| What | What it does | How to use |
|---|---|---|
| `captureRequestError` | Errors in server components, route handlers, server actions and the proxy, with the route pattern, the router's context and the request; delivered before it returns | `export const onRequestError = Fixwire.captureRequestError` in `instrumentation.ts` |
| `onRouterTransitionStart` | A breadcrumb for each client navigation | `export const onRouterTransitionStart = Fixwire.onRouterTransitionStart` in `instrumentation-client.ts` |
| `useCaptureException` | Reports the error an error page shows, unless the server did | In `error.tsx` and `global-error.tsx` |
| `withFixwireConfig` | Source maps for the browser build | `export default withFixwireConfig(nextConfig)` |
| Browser | Uncaught errors, unhandled rejections, console and fetch breadcrumbs; page loads and navigations as traces when `tracesSampleRate` is set | On with `init()` in `instrumentation-client.ts` |
| Server | A scope per request, the caller's trace continued, a segment per request (named after its route when it fails), outgoing calls as spans | On with `init()` in `instrumentation.ts` |

Everything else in [`@fixwire/node`](https://github.com/fixwire/fixwire-js/tree/main/packages/node)
(on the server), [`@fixwire/browser`](https://github.com/fixwire/fixwire-js/tree/main/packages/browser)
(in the browser) and [`@fixwire/edge`](https://github.com/fixwire/fixwire-js/tree/main/packages/edge)
(on the edge runtime) is exported too: `captureException`, `setUser`,
`startSpan` and the rest.

## ⚙️ Configuration

`init()` takes the SDK's options, listed in the
[repository README](https://github.com/fixwire/fixwire-js#%EF%B8%8F-configuration);
each runtime reads the ones it knows. To pass different options to the
server and the browser, call `init()` with them in each file. The explicit
entry points `@fixwire/nextjs/server`, `@fixwire/nextjs/edge` and
`@fixwire/nextjs/client` are there for tools that don't pick by runtime.

Next.js doesn't tell the browser which route a URL matched, so page loads
and navigations are named by their path (`/users/42`); server errors carry
the route pattern.

## 🧪 Examples

- [nextjs](https://github.com/fixwire/fixwire-js/tree/main/examples/frameworks/nextjs): an app made with `create-next-app`, whose pages, route handler and buttons fail on purpose; its test builds it for production and checks what Fixwire receives in Chromium.

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

`captureRequestError`, `onRouterTransitionStart`, `withFixwireConfig` and
the instrumentation files work the way most error-tracking SDKs' Next.js
packages do. `npx @fixwire/cli migrate .` shows the changes (imports, the
config wrapper, the DSN) and `--write` makes them.

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
