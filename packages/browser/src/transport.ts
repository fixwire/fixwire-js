/**
 * fetch, with the key in the Authorization header. While the page is
 * hidden (it may be closing), a small body goes as a keepalive request
 * the browser can send without a CORS preflight, so it survives the
 * unload: the key in the query (sdks/PROTOCOL.md §2) and JSON as
 * text/plain. Browsers cap keepalive bodies at 64 KB in flight.
 */
import type { Transport, TransportResponse } from "@fixwire/core";

const KEEPALIVE_LIMIT = 60_000;

export function makeFetchTransport(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Transport {
  let keepaliveBytes = 0;
  return {
    async send(req): Promise<TransportResponse> {
      let { url, headers } = req;
      const size = typeof req.body === "string" ? req.body.length : req.body.byteLength;
      const hidden =
        (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState ===
        "hidden";
      const keepalive = hidden && keepaliveBytes + size <= KEEPALIVE_LIMIT;
      if (keepalive) {
        keepaliveBytes += size;
        const { Authorization: auth = "", ...rest } = headers;
        headers = rest;
        if (headers["Content-Type"] === "application/json")
          headers["Content-Type"] = "text/plain;charset=UTF-8";
        url += `${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(auth.slice(7))}`;
      }
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          body: req.body as BodyInit,
          headers,
          keepalive,
          referrerPolicy: "strict-origin",
          credentials: "omit",
          // The key is for the ingest: a redirect isn't followed (it's dropped).
          redirect: "manual",
        });
        return { status: res.status, header: (name) => res.headers.get(name) };
      } finally {
        if (keepalive) keepaliveBytes -= size;
      }
    },
  };
}
