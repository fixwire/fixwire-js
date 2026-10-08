# Examples

Real apps, each with its own README. The suite in `test/` runs them against
a fake ingest and checks what Fixwire receives, so they keep working.

| Example | Shows |
|---|---|
| [express-api](express-api) | `init()` with no load-order rules, per-request users and tags, 5xx errors reported (sync and async), 4xx not, handled errors with context, a trace per request with a custom span and a traced call to another service, flushing when stopped (SIGTERM, Ctrl-C, or a process manager's message on Windows) |
| [node-worker](node-worker) | One isolation scope and one trace per job, carrying on after failures, the offline queue |
| [browser-vite](browser-vite) | Global handlers, unhandled rejections, fetch breadcrumbs, handled errors, page-load and fetch traces, the offline queue, source maps with `fixwire-cli` |
| [support-agent](support-agent) | An agent on Claude: agent runs, model calls with tokens, tool calls and their failures |

## Frameworks

Apps made with each framework's own scaffolding, set up with its Fixwire
package. Their tests (in `frameworks/test/`) install them with the
packages built from this repository, make a production build, start it
against a fake ingest and drive it in Chromium.

| Example | Made with | Shows |
|---|---|---|
| [nextjs](frameworks/nextjs) | `create-next-app` (Next.js 16, App Router) | Server render and route handler errors named after their routes, browser errors with debug ids and navigation breadcrumbs, an error page that doesn't report server errors twice, page-load and request traces |
| [vue](frameworks/vue) | `create-vue` (Vue 3, vue-router 5, Vite) | Errors from click handlers, renders, a page's setup and a router guard, with their component and route; page loads and navigations named after routes; hidden source maps with debug ids; the app's type check against the packages |
| [nuxt](frameworks/nuxt) | `create-nuxt` (Nuxt 4, minimal template) | Server render and API errors named after their routes and reported once, browser errors with their component and debug ids stamped by the module, client and server config files, no report for a 404, the app's type check |
| [sveltekit](frameworks/sveltekit) | `sv create` (SvelteKit 3, Svelte 5, adapter-node) | Server load and endpoint errors named after their routes, browser and client-load errors, no report for a 404, page loads named on the first page too, the browser continuing the server's trace, debug ids stamped by the Vite plugin, svelte-check against the packages |
