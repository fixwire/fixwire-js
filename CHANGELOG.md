# Changelog

All notable changes to the Fixwire JavaScript SDKs are listed here. Versions follow [Semantic
Versioning](https://semver.org); before 1.0, a minor version may change the
API.

## [Unreleased]

- `@fixwire/core`: error budgets' message templates, the JWT detector and overlapping findings in redaction take linear time; hostile messages, keys, feedback or span attributes stalled the app for seconds to minutes.
- `@fixwire/core`: a server's `Retry-After` (seconds or an HTTP date) or `Fixwire-Rate-Limits` pause is capped at a day (a huge one spun a timer in a loop); broken values and unknown categories are ignored.
- `@fixwire/core`: `captureException` never throws, whatever was thrown; serializing caps the objects it walks (shared references), lists only the kept bytes of typed arrays and Buffers, and describes an object that throws as `[Unreadable]`.
- `@fixwire/core`: the message at the top of a V8 stack is no longer parsed as frames.
- `@fixwire/core`: a caller's `tracestate` over 512 bytes or `baggage` over 8,192 bytes, or either with a control character but tab, is not passed on; a `traceparent` with more than spaces or tabs around it is ignored; by default in browsers, `/\host` URLs get no trace headers.
- `@fixwire/core`: request sessions count up to 5,000 users per send, more without their user, and a sessions request holds 5,000 aggregates at most.
- `@fixwire/core`: tool calls serialize and hash their arguments only when their span is sent; streamed AI answers are buffered only when content is recorded, and only as much as is recorded.
- `@fixwire/core`: an invalid DSN's error no longer repeats the DSN.
- `@fixwire/node`: context lines are read only from regular files up to 10 MB, through a cache of 64 files and 32 MB; a faked frame path (a device, a FIFO, `/proc`) is never opened.
- `@fixwire/node`: context lines are read only from source files (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`); a faked stack naming `/etc/passwd` or a `.txt` file gets none.
- `@fixwire/node`: an unhandled rejection crashes the process again as Node.js would (`--unhandled-rejections=throw`, the default, or `strict`): reported once, flushed within 2 s, then handed back to Node.js, which prints it and exits with code 1 (or calls the app's `uncaughtException` handlers). The SDK's listener had turned the crash off.
- `@fixwire/node`: `warn-with-error-code` sets exit code 1 again, and `strict` warns when the app's `uncaughtException` handler takes the rejection, as without the SDK; the mode is read from the command line and `NODE_OPTIONS`.
- `@fixwire/node`: the offline spool's directories are 0700 and its files 0600, the default directory under the shared temp directory is used only when it is the user's own, a stored request whose path isn't one is dropped, and writing a request no longer reads the whole directory.
- `@fixwire/node`: deliveries time out after 10 s in all, not only after 10 s of silence.
- `@fixwire/node`: an integration that fails (e.g. a `tracePropagationTargets` entry that throws) no longer crashes the app from a `diagnostics_channel` subscriber.
- `@fixwire/browser`: the gecko stack parser no longer backtracks cubically on long lines; the page URL drops its fragment as well as its query; breadcrumbs never break `fetch` calls, and a logged object is serialized only as far as the console message keeps.
- `@fixwire/browser`, `@fixwire/edge`: a traced `fetch` call the SDK can't read goes out unchanged.
- `@fixwire/edge`: deliveries follow no redirect and time out after 10 s.
- `@fixwire/core`: strings are cut to `maxValueLength` bytes of UTF-8 (default 1,024), on a character boundary, the `...` within the limit, after redaction, which reads the part kept and the next 16 kB (a private key or JWT the cut goes through is masked whole); map keys, span names and attributes, and feedback too. Recorded AI content gets 16 kB. Release, environment, service name and monitor slugs are cut but not redacted.
- `@fixwire/core`: `secret_assignment` masks names that end a longer one (`access_token`, `client_secret`, `csrfToken`, `PHPSESSID`, `X-Amz-Signature`), secret and private keys, credentials, session ids, signatures and an OAuth `code` in a query, as the server does, in linear time; keys that mask alike are numbered in linear time; text redaction fails on is sent as `[Filtered]`.
- `@fixwire/core`: a request is sent at most 4 times (about 1 s, 2 s and 4 s apart, a 429's pause included) and dropped when its next try is more than 5 minutes away; a 429 without `Fixwire-Rate-Limits` pauses all data for `Retry-After`, a minute at least, a 5xx with `Retry-After` for that long.
- `@fixwire/core`: new `maxQueue` (default 100): requests waiting to be sent, captures waiting to be encoded, and as many waiting for a retry; past it, new data is dropped (64 requests were kept, dropping the oldest).
- `@fixwire/core`: an error over 1 MB of JSON leaves out its breadcrumbs, then its contexts, then is dropped; spans go 100 to a request of at most 5 MB, one that can't fit dropped alone.
- `@fixwire/core`: new `maxStackFrames` (default 100, the newest kept; 50 were); a chain keeps 10 exceptions at most, `AggregateError`s included; a span keeps 128 attributes; adding a breadcrumb takes constant time; the duplicate budget reads a message's first 1,024 characters.
- `@fixwire/core`: `tracePropagationTargets` match by host (a string is that host and its subdomains, with its port if it has one), URL prefix (a string with `://`), the page's own paths (a string starting with `/`) or a RegExp searched for in the URL, each without user info, query and fragment; strings matched anywhere in the URL before.
- `@fixwire/core`: `init()` and `new Client()` never throw: a broken DSN or option is a warning and leaves the SDK off; an integration that fails to set up is skipped.
- `@fixwire/core`: what is logged from `beforeSend` or `beforeBreadcrumb`, and the SDK's own debug lines, are not breadcrumbs (a logging callback recursed).
- `@fixwire/core`: `argumentsHash` writes the Python SDK's canonical JSON: strings cut at 16 kB of UTF-8, keys in code point order, small numbers with Python's exponent.
- `@fixwire/node`: at most 64 kB of an answer is read; context lines are sent whole, cut after redaction.
- `@fixwire/browser`: deliveries follow no redirect; a console breadcrumb keeps what redaction reads of a message.

## [0.1.0] - 2026-10-06

First release.

- `@fixwire/node`: errors, traces with OpenTelemetry, AI agent runs, request sessions, cron monitors and feedback for Node.js.
- `@fixwire/browser`: errors, breadcrumbs and traces in the browser, within a size budget.
- `@fixwire/edge`: Cloudflare Workers, Vercel Edge, Deno and Netlify Edge Functions.
- `@fixwire/react`: error boundaries and React's root error handlers.
- `@fixwire/core`: the client, scopes, on-device redaction with the server's rules, error budgets and delivery shared by all of them.
- Examples run against a fake ingest in CI: an Express API, a worker, a Vite app and a support agent.
