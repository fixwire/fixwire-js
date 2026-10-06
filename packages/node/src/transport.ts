/**
 * HTTP(S) with keep-alive and a timeout; retries are the delivery's job. A
 * redirect is not followed (the key goes to the DSN's host only), and at
 * most 64 kB of an answer is read.
 */
import * as http from "node:http";
import * as https from "node:https";

import type { Transport, TransportRequest, TransportResponse } from "@fixwire/core";

/** True while the SDK creates its own request, so the HTTP integration skips it. */
export const sdkRequest = { active: false };

/** Bytes of an answer read at most. */
const MAX_ANSWER = 64 << 10;

export function makeNodeTransport(timeoutMs = 10_000): Transport {
  const agents = {
    "http:": new http.Agent({ keepAlive: true, maxSockets: 4 }),
    "https:": new https.Agent({ keepAlive: true, maxSockets: 4 }),
  };
  return {
    send(req: TransportRequest): Promise<TransportResponse> {
      const url = new URL(req.url);
      const mod = url.protocol === "https:" ? https : http;
      const body = typeof req.body === "string" ? Buffer.from(req.body) : req.body;
      return new Promise((resolve, reject) => {
        sdkRequest.active = true;
        let r: http.ClientRequest;
        try {
          r = mod.request(
            url,
            {
              method: "POST",
              headers: { ...req.headers, "Content-Length": String(body.byteLength) },
              agent: agents[url.protocol as "http:" | "https:"],
              timeout: timeoutMs,
            },
            (res) => {
              const answer = (): void =>
                resolve({
                  status: res.statusCode ?? 0,
                  header: (name) => {
                    const v = res.headers[name.toLowerCase()];
                    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
                  },
                });
              // The body is drained, but no more than MAX_ANSWER of it is read:
              // past that the connection goes.
              let read = 0;
              res.on("data", (chunk: Buffer) => {
                read += chunk.length;
                if (read > MAX_ANSWER) {
                  res.destroy();
                  answer();
                }
              });
              res.on("end", answer);
              res.on("close", answer); // cut off midway: the status is in
            },
          );
        } finally {
          sdkRequest.active = false;
        }
        // The socket timeout only notices silence: a server that trickles
        // its answer is cut off by this deadline instead.
        const deadline = setTimeout(() => r.destroy(new Error("timeout")), timeoutMs).unref();
        r.on("close", () => clearTimeout(deadline));
        r.on("timeout", () => r.destroy(new Error("timeout")));
        r.on("error", reject);
        r.end(body);
      });
    },
  };
}
