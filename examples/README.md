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
