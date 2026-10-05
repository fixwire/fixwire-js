# @fixwire/browser

The Fixwire SDK for browsers: errors from about 12 KB gzipped, traces opt-in.

```sh
npm install @fixwire/browser
```

```js
import * as Fixwire from "@fixwire/browser";

Fixwire.init({ dsn: "https://fw_pk_live_…@ingest.eu.fixwire.io", release: "web@1.4.0" });
```

The DSN carries the project's publishable key, which is safe in a bundle.

- **Errors:** uncaught errors and unhandled rejections (listeners, never
  `window.onerror`), with console and fetch breadcrumbs; extension noise and
  cross-origin "Script error." are dropped.
- **Traces (opt-in):** `tracesSampleRate` plus
  `integrations: [Fixwire.browserTracingIntegration()]` traces page loads,
  route changes and fetch calls, with web vitals. Same-origin requests carry
  trace headers (W3C `traceparent`) by default, and a server-rendered page's
  `<meta name="traceparent">` continues the server's trace.
- **Offline (opt-in):** `offline: makeIndexedDbSpool` from
  `@fixwire/browser/offline` keeps events in IndexedDB until they are sent;
  a closing page's last ones go out with `keepalive`.
- **Feedback:** `Fixwire.captureFeedback({ score: 1, traceId })` rates an AI
  answer (use the trace id your backend returned with it);
  `captureFeedback({ message, eventId: Fixwire.lastEventId() })` attaches
  what someone said to a crash.
- **Release health:** with `release` set, each page load is a session that
  ends exited, or crashed on an unhandled error, so each release gets
  crash-free rates. The user is sent only as a hash made in the browser;
  `autoSessionTracking: false` turns it off.
- **Privacy:** secrets and personal data are masked in the browser before
  sending.
- **Source maps:** upload them with `fixwire-cli`; the debug IDs it injects
  link each error to its bundle's maps.

For React, add `@fixwire/react`. Fully typed.
