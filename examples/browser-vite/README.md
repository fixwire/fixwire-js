# Browser (Vite)

```sh
pnpm install                                            # at the repository root
FIXWIRE_DSN=https://<key>@<host> pnpm --filter example-browser-vite dev
```

Open the page and press the buttons:

| Button | What you get in Fixwire |
|---|---|
| Add to cart | A `TypeError` from the global handlers (`addEventListener`, never `window.onerror`) |
| Checkout | An unhandled rejection; the email in the message is masked in the browser |
| Apply coupon | A handled warning with the coupon as context |
| Load recommendations | A message with the failed `fetch` as a breadcrumb, and a failed child span in the page-load trace |

With `browserTracingIntegration()`, the page load is a trace (ended when the
page goes idle, or when it's left), with web vitals; each route change
starts a new one. Same-origin `fetch` calls carry trace headers, so your API's
traces join the page's. A server-rendered page continues the server's trace
when it includes `getTraceMetaTags()` from `@fixwire/node` in its `<head>`.

**Source maps, so stacks show your code:**

```sh
FIXWIRE_DSN=… pnpm --filter example-browser-vite build   # writes dist/ with hidden maps
FIXWIRE_URL=https://<fixwire api> FIXWIRE_AUTH_TOKEN=<key with artifacts:write> \
  pnpm --filter example-browser-vite sourcemaps          # fixwire-cli: inject debug ids, then upload
```

Deploy `dist/` after the upload (the debug ids are now part of the files),
without the `.map` files. Errors from that build arrive with original file
names, functions, lines and source.

The SDK adds about 16 KB gzipped to the page, 19 KB with tracing. The
offline store is a separate import (`offline: makeIndexedDbSpool` from
`@fixwire/browser/offline`, 0.5 KB more): events captured on a dropped
connection are kept in IndexedDB and sent when the browser is back online.
