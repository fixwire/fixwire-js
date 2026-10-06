// An orders API on Express 5, instrumented with Fixwire.
//
//   FIXWIRE_DSN=https://<key>@<host> npm start
//
// No --import flag and no load order to respect: Fixwire follows requests
// with Node's own diagnostics channels, so init() can sit anywhere.

import * as Fixwire from "@fixwire/node";
import express from "express";

Fixwire.init({
  dsn: process.env.FIXWIRE_DSN, // unset: the SDK does nothing
  release: process.env.RELEASE ?? "orders-api@1.0.0",
  environment: process.env.NODE_ENV ?? "development",
  // Every request is a trace here; in production 0.1–0.2 is typical.
  tracesSampleRate: Number(process.env.TRACES_SAMPLE_RATE ?? 1),
  // Trace headers go to the inventory service only, never to third parties.
  tracePropagationTargets: [/^http:\/\/(localhost|127\.0\.0\.1):\d+\/inventory\//],
});
Fixwire.setTag("service", "orders-api");

const orders = new Map([
  [
    "ord_1",
    { id: "ord_1", items: [{ sku: "sku-1", qty: 2 }], customer: { email: "ada@example.com" } },
  ],
]);
const app = express();
app.use(express.json());

// Who is asking: set per request, so concurrent requests never mix users.
app.use((req, _res, next) => {
  Fixwire.setUser({ id: req.get("x-user-id") ?? "anonymous" });
  Fixwire.setTag("plan", req.get("x-plan") ?? "free");
  next();
});

app.get("/orders/:id", async (req, res) => {
  // A span of your own: it shows up inside the request's trace.
  const order = await Fixwire.startSpan({ name: "SELECT order", op: "db.query" }, () =>
    findOrder(req.params.id),
  );
  if (!order) return res.status(404).json({ error: "not found" }); // not an error report
  Fixwire.addBreadcrumb({ category: "orders", message: "order loaded", data: { id: order.id } });
  // A bug for orders without a shipping address: reported as unhandled,
  // with the route /orders/:id as the transaction.
  res.json({ ...order, ships_to: order.shipping.city });
});

app.post("/orders", async (req, res) => {
  const { items, email } = req.body ?? {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "items required" }); // a 400: not reported
  }
  Fixwire.addBreadcrumb({
    category: "orders",
    message: "reserving stock",
    data: { items: items.length },
  });
  await reserveStock(items); // a rejected promise reaches Express 5's error handlers
  const order = { id: `ord_${orders.size + 1}`, items, customer: { email } };
  orders.set(order.id, order);
  res.status(201).json(order);
});

app.post("/orders/:id/refund", async (req, res) => {
  try {
    await refund(req.params.id);
    res.json({ status: "refunded" });
  } catch (err) {
    // Handled: the customer gets a clear answer, Fixwire gets the event
    // with extra context, for this event only.
    Fixwire.withScope((scope) => {
      scope.setContext("refund", { order: req.params.id, provider: "acme-pay" });
      scope.setLevel("warning");
      Fixwire.captureException(err);
    });
    res.status(502).json({ error: "refund provider unavailable, retrying" });
  }
});

// The inventory service, mounted here so the example runs on its own; in
// production it's another service. The call to it is a span of this
// request, and its own request continues the same trace.
app.post("/inventory/reserve", (req, res) => {
  const missing = req.body.items.find((i) => i.sku === "sku-404");
  if (missing) return res.status(409).json({ error: `no record of ${missing.sku}` });
  res.json({ reserved: req.body.items.length });
});

async function findOrder(id) {
  await new Promise((r) => setTimeout(r, 2)); // a database round trip
  return orders.get(id);
}

async function reserveStock(items) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/inventory/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const missing = items.find((i) => i.sku === "sku-404");
    throw new Error(`stock service has no record of ${missing?.sku} for ${items.length} items`);
  }
}

async function refund(id) {
  await new Promise((r) => setTimeout(r, 5));
  throw new Error(`acme-pay refused the refund of ${id}: card 4242 4242 4242 4242 expired`);
}

// After the routes: reports 5xx errors (not 4xx), then passes them on.
Fixwire.setupExpressErrorHandler(app);
// Express knows an error handler by its four parameters, so `_next` stays.
// biome-ignore lint/correctness/noUnusedFunctionParameters: Express needs the arity
app.use((err, _req, res, _next) =>
  res.status(500).json({ error: "something broke", id: Fixwire.lastEventId() }),
);

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`listening on ${server.address().port}`);
});

// When stopped, send what is queued before exiting. SIGTERM is how containers and service
// managers stop a program, Ctrl-C sends SIGINT; on Windows, where a program gets no signals
// from another, process managers send a "shutdown" message instead (PM2's convention).
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Fixwire.close(2000);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (message) => {
  if (message === "shutdown") stop();
});
