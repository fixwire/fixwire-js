# Changelog

All notable changes to the Fixwire JavaScript SDKs are listed here. Versions follow [Semantic
Versioning](https://semver.org); before 1.0, a minor version may change the
API.

## [Unreleased]

- `@fixwire/core`: error budgets' message templates, the JWT detector and overlapping findings in redaction take linear time; hostile messages, keys, feedback or span attributes stalled the app for seconds to minutes.
- `@fixwire/core`: a server's `Retry-After` or `Fixwire-Rate-Limits` pause is capped at an hour (a huge one spun a timer in a loop).
- `@fixwire/core`: `captureException` never throws, whatever was thrown; serializing caps the objects it walks (shared references), lists only the kept bytes of typed arrays and Buffers, and describes an object that throws as `[Unreadable]`.
- `@fixwire/core`: the message at the top of a V8 stack is no longer parsed as frames.
- `@fixwire/core`: a caller's `tracestate` or `baggage` over 8,192 characters or not printable ASCII is not passed on; by default in browsers, `/\host` URLs get no trace headers.
- `@fixwire/core`: request sessions count up to 5,000 users per send, more without their user, and at most 1,000 captures wait to be encoded.
- `@fixwire/core`: tool calls serialize and hash their arguments only when their span is sent; streamed AI answers are buffered only when content is recorded, and only as much as is recorded.
- `@fixwire/core`: an invalid DSN's error no longer repeats the DSN.
- `@fixwire/node`: context lines are read only from regular files up to 2 MB, with a 16 MB cache; a faked frame path (a device, a FIFO, `/proc`) is never opened.
- `@fixwire/node`: the offline spool's directories are 0700 and its files 0600, the default directory under the shared temp directory is used only when it is the user's own, a stored request whose path isn't one is dropped, and writing a request no longer reads the whole directory.
- `@fixwire/node`: deliveries time out after 10 s in all, not only after 10 s of silence.
- `@fixwire/node`: an integration that fails (e.g. a `tracePropagationTargets` entry that throws) no longer crashes the app from a `diagnostics_channel` subscriber.
- `@fixwire/browser`: the gecko stack parser no longer backtracks cubically on long lines; the page URL drops its fragment as well as its query; breadcrumbs never break `fetch` calls, and a logged object is serialized only as far as the console message keeps.
- `@fixwire/browser`, `@fixwire/edge`: a traced `fetch` call the SDK can't read goes out unchanged.
- `@fixwire/edge`: deliveries follow no redirect and time out after 10 s.

## [0.1.0] - 2026-10-06

First release.

- `@fixwire/node`: errors, traces with OpenTelemetry, AI agent runs, request sessions, cron monitors and feedback for Node.js.
- `@fixwire/browser`: errors, breadcrumbs and traces in the browser, within a size budget.
- `@fixwire/edge`: Cloudflare Workers, Vercel Edge, Deno and Netlify Edge Functions.
- `@fixwire/react`: error boundaries and React's root error handlers.
- `@fixwire/core`: the client, scopes, on-device redaction with the server's rules, error budgets and delivery shared by all of them.
- Examples run against a fake ingest in CI: an Express API, a worker, a Vite app and a support agent.
