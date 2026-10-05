# @fixwire/edge

The Fixwire SDK for edge runtimes: Cloudflare Workers, Vercel Edge Functions
and Next.js middleware, Deno Deploy and Netlify Edge Functions.

```sh
npm install @fixwire/edge
```

## Cloudflare Workers

```js
import { AsyncLocalStorage } from "node:async_hooks";
import * as Fixwire from "@fixwire/edge";

export default Fixwire.withFixwire(
  (env) => ({ dsn: env.FIXWIRE_DSN, tracesSampleRate: 0.2, asyncLocalStorage: AsyncLocalStorage }),
  {
    async fetch(request, env, ctx) {
      return new Response("ok");
    },
  },
);
```

Set `FIXWIRE_DSN` to your project's DSN (`https://fw_pk_live_…@ingest.eu.fixwire.io`)
and enable `nodejs_compat` in `wrangler.toml` for `node:async_hooks`. Fetch
handlers, cron triggers (`scheduled`) and queue consumers (`queue`) are
wrapped. Other handlers pass through.

## Vercel Edge, Next.js middleware, Deno, Netlify

```js
import { waitUntil } from "@vercel/functions";
import * as Fixwire from "@fixwire/edge";

Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "web@1.4.0" });

export const GET = Fixwire.wrapRequestHandler(async (request) => Response.json(await load()), {
  waitUntil,
});
```

In Next.js middleware, pass `event.waitUntil`; on Netlify, `context.waitUntil`.
Without `waitUntil` the handler waits for delivery before returning.

## What you get

- **Errors:** an error a handler throws is reported, then thrown on.
- **Per request:** `setUser`, `setTag` and breadcrumbs stay with the request
  that set them, through the runtime's `AsyncLocalStorage`. It's found on
  its own on Vercel Edge; pass it on Cloudflare, as above.
- **Traces:** each request continues the caller's trace (W3C `traceparent`
  and `tracestate`) and is a segment. `fetch` calls become child spans, and
  `tracePropagationTargets` decides which hosts receive trace headers.
- **Delivery:** errors and spans travel as OpenTelemetry (OTLP/HTTP JSON),
  gzipped and sent through the runtime's `waitUntil`, after the response, so
  the isolate isn't stopped first.
- **Release health:** with `release` set, each request, cron trigger and
  queue batch is a session (exited, errored or crashed), sent with the
  other events. Users are sent only as hashes; `autoSessionTracking: false`
  turns it off.
- **Privacy:** secrets and personal data are masked before sending; request
  headers come from an allowlist, never cookies or authorization.
- **AI agents:** `Fixwire.ai.agent`, `ai.chat` and `ai.tool`, and
  `Fixwire.wrapAnthropic` or `wrapOpenAI` for automatic model-call spans.

Fully typed: every option and function is documented in your editor.
