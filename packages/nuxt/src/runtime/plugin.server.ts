// Server rendering: the request is named after the page's route, and Vue's
// errors are reported with their component. The SDK itself is set up by the
// Nitro plugin.

import { captureException, setRouteName } from "@fixwire/core";
import { captureVueError, routeName } from "@fixwire/vue/shared";
import { defineNuxtPlugin, useRuntimeConfig } from "#app";

import type { RuntimeSettings } from "./shared.ts";

export default defineNuxtPlugin({
  name: "fixwire:server",
  enforce: "pre",
  setup(nuxtApp) {
    const attachProps =
      (useRuntimeConfig().public.fixwire as RuntimeSettings | undefined)?.attachProps === true;
    const name = (): void => {
      const route = nuxtApp.$router?.currentRoute.value;
      if (route?.matched.length) setRouteName(routeName(route));
    };
    nuxtApp.hook("vue:error", (error, vm, info) => {
      name();
      captureVueError(error, vm, info, { attachProps, mechanism: "nuxt.vue" });
    });
    nuxtApp.hook("app:error", (error) => {
      name();
      captureException(error, { mechanism: { type: "nuxt.app", handled: false } });
    });
    nuxtApp.hook("app:rendered", name);
  },
});
