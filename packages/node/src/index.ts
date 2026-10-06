/**
 * Fixwire SDK for Node.js.
 *
 *   import * as Fixwire from '@fixwire/node';
 *   Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: 'api@1.4.0' });
 */
import { hostname } from "node:os";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import {
  bindClient,
  Client,
  type ClientOptions,
  createStackParser,
  nodeStackLineParser,
  type Platform,
  resolveIntegrations,
} from "@fixwire/core";
import { useAsyncLocalStorage } from "./context.ts";
import { addContextLines } from "./context-lines.ts";
import { defaultIntegrations } from "./integrations.ts";
import { makeFileSpool } from "./spool.ts";
import { makeNodeTransport } from "./transport.ts";

export * from "@fixwire/core";
export {
  defaultIntegrations,
  type ExpressErrorHandler,
  expressErrorHandler,
  httpServerIntegration,
  onUncaughtExceptionIntegration,
  onUnhandledRejectionIntegration,
  requestInfo,
  safeHeaders,
  setupExpressErrorHandler,
} from "./integrations.ts";
export {
  captureRequestError,
  type NextErrorContext,
  type NextRequestInfo,
} from "./nextjs.ts";
export { type WrapHandlerOptions, wrapHandler } from "./serverless.ts";
export { makeFileSpool } from "./spool.ts";
export { fetchIntegration, httpClientIntegration } from "./tracing.ts";

const gzipAsync = promisify(gzip);

/** Options of the Node SDK's `init()`. */
export interface NodeOptions extends ClientOptions {
  /** Read FIXWIRE_DSN, FIXWIRE_RELEASE and FIXWIRE_ENVIRONMENT for unset options (default true). */
  useEnvironment?: boolean;
}

const env = (name: string): string | undefined => process.env[`FIXWIRE_${name}`] || undefined;

/** What the Node runtime provides to a Client (for `new Client(options, nodePlatform())`). */
export const nodePlatform = (): Platform => ({
  sdkName: "fixwire.javascript.node",
  language: "nodejs",
  serviceName: process.env.OTEL_SERVICE_NAME || undefined,
  stackParser: createStackParser(nodeStackLineParser()),
  globalPerMinute: 600,
  maxInFlight: 4,
  makeTransport: () => makeNodeTransport(),
  enrich: addContextLines,
  compress: async (body) => ({
    body: await gzipAsync(body),
    headers: { "Content-Encoding": "gzip" },
  }),
  defaults: (event) => {
    event.contexts = { ...event.contexts, runtime: { name: "node", version: process.version } };
  },
  makeSpool: makeFileSpool,
  setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
});

/**
 * Starts the SDK: creates the client, binds it for the top-level functions
 * and installs the integrations (uncaught exceptions, unhandled rejections,
 * a scope per HTTP request). Without a DSN, captures are no-ops.
 *
 * @example
 * import * as Fixwire from "@fixwire/node";
 * Fixwire.init({ dsn: process.env.FIXWIRE_DSN, release: "api@1.4.0" });
 */
export function init(options: NodeOptions = {}): Client {
  const o: NodeOptions = { ...options };
  if (o.useEnvironment !== false) {
    o.dsn ??= env("DSN");
    o.release ??= env("RELEASE");
    o.environment ??= env("ENVIRONMENT");
  }
  o.serverName ??= hostname();
  useAsyncLocalStorage();
  const client = new Client(o, nodePlatform());
  bindClient(client);
  const defaults = o.defaultIntegrations === false ? [] : defaultIntegrations();
  for (const i of resolveIntegrations(defaults, o.integrations)) {
    try {
      i.setup(client);
    } catch (e) {
      console.warn(`[fixwire] integration ${i?.name} failed:`, e);
    }
  }
  return client;
}
