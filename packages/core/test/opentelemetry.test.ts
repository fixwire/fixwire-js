import assert from "node:assert/strict";
import { test } from "node:test";

import { captureException } from "../src/api.ts";
import { openTelemetryIntegration, otlpExporterOptions } from "../src/opentelemetry.ts";
import { startSpan } from "../src/tracing.ts";
import { fakeClient, recordsOf, thrown } from "./helpers.ts";

/** Shaped like @opentelemetry/api: the active span is whatever the app set. */
let active: { traceId: string; spanId: string } | undefined;
const otel = {
  trace: {
    getActiveSpan: () =>
      active ? { spanContext: () => ({ ...active, traceFlags: 1 }) } : undefined,
  },
};

test("errors inside the app's OpenTelemetry spans carry their trace; Fixwire spans win", async () => {
  const { client, sent } = fakeClient({ tracesSampleRate: 1 });
  openTelemetryIntegration(otel).setup(client); // init() does this for its integrations
  active = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
  captureException(new Error("inside an OTel span"));
  let fixwireTrace = "";
  startSpan({ name: "job", op: "task" }, (span) => {
    fixwireTrace = span.traceId;
    captureException(new Error("inside a Fixwire span"));
  });
  active = { traceId: "00000000000000000000000000000000", spanId: "0000000000000000" };
  captureException(new Error("an invalid OTel context"));
  active = undefined;
  await client.flush();
  const byMessage = Object.fromEntries(
    recordsOf(sent).map((r) => [thrown(r).message, { traceId: r.traceId, spanId: r.spanId }]),
  );
  assert.deepEqual(byMessage["inside an OTel span"], {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
  });
  assert.equal(byMessage["inside a Fixwire span"].traceId, fixwireTrace);
  assert.notEqual(byMessage["an invalid OTel context"].traceId, "00000000000000000000000000000000");
});

test("OTLP exporter options point at the DSN's base URL, with its key", () => {
  const o = otlpExporterOptions("https://fw_pk_live_abc@ingest.eu.fixwire.io");
  assert.equal(o.traces.url, "https://ingest.eu.fixwire.io/v1/traces");
  assert.equal(o.logs.url, "https://ingest.eu.fixwire.io/v1/logs");
  assert.deepEqual(o.traces.headers, { Authorization: "Bearer fw_pk_live_abc" });
  assert.deepEqual(o.logs.headers, { Authorization: "Bearer fw_pk_live_abc" });
  assert.equal(
    otlpExporterOptions("http://k@localhost:8082/fixwire").traces.url,
    "http://localhost:8082/fixwire/v1/traces",
  );
});
