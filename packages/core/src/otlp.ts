/**
 * OTLP/HTTP JSON, written by hand so browsers ship no OpenTelemetry
 * (fixwire-protocol §3–4): errors and messages become log records, spans
 * OTLP spans, each under a resource that names the release, environment
 * and SDK. Ids are hex; 64-bit integers travel as decimal strings.
 */
import type { Event, Exception, StackFrame } from "./types.ts";

/** An OTLP AnyValue. */
export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } }
  | Record<string, never>;

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export function anyValue(v: unknown): AnyValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number")
    return Number.isSafeInteger(v)
      ? { intValue: String(v) }
      : Number.isFinite(v)
        ? { doubleValue: v }
        : { stringValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  if (v && typeof v === "object") return { kvlistValue: { values: keyValues(v) } };
  return v == null ? {} : { stringValue: String(v) };
}

/** OTLP attributes of a plain object; null and undefined values are left out. */
export const keyValues = (o: object): KeyValue[] =>
  Object.entries(o)
    .filter((kv) => kv[1] != null)
    .map(([key, v]) => ({ key, value: anyValue(v) }));

/** Unix seconds as OTLP's nanoseconds (microsecond precision, exact in a double). */
export const nanos = (seconds: number): string => `${Math.round(seconds * 1e6)}000`;

/** The resource attributes of a request: who sends, and for which release. */
export interface ResourceInfo {
  serviceName?: string;
  release?: string;
  environment?: string;
  host?: string;
  sdkName: string;
  sdkVersion: string;
  language: string;
}

export const resource = (r: ResourceInfo): { attributes: KeyValue[] } => ({
  attributes: keyValues({
    "service.name": r.serviceName,
    "service.version": r.release,
    "deployment.environment.name": r.environment,
    "host.name": r.host,
    "telemetry.sdk.name": r.sdkName,
    "telemetry.sdk.version": r.sdkVersion,
    "telemetry.sdk.language": r.language,
  }),
});

/** An ExportLogsServiceRequest of one resource's records. */
export const logsRequest = (res: ResourceInfo, records: object[]): string =>
  JSON.stringify({
    resourceLogs: [{ resource: resource(res), scopeLogs: [{ logRecords: records }] }],
  });

/** An ExportTraceServiceRequest of one resource's spans. */
export const tracesRequest = (res: ResourceInfo, spans: object[]): string =>
  JSON.stringify({ resourceSpans: [{ resource: resource(res), scopeSpans: [{ spans }] }] });

/** OpenTelemetry severity numbers of the event levels. */
const SEVERITY: Record<string, number> = {
  fatal: 21,
  error: 17,
  warning: 13,
  log: 9,
  info: 9,
  debug: 5,
};

const frame = (f: StackFrame) => ({
  function: f.function,
  module: f.module,
  file: f.filename,
  abs_path: f.abs_path,
  line: f.lineno,
  column: f.colno,
  in_app: f.in_app,
  context_line: f.context_line,
  pre_context: f.pre_context,
  post_context: f.post_context,
});

const exception = (x: Exception) => ({
  type: x.type,
  message: x.value,
  mechanism: x.mechanism,
  frames: x.stacktrace?.frames?.map(frame),
});

/**
 * An error or message as a log record (fixwire-protocol §4). The event's
 * exceptions run cause first; `fixwire.exceptions` runs outermost first.
 */
export function eventRecord(e: Event): Record<string, unknown> {
  const values = e.exception?.values ?? [];
  const outer = values[values.length - 1];
  const { trace, fixwire, ...contexts } = e.contexts ?? {};
  const a: Record<string, unknown> = { ...e.extra };
  const user = { ...e.user };
  for (const [k, to] of [
    ["id", "user.id"],
    ["email", "user.email"],
    ["username", "user.name"],
    ["ip_address", "client.address"],
  ] as const) {
    if (user[k] != null) a[to] = String(user[k]);
    delete user[k];
  }
  for (const [k, v] of Object.entries(user)) a[`user.${k}`] = v;
  const req = e.request;
  if (req) {
    a["http.request.method"] = req.method;
    a["url.full"] = req.url;
    a["url.query"] = req.query_string;
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const name = k.toLowerCase();
      a[name === "user-agent" ? "user_agent.original" : `http.request.header.${name}`] = v;
    }
  }
  if (outer) {
    a["exception.type"] = outer.type;
    a["exception.message"] = outer.value;
    a["fixwire.exceptions"] = values.map(exception).reverse();
    if (values.some((v) => v.mechanism?.handled === false)) a["fixwire.handled"] = false;
  }
  Object.assign(a, {
    "fixwire.event_id": e.event_id,
    "fixwire.fingerprint": e.fingerprint,
    "fixwire.tags": e.tags,
    "fixwire.contexts": Object.keys(contexts).length ? contexts : undefined,
    "fixwire.breadcrumbs": e.breadcrumbs,
    "fixwire.debug_images": e.debug_meta?.images,
    "fixwire.suppressed": (fixwire?.suppressed as { count?: number } | undefined)?.count,
    "fixwire.transaction": e.transaction,
  });
  const body = e.message ?? e.logentry?.formatted ?? e.logentry?.message;
  const record: Record<string, unknown> = {
    timeUnixNano: nanos(e.timestamp ?? Date.now() / 1000),
    severityNumber: SEVERITY[e.level ?? "error"] ?? 17,
    eventName: outer ? "exception" : "fixwire.message",
    attributes: keyValues(a),
  };
  if (body !== undefined || !outer) record.body = { stringValue: body ?? "" };
  if (typeof trace?.trace_id === "string") {
    record.traceId = trace.trace_id;
    if (typeof trace.span_id === "string") record.spanId = trace.span_id;
  }
  return record;
}
