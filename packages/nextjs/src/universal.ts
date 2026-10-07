/**
 * The types of "@fixwire/nextjs": code such as `instrumentation.ts` or a
 * client component runs in more than one runtime, and the bundler picks the
 * runtime's own entry (index.ts on Node.js, client.ts in the browser,
 * edge.ts on the edge runtime). This describes them together: the Node.js
 * entry, what the browser adds, and an init that takes any runtime's
 * options (each reads its own).
 */
import type { BrowserOptions } from "@fixwire/browser";
import type { EdgeOptions } from "@fixwire/edge";
import type { Client, NodeOptions } from "@fixwire/node";

export {
  type BrowserOptions,
  type BrowserTracingOptions,
  breadcrumbsIntegration,
  browserTracingIntegration,
  globalHandlersIntegration,
  makeFetchTransport,
  noiseFilter,
} from "@fixwire/browser";
export type { EdgeOptions } from "@fixwire/edge";
export * from "./index.ts";

/** Options of init, in any runtime. */
export interface NextjsOptions extends BrowserOptions, NodeOptions, EdgeOptions {}

/**
 * Starts the SDK in the runtime it runs in. Unset, the DSN, release and
 * environment come from FIXWIRE_DSN, FIXWIRE_RELEASE and
 * FIXWIRE_ENVIRONMENT on the server, and from their NEXT_PUBLIC_ versions
 * everywhere.
 */
export declare function init(options?: NextjsOptions): Client;
