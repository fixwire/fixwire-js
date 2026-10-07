# Fixwire with Next.js

A [Next.js](https://nextjs.org) 16 app made with `create-next-app` (App
Router, TypeScript), set up with
[`@fixwire/nextjs`](../../../packages/nextjs). Its pages fail on purpose:

| Where | What fails | What Fixwire gets |
|---|---|---|
| `/users/crash` | A server component throws while rendering | The error from `onRequestError`, named `/users/[id]`, with the request and the `user.id` tag; the error page doesn't send it again |
| `/api/orders/7` | A route handler throws | The error, named `/api/orders/[id]` |
| `/`, **Check out** | A click handler throws | The error from the browser, with debug ids for the source maps and the navigations before it as breadcrumbs |
| `/`, **Empty the cart** | A client component fails to render | The error from `app/error.tsx` |

The Fixwire parts are `instrumentation.ts`, `instrumentation-client.ts`,
`app/error.tsx`, `app/global-error.tsx` and `next.config.ts`.

## Run it

```sh
npm install
echo "NEXT_PUBLIC_FIXWIRE_DSN=https://<publishable key>@ingest.eu.fixwire.io" > .env.local
npm run build
npm start
```

Open http://localhost:3000 and click around. To see your code in the
browser's stack traces, upload the source maps after the build:

```sh
FIXWIRE_URL=https://<fixwire api> FIXWIRE_AUTH_TOKEN=<key with artifacts:write> npm run sourcemaps
```

## Its test

`examples/frameworks/test/nextjs.test.ts` installs this app with the SDK's
packages built from this repository, builds it for production, starts it
against a fake ingest and drives it in Chromium:

```sh
pnpm build
pnpm exec playwright install --only-shell chromium
node --test examples/frameworks/test/nextjs.test.ts
```
