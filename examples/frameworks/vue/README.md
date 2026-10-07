# Fixwire with Vue

A [Vue](https://vuejs.org) 3 app made with `create-vue` (TypeScript, Vue
Router 5, Vite), set up with [`@fixwire/vue`](../../../packages/vue) in
`src/main.ts`. Its pages fail on purpose:

| Where | What fails | What Fixwire gets |
|---|---|---|
| `/`, **Check out** | A click handler throws | The error, with its component (`HomeView`) and parents, named `/`, with debug ids for the source maps |
| `/`, **Empty the cart** | The next render throws | The error, from the render |
| `/users/crash` | The page throws while it's set up | The error, named `/users/:id` |
| **Reports** | A router guard throws | The error, from the router |

Page loads and navigations are traced and named after their routes
(`/users/:id`).

## Run it

```sh
npm install
echo "VITE_FIXWIRE_DSN=https://<publishable key>@ingest.eu.fixwire.io" > .env.local
npm run build
npm run preview
```

Open http://localhost:4173 and click around. The build writes source maps
that the files don't reference; upload them (and delete them, so they
aren't deployed) before you deploy `dist`:

```sh
FIXWIRE_URL=https://<fixwire api> FIXWIRE_AUTH_TOKEN=<key with artifacts:write> npm run sourcemaps
```

## Its test

`examples/frameworks/test/vue.test.ts` installs this app with the SDK's
packages built from this repository, builds it for production (type check
included), starts `vite preview` against a fake ingest and drives it in
Chromium:

```sh
pnpm build
pnpm exec playwright install --only-shell chromium
node --test examples/frameworks/test/vue.test.ts
```
