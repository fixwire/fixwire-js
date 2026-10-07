// The server: the SDK, Nitro's errors (API routes, server middleware, the
// renderer), and API requests named after their routes.

import { captureException, init, type NodeOptions, setRouteName } from "@fixwire/node";
import config from "#fixwire/server-config";
import { useRuntimeConfig } from "#imports";

import { type RuntimeSettings, settings } from "./shared.ts";

interface H3EventLike {
  context: { matchedRoute?: { path?: string } };
}

/** What the plugin uses of Nitro's app. */
export interface NitroAppLike {
  hooks: {
    hook(
      name: "error",
      fn: (error: unknown, context: { event?: H3EventLike; tags?: string[] }) => unknown,
    ): () => void;
    hook(name: "beforeResponse", fn: (event: H3EventLike) => unknown): () => void;
  };
}

/**
 * An API route's pattern. Page requests go through the renderer's
 * catch-all, and Nuxt's own routes (`/__nuxt_error`, which renders the error
 * page within the failed request) aren't the request's.
 */
function apiRoute(event: H3EventLike | undefined): string | undefined {
  const path = event?.context.matchedRoute?.path;
  return path && !path.includes("**") && !path.startsWith("/__nuxt") ? path : undefined;
}

/**
 * What to report of an error Nitro caught: nothing for an expected HTTP
 * error (4xx); what was thrown when h3 or Nuxt wrapped it (the error a page
 * threw was reported from the render already, and is sent once).
 */
function reportable(error: unknown): unknown {
  const e = error as { statusCode?: number; unhandled?: boolean; cause?: unknown } | null;
  if (!e || typeof e !== "object" || !("statusCode" in e)) return error;
  if (!e.unhandled && (e.statusCode ?? 500) < 500) return undefined;
  return e.cause instanceof Error ? e.cause : error;
}

export default function fixwireNitroPlugin(nitroApp: NitroAppLike): void {
  const { options } = settings<NodeOptions>(
    useRuntimeConfig().public.fixwire as RuntimeSettings | undefined,
    config,
  );
  init(options);
  nitroApp.hooks.hook("error", (error, { event }) => {
    const thrown = reportable(error);
    if (thrown === undefined) return;
    const route = apiRoute(event);
    if (route) setRouteName(route);
    captureException(thrown, { mechanism: { type: "nuxt.nitro", handled: false } });
  });
  nitroApp.hooks.hook("beforeResponse", (event) => {
    const route = apiRoute(event);
    if (route) setRouteName(route);
  });
}
