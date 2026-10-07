// The browser: the SDK, Vue's errors through Nuxt's hooks, the router's
// routes as page names, page loads and navigations as traces.

import {
  type BrowserOptions,
  browserTracingIntegration,
  captureException,
  captureVueError,
  init,
  instrumentRouter,
  resolveIntegrations,
} from "@fixwire/vue";
import { defineNuxtPlugin, useRuntimeConfig } from "#app";
import config from "#fixwire/client-config";

import { type RuntimeSettings, settings } from "./shared.ts";

export default defineNuxtPlugin({
  name: "fixwire:client",
  enforce: "pre",
  setup(nuxtApp) {
    const { options, attachProps } = settings<BrowserOptions>(
      useRuntimeConfig().public.fixwire as RuntimeSettings | undefined,
      config,
    );
    if (options.defaultIntegrations !== false)
      options.integrations = resolveIntegrations(
        [browserTracingIntegration()],
        options.integrations,
      );
    // No app: Nuxt hands Vue's errors to its hooks, and takes its own
    // errorHandler off once the page is hydrated, which wrapping it would stop.
    init(options);
    nuxtApp.hook("vue:error", (error, vm, info) => {
      captureVueError(error, vm, info, { attachProps, mechanism: "nuxt.vue" });
    });
    // Plugin and startup errors; Vue's errors come here too while the page
    // hydrates, and are reported once.
    nuxtApp.hook("app:error", (error) => {
      captureException(error, { mechanism: { type: "nuxt.app", handled: false } });
    });
    nuxtApp.hook("app:created", () => {
      if (nuxtApp.$router) instrumentRouter(nuxtApp.$router);
    });
  },
});
