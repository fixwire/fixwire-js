/** DSNs: `{scheme}://{key}@{host}[:{port}][/{path}]` (fixwire-protocol §1). */

export const SDK_VERSION = "0.1.3";

export interface Dsn {
  protocol: string;
  /** The project's publishable key. */
  publicKey: string;
  host: string;
  port: string;
  /** A prefix for self-hosted servers, e.g. `/fixwire` ("" without one). */
  path: string;
  /** The DSN without the key: every endpoint is relative to it. */
  baseUrl: string;
}

const DSN_REGEX = /^(\w+):\/\/([\w.~-]+)@([\w.-]+)(?::(\d+))?(\/[^?#]*)?$/;

export function parseDsn(value: string): Dsn {
  const m = DSN_REGEX.exec(value.trim());
  // Not echoed: the DSN holds the key, and errors end up in logs.
  if (!m) throw new Error("invalid DSN");
  const [, protocol = "", publicKey = "", host = "", port = "", rest = ""] = m;
  if (protocol !== "http" && protocol !== "https")
    throw new Error(`unsupported DSN protocol: ${protocol}`);
  const path = rest.replace(/\/+$/, "");
  const baseUrl = `${protocol}://${host}${port ? `:${port}` : ""}${path}`;
  return { protocol, publicKey, host, port, path, baseUrl };
}
