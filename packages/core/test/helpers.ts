import { gunzipSync } from "node:zlib";

import { bindClient } from "../src/api.ts";
import { Client, type Platform, type TransportRequest } from "../src/client.ts";
import { nodeStackLineParser } from "../src/node-stack-trace.ts";
import { createStackParser } from "../src/stacktrace.ts";

/** A client whose transport keeps the requests it sends. */
export function fakeClient(options: ConstructorParameters<typeof Client>[0]): {
  client: Client;
  sent: TransportRequest[];
} {
  const sent: TransportRequest[] = [];
  const platform: Platform = {
    sdkName: "fixwire.javascript.test",
    language: "nodejs",
    stackParser: createStackParser(nodeStackLineParser()),
    globalPerMinute: 600,
    maxInFlight: 1,
    makeTransport: () => ({
      send: async (req) => {
        sent.push(req);
        return { status: 200, header: () => null };
      },
    }),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const client = new Client({ dsn: "http://pk@127.0.0.1:1", ...options }, platform);
  bindClient(client);
  return { client, sent };
}

// biome-ignore lint/suspicious/noExplicitAny: assertions walk the request JSON freely
export type Json = Record<string, any>;

/** An OTLP AnyValue as a plain value. */
export function plain(v: Json | undefined): unknown {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values as Json[]).map(plain);
  if ("kvlistValue" in v) return attrs(v.kvlistValue.values);
  return undefined;
}

/** OTLP attributes as a plain map. */
export const attrs = (kvs: Json[] = []): Json =>
  Object.fromEntries(kvs.map((kv) => [kv.key, plain(kv.value)]));

/** A request's path, e.g. `/v1/logs`. */
export const pathOf = (req: TransportRequest): string => new URL(req.url).pathname;

/** A request's JSON body (gunzipped when compressed). */
export const bodyOf = (req: TransportRequest): Json =>
  JSON.parse(
    typeof req.body === "string" ? req.body : gunzipSync(req.body).toString("utf8"),
  ) as Json;

/** The JSON bodies sent to `path`. */
export const bodiesOf = (sent: TransportRequest[], path: string): Json[] =>
  sent.filter((r) => pathOf(r) === path).map(bodyOf);

/** The log records sent to /v1/logs, with plain attributes, body and resource. */
export const recordsOf = (sent: TransportRequest[]): Json[] =>
  bodiesOf(sent, "/v1/logs").flatMap((b) =>
    (b.resourceLogs as Json[]).flatMap((rl) =>
      (rl.scopeLogs as Json[]).flatMap((sl) =>
        (sl.logRecords as Json[]).map((r) => ({
          ...r,
          body: plain(r.body),
          attributes: attrs(r.attributes),
          resource: attrs(rl.resource.attributes),
        })),
      ),
    ),
  );

/** The spans sent to /v1/traces, flattened, with plain attributes and resource. */
export const spansOf = (sent: TransportRequest[]): Json[] =>
  bodiesOf(sent, "/v1/traces").flatMap((b) =>
    (b.resourceSpans as Json[]).flatMap((rs) =>
      (rs.scopeSpans as Json[]).flatMap((ss) =>
        (ss.spans as Json[]).map((s) => ({
          ...s,
          attributes: attrs(s.attributes),
          resource: attrs(rs.resource.attributes),
        })),
      ),
    ),
  );

/** The outermost exception of an error record (what was thrown). */
export const thrown = (r: Json): Json => r.attributes["fixwire.exceptions"]?.[0];
