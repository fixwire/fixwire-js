// The virtual modules the runtime files import, as far as they use them:
// Nuxt and Nitro provide them when they build the app.
declare module "#app" {
  import type { ComponentPublicInstance } from "vue";

  interface RouteLike {
    path: string;
    matched: readonly { path: string }[];
  }
  interface NuxtAppLike {
    hook(
      name: "vue:error",
      fn: (error: unknown, vm: ComponentPublicInstance | null, info: string) => unknown,
    ): () => void;
    hook(name: "app:error", fn: (error: unknown) => unknown): () => void;
    hook(name: "app:created" | "app:rendered", fn: () => unknown): () => void;
    $router?: {
      afterEach(guard: (to: RouteLike, from: RouteLike, failure?: unknown) => unknown): () => void;
      onError(handler: (error: unknown) => unknown): () => void;
      readonly currentRoute: { readonly value: RouteLike };
    };
  }
  export function defineNuxtPlugin(plugin: {
    name?: string;
    enforce?: "pre" | "default" | "post";
    setup(nuxtApp: NuxtAppLike): void;
  }): unknown;
  export function useRuntimeConfig(): { public: Record<string, unknown> };
}

declare module "#imports" {
  export function useRuntimeConfig(): { public: Record<string, unknown> };
}

declare module "#fixwire/client-config" {
  import type { BrowserOptions } from "@fixwire/vue";

  const config: BrowserOptions | (() => BrowserOptions) | undefined;
  export default config;
}

declare module "#fixwire/server-config" {
  import type { NodeOptions } from "@fixwire/node";

  const config: NodeOptions | (() => NodeOptions) | undefined;
  export default config;
}
