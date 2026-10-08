/**
 * The types of "@fixwire/sveltekit": the server's entry and what the
 * browser's adds, with init taking either side's options. Bundlers pick
 * the runtime's own entry (index.ts on the server, client.ts in the
 * browser), so hooks.server.ts, hooks.client.ts and components import the
 * same package.
 */
import type { BrowserOptions } from "@fixwire/browser";
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
export * from "./index.ts";

/** Options of init, on either side. */
export interface SvelteKitOptions extends BrowserOptions, NodeOptions {}

/**
 * Starts the SDK where it runs. On the server, unset DSN, release and
 * environment come from FIXWIRE_* or PUBLIC_FIXWIRE_* variables; in the
 * browser, pass them (from `$env/dynamic/public`).
 */
export declare function init(options?: SvelteKitOptions): Client;
