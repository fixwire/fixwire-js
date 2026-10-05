/**
 * Apps that already run OpenTelemetry keep it: Fixwire never installs a
 * tracer provider, propagator or context manager. Two helpers link the two:
 *
 *   import * as otel from "@opentelemetry/api";
 *   Fixwire.init({ dsn, integrations: [Fixwire.openTelemetryIntegration(otel)] });
 *
 * puts the active OpenTelemetry span's trace on Fixwire's errors (when no
 * Fixwire span is active), and
 *
 *   new OTLPTraceExporter(Fixwire.otlpExporterOptions(dsn).traces)
 *
 * sends the app's own spans to Fixwire's OTLP endpoint.
 */
import type { Integration } from "./client.ts";
import { parseDsn } from "./dsn.ts";
import { getGlobalScope } from "./scope.ts";
import { getActiveSpan } from "./tracing.ts";

/** The part of `@opentelemetry/api` the integration reads: pass the module. */
export interface OpenTelemetryApi {
  trace: {
    getActiveSpan():
      | { spanContext(): { traceId: string; spanId: string; traceFlags?: number } }
      | undefined;
  };
}

const INVALID_TRACE = /^0+$/;
let api: OpenTelemetryApi | undefined;
let installed = false;

/**
 * Errors captured inside an OpenTelemetry span carry its trace and span
 * IDs, so they show up on that trace. Fixwire's own spans, when active,
 * take precedence.
 */
export const openTelemetryIntegration = (otel: OpenTelemetryApi): Integration => ({
  name: "OpenTelemetry",
  setup: () => {
    api = otel; // the latest init's module
    if (installed) return;
    installed = true;
    getGlobalScope().addEventProcessor((event) => {
      if (getActiveSpan()) return event;
      const ctx = api?.trace.getActiveSpan()?.spanContext();
      if (!ctx?.traceId || INVALID_TRACE.test(ctx.traceId)) return event;
      event.contexts = { ...event.contexts, trace: { trace_id: ctx.traceId, span_id: ctx.spanId } };
      return event;
    });
  },
});

/** Where an OTLP exporter sends a signal, and its auth header. */
export interface OtlpTarget {
  url: string;
  headers: Record<string, string>;
}

/**
 * OTLP/HTTP exporter options for a DSN: traces and logs on the DSN's base
 * URL (sdks/PROTOCOL.md §3–4), with the key as a bearer token.
 */
export function otlpExporterOptions(dsn: string): { traces: OtlpTarget; logs: OtlpTarget } {
  const d = parseDsn(dsn);
  const headers = { Authorization: `Bearer ${d.publicKey}` };
  return {
    traces: { url: `${d.baseUrl}/v1/traces`, headers },
    logs: { url: `${d.baseUrl}/v1/logs`, headers: { ...headers } },
  };
}
