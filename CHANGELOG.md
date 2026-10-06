# Changelog

All notable changes to the Fixwire JavaScript SDKs are listed here. Versions follow [Semantic
Versioning](https://semver.org); before 1.0, a minor version may change the
API.

## [0.1.0] - 2026-10-06

First release.

- `@fixwire/node`: errors, traces with OpenTelemetry, AI agent runs, request sessions, cron monitors and feedback for Node.js.
- `@fixwire/browser`: errors, breadcrumbs and traces in the browser, within a size budget.
- `@fixwire/edge`: Cloudflare Workers, Vercel Edge, Deno and Netlify Edge Functions.
- `@fixwire/react`: error boundaries and React's root error handlers.
- `@fixwire/core`: the client, scopes, on-device redaction with the server's rules, error budgets and delivery shared by all of them.
- Examples run against a fake ingest in CI: an Express API, a worker, a Vite app and a support agent.
