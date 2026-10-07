// A fake Fixwire ingest for the examples' tests: it keeps what the SDKs send
// with the key and answers like the real one, browsers' preflights included.
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";

import type { TransportRequest } from "../../packages/core/src/client.ts";
import { bodiesOf, type Json, recordsOf, spansOf } from "../../packages/core/test/helpers.ts";

export interface Ingest {
  server: Server;
  /** The DSN that sends here. */
  dsn: string;
  /** Errors and messages (OTLP log records). */
  events: () => Json[];
  /** Spans (OTLP). */
  spans: () => Json[];
  /** Release-health bodies. */
  sessions: () => Json[];
  /** Resolves once what() returns something, or rejects after timeoutMs. */
  until: <T>(what: () => T | undefined, timeoutMs?: number) => Promise<T>;
}

export async function ingest(): Promise<Ingest> {
  const got: TransportRequest[] = [];
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, content-encoding",
      "access-control-max-age": "600",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      // Only what carries the key counts (a header, or the query of a closing page).
      const url = `http://${req.headers.host}${req.url}`;
      if (req.headers.authorization === "Bearer publickey" || url.includes("key=publickey"))
        got.push({ url, headers: {}, body: String(body) });
      res.writeHead(200, cors).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    dsn: `http://publickey@127.0.0.1:${port}`,
    events: () => recordsOf(got),
    spans: () => spansOf(got),
    sessions: () => bodiesOf(got, "/v1/sessions"),
    until: async (what, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = what();
        if (found !== undefined && found !== null && found !== false) return found;
        if (Date.now() > deadline) throw new Error("the ingest never got what the test waited for");
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
