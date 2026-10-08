# Fixwire with SvelteKit

A [SvelteKit](https://svelte.dev/docs/kit) 3 app made with `sv create`
(the minimal template, TypeScript, adapter-node), set up with
[`@fixwire/sveltekit`](../../../packages/sveltekit): `src/hooks.server.ts`,
`src/hooks.client.ts`, `afterNavigate` in the root layout, the DSN in
`src/env.ts`, and the Vite plugin in `vite.config.ts`. Its pages fail on
purpose:

| Where | What fails | What Fixwire gets |
|---|---|---|
| `/users/crash` | A server load function throws | The error, once, named `/users/[id]` |
| `/api/orders/7` | An endpoint throws | The error, named `/api/orders/[id]` |
| `/`, **Check out** | A click handler throws | The error, named `/`, with debug ids for the source maps |
| `/`, **Empty the cart** | The next render throws | The error |
| **Reports** | A load function throws in the browser | The error, from the browser's handleError, named `/reports` |
| `/no/such/page` | Nothing: a 404 | Nothing |

Page loads, navigations and server requests are traced and named after
their routes, and the browser continues the server's trace.

## Run it

```sh
npm install
npm run build
PUBLIC_FIXWIRE_DSN=https://<publishable key>@ingest.eu.fixwire.io npm start
```

Open http://localhost:3000 and click around. The server reads the DSN from
`PUBLIC_FIXWIRE_DSN` too, so one variable sets both sides. The build writes
hidden source maps, stamped with debug ids by the Vite plugin; upload them
(and delete them, so they aren't served) before you deploy `build`:

```sh
FIXWIRE_URL=https://<fixwire api> FIXWIRE_AUTH_TOKEN=<key with artifacts:write> npm run sourcemaps
```

## Its test

`examples/frameworks/test/sveltekit.test.ts` installs this app with the
SDK's packages built from this repository, type-checks it (svelte-check),
builds it, runs it on Node.js against a fake ingest and drives it in
Chromium:

```sh
pnpm build
pnpm exec playwright install --only-shell chromium
node --test examples/frameworks/test/sveltekit.test.ts
```
