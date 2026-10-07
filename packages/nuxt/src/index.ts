/**
 * Fixwire for Nuxt: a module that sets the SDK up in the browser (Vue's
 * errors, the router's routes, page loads) and on the server (Nitro's
 * errors, server rendering, API routes named after their routes).
 *
 *   // nuxt.config.ts
 *   export default defineNuxtConfig({
 *     modules: ["@fixwire/nuxt"],
 *     fixwire: { dsn: "https://<key>@ingest.eu.fixwire.io", tracesSampleRate: 0.2 },
 *   });
 *
 * Options that are functions (beforeSend, integrations…) go in
 * `fixwire.client.config.ts` and `fixwire.server.config.ts` next to
 * nuxt.config.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClientOptions } from "@fixwire/core";
import type { ModuleMeta, Nuxt, NuxtModule } from "@nuxt/schema";

import { stampDebugIds } from "./debugids.ts";

/** What fixwire.server.config exports: the Node.js SDK's options. */
export type { NodeOptions as ServerConfig } from "@fixwire/node";
/** What fixwire.client.config exports: the browser SDK's options. */
export type { BrowserOptions as ClientConfig } from "@fixwire/vue";

/** What `fixwire` in nuxt.config takes: the options both sides share. */
export interface ModuleOptions
  extends Pick<
    ClientOptions,
    | "dsn"
    | "release"
    | "environment"
    | "dist"
    | "sampleRate"
    | "tracesSampleRate"
    | "maxBreadcrumbs"
    | "sendDefaultPii"
    | "debug"
  > {
  /** Send components' props with Vue's errors (default false: they may hold personal data). */
  attachProps?: boolean;
}

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "runtime");

const meta: ModuleMeta = {
  name: "@fixwire/nuxt",
  configKey: "fixwire",
  compatibility: { nuxt: ">=3.13.0" },
};

/** `fixwire.<side>.config.{ts,mjs,js}` in the app's root, when there is one. */
function configFile(rootDir: string, side: "client" | "server"): string | undefined {
  for (const ext of ["ts", "mts", "mjs", "js"]) {
    const file = join(rootDir, `fixwire.${side}.config.${ext}`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function options(inline: Partial<ModuleOptions> | undefined, nuxt: Nuxt): ModuleOptions {
  const configured = (nuxt.options as { fixwire?: ModuleOptions }).fixwire;
  return { ...configured, ...inline };
}

function setup(inline: ModuleOptions, nuxt: Nuxt): void {
  const o = options(inline, nuxt);
  // Runtime config, so NUXT_PUBLIC_FIXWIRE_DSN (and the others) can set them
  // at run time; a key must exist for its variable to be read.
  const config = nuxt.options.runtimeConfig;
  config.public.fixwire = {
    dsn: "",
    release: "",
    environment: "",
    ...o,
    ...(config.public.fixwire as object | undefined),
  };
  // The runtime files import Nuxt's and Nitro's virtual modules: they're
  // built with the app, not loaded from node_modules.
  nuxt.options.build.transpile.push(runtime);
  const empty = join(runtime, "config.js");
  nuxt.options.alias["#fixwire/client-config"] =
    configFile(nuxt.options.rootDir, "client") ?? empty;
  nuxt.options.alias["#fixwire/server-config"] =
    configFile(nuxt.options.rootDir, "server") ?? empty;
  nuxt.options.plugins.unshift(
    { src: join(runtime, "plugin.client.js"), mode: "client" },
    { src: join(runtime, "plugin.server.js"), mode: "server" },
  );
  nuxt.options.nitro.plugins = [...(nuxt.options.nitro.plugins ?? []), join(runtime, "nitro.js")];
  // With browser source maps on, the build's files get debug ids before
  // Nitro records their sizes (fixwire-cli would change them too late).
  nuxt.hook("nitro:build:public-assets", (nitro) => {
    const sourcemap = nuxt.options.sourcemap as boolean | { client?: boolean | "hidden" };
    if (typeof sourcemap === "object" ? sourcemap.client : sourcemap)
      stampDebugIds(nitro.options.output.publicDir);
  });
}

const fixwire: NuxtModule<ModuleOptions> = Object.assign(setup, {
  getMeta: async () => meta,
  getOptions: async (inline?: Partial<ModuleOptions>, nuxt?: Nuxt) =>
    nuxt ? options(inline, nuxt) : { ...inline },
});

export default fixwire;
