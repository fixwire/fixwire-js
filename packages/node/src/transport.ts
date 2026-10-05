/** HTTP(S) with keep-alive and a timeout; retries are the delivery's job. */
import * as http from "node:http";
import * as https from "node:https";

import type { Transport, TransportRequest, TransportResponse } from "@fixwire/core";

/** True while the SDK creates its own request, so the HTTP integration skips it. */
export const sdkRequest = { active: false };

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
              res.resume(); // drain
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  header: (name) => {
                    const v = res.headers[name.toLowerCase()];
                    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
                  },
                }),
              );
            },
          );
        } finally {
          sdkRequest.active = false;
        }
        r.on("timeout", () => r.destroy(new Error("timeout")));
        r.on("error", reject);
        r.end(body);
      });
    },
  };
}
