# Fixwire for JavaScript

[![CI](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml/badge.svg)](https://github.com/fixwire/fixwire-js/actions/workflows/ci.yml)

The Fixwire SDKs for JavaScript and TypeScript: errors, traces and AI agent
runs from Node.js, browsers, edge runtimes and React. Secrets and personal
data are masked on the device, with the same rules as the Fixwire server.

| Package | For |
|---|---|
| [`@fixwire/node`](packages/node) | Node.js 20+: servers, workers, CLIs; Express and Next.js |
| [`@fixwire/browser`](packages/browser) | Web apps, within a size budget |
| [`@fixwire/edge`](packages/edge) | Cloudflare Workers, Vercel Edge and Next.js middleware, Deno, Netlify Edge Functions |
| [`@fixwire/react`](packages/react) | React 18+: error boundaries, and React 19's root error handlers |
| [`@fixwire/core`](packages/core) | What they share: the client, scopes, redaction, budgets and delivery (installed with them) |

```sh
npm install @fixwire/node
```

```js
import * as Fixwire from "@fixwire/node";

Fixwire.init({
  dsn: process.env.FIXWIRE_DSN, // unset: the SDK does nothing
  release: "api@1.4.0",
});
```

Each package's README has the details. [examples](examples) has real apps
(an Express API, a worker, a Vite app, an agent on Claude), run against a
fake ingest in CI so they keep working.

## Development

Node 24 and pnpm:

```sh
pnpm install
pnpm test          # every package and the examples, from source
pnpm typecheck && pnpm lint
pnpm build && pnpm smoke   # the built package, as an app installs it
```

`pnpm size` checks the browser bundle against its budget, `pnpm pack-check`
what each npm tarball contains and `pnpm license-gate` the licenses of what
the packages depend on.

## License

[MIT](LICENSE)
