# Fixwire with Angular

An [Angular](https://angular.dev) 22 app made with `ng new` (zoneless,
standalone, routing), set up with
[`@fixwire/angular`](../../../packages/angular): `Fixwire.init()` in
`src/main.ts` and `provideFixwire()` in `src/app/app.config.ts`. Its pages
fail on purpose:

| Where | What fails | What Fixwire gets |
|---|---|---|
| `/`, **Check out** | A click handler throws | The error, from Angular's ErrorHandler, named `/`, with debug ids for the source maps |
| `/`, **Load order 7** | An HttpClient request gets a 503 nobody handles | The error, once, as `HttpErrorResponse` with the status and URL, without the body |
| `/`, **Empty the cart** | A component in a `@boundary` block fails to render | The error, as handled, naming the component (`app-cart-summary`); the block shows its `@error` view |
| **Reports** | A route guard throws | The failed navigation, once |

Page loads and navigations are traced and named after their routes
(`/users/:id`).

## Run it

```sh
npm install
npx ng build --define 'FIXWIRE_DSN="https://<publishable key>@ingest.eu.fixwire.io"'
npx serve --single dist/angular/browser -l 4200
```

Open http://localhost:4200 and click around (any static server that sends
`index.html` for unknown paths works). The build writes hidden source maps;
stamp and upload them (and delete them, so they aren't served) before you
deploy `dist/angular/browser`:

```sh
FIXWIRE_URL=https://<fixwire api> FIXWIRE_AUTH_TOKEN=<key with artifacts:write> npm run sourcemaps
```

## Its test

`examples/frameworks/test/angular.test.ts` installs this app with the
SDK's packages built from this repository, builds it for production (which
type-checks it), serves it with a test API that fails, and drives it in
Chromium against a fake ingest:

```sh
pnpm build
pnpm exec playwright install --only-shell chromium
node --test examples/frameworks/test/angular.test.ts
```
