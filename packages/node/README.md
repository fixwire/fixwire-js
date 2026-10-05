# @fixwire/node

The Fixwire SDK for Node.js: errors, traces and AI agent runs.

```sh
npm install @fixwire/node
```

```js
import * as Fixwire from "@fixwire/node";

Fixwire.init({
  dsn: process.env.FIXWIRE_DSN,        // https://fw_pk_live_…@ingest.eu.fixwire.io; unset: the SDK does nothing
  release: "api@1.4.0",
  tracesSampleRate: 0.2,               // optional: a trace per request
});
```

`FIXWIRE_DSN`, `FIXWIRE_RELEASE` and `FIXWIRE_ENVIRONMENT` fill options you
leave unset; `OTEL_SERVICE_NAME` names the service. Errors, messages and
spans travel as OpenTelemetry (OTLP/HTTP JSON), so the same endpoint takes
your OpenTelemetry SDK's data too (`Fixwire.otlpExporterOptions(dsn)`).

`init()` can sit anywhere: requests are followed through Node's diagnostics
channels, with no `--import` flag and no load order.

- **Errors:** uncaught exceptions and unhandled rejections; for Express, add
  `Fixwire.setupExpressErrorHandler(app)` after your routes (5xx only).
- **Per request:** `setUser`, `setTag` and breadcrumbs stay with the request
  that set them.
- **Traces:** each request is a segment named after its route; `http`, `https`
  and `fetch` calls become child spans, and `tracePropagationTargets` decides
  which hosts receive trace headers (W3C `traceparent` and `tracestate`;
  `baggage` passes through). `startSpan()` adds your own; for a
  server-rendered page, `getTraceMetaTags()` hands the trace to the browser.
- **AI agents:** `Fixwire.ai.agent`, `ai.chat` and `ai.tool`, and
  `Fixwire.wrapAnthropic(client)` for automatic model-call spans.
- **Feedback:** `Fixwire.captureFeedback({ score: -1, traceId, message })`
  rates an agent's answer (a thumbs down opens a `user_feedback` issue);
  with `eventId` it attaches what someone said to a crash.
- **Cron jobs:** `Fixwire.captureCheckIn({ monitorSlug, status })` reports a
  run to its monitor (`in_progress`, then `ok` or `error` with the returned
  id).
- **Next.js:** `export const onRequestError = Fixwire.captureRequestError` in
  `instrumentation.ts`.
- **Release health:** with `release` set, each request (and each
  `wrapHandler` invocation) is a session: exited, errored or crashed,
  counted per minute and sent about every minute. Users are sent only as
  hashes made on this machine; `autoSessionTracking: false` turns it off.
- **Privacy:** secrets and personal data are masked on this machine before
  sending; request headers come from an allowlist.
- **Offline:** `offline: true` keeps requests on disk until they are sent.

Fully typed: every option and function is documented in your editor.
