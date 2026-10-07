# Fixwire with Nuxt

A [Nuxt](https://nuxt.com) 4 app made with `create-nuxt` (the minimal
template), set up with [`@fixwire/nuxt`](../../../packages/nuxt): one line
in `nuxt.config.ts`, and `fixwire.client.config.ts` and
`fixwire.server.config.ts` for a `beforeSend` on each side. Its pages fail
on purpose:

| Where | What fails | What Fixwire gets |
|---|---|---|
| `/users/crash` | The page throws while it's rendered on the server | The error, once, named `/users/:id`, from the server |
| `/api/orders/7` | An API route throws | The error, named `/api/orders/:id` |
| `/`, **Check out** | A click handler throws | The error, with its component, named `/`, with debug ids for the source maps; the page carries on |
| `/`, **Empty the cart** | The next render throws | The error |
| `/no/such/page` | Nothing: a 404 | Nothing |

Page loads, navigations and server requests are traced and named after
their routes.

## Run it

```sh
npm install
npm run build
NUXT_PUBLIC_FIXWIRE_DSN=https://<publishable key>@ingest.eu.fixwire.io node .output/server/index.mjs
```

Open http://localhost:3000 and click around. The DSN is runtime config: it
can change without a rebuild. The build writes browser source maps, which
the module stamps with debug ids; upload them (and delete them, so they
aren't served) before you deploy `.output`:

```sh
FIXWIRE_URL=https://<fixwire api> FIXWIRE_AUTH_TOKEN=<key with artifacts:write> npm run sourcemaps
```

## Its test

`examples/frameworks/test/nuxt.test.ts` installs this app with the SDK's
packages built from this repository, type-checks it (`nuxt typecheck`),
builds it, runs it on Node.js against a fake ingest and drives it in
Chromium:

```sh
pnpm build
pnpm exec playwright install --only-shell chromium
node --test examples/frameworks/test/nuxt.test.ts
```
