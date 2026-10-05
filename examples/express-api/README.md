# Express orders API

```sh
pnpm install                                   # at the repository root
FIXWIRE_DSN=https://<key>@<host> pnpm --filter example-express-api start
```

Outside this repo, depend on `@fixwire/node` from npm and run `node server.mjs`.

```sh
curl -s localhost:3000/orders/ord_1 -H 'x-user-id: u-42'          # TypeError: reported, transaction /orders/:id
curl -s localhost:3000/orders/nope                                 # 404: not reported
curl -s -XPOST localhost:3000/orders -H 'content-type: application/json' -d '{"items":[]}'   # 400: not reported
curl -s -XPOST localhost:3000/orders -H 'content-type: application/json' -d '{"items":[{"sku":"sku-404"}]}'  # async error: reported
curl -s -XPOST localhost:3000/orders/ord_1/refund                  # handled: a warning, card number masked
```

| Code | What you get in Fixwire |
|---|---|
| `Fixwire.init()` anywhere | Per-request isolation through Node's diagnostics channels: no `--import`, no load order |
| user middleware | `setUser`/`setTag` per request; concurrent requests never mix |
| `setupExpressErrorHandler(app)` | 5xx errors (sync and async) with the request (allowlisted headers) and the route |
| `withScope()` around a handled error | Context and a level for one event only |
| `tracesSampleRate` | A trace per request, named after its route (`GET /orders/:id`), with its status code |
| `startSpan()` around the lookup | A `db.query` span inside the request's trace |
| `fetch()` to `/inventory/reserve` | A child span, trace headers (only to `tracePropagationTargets`), and the inventory request continuing the same trace |
| `Fixwire.close()` on SIGTERM | Queued events are sent before the process exits |
