// Vue's errorHandler: the errors Vue catches (rendering, watchers, lifecycle
// hooks, event handlers) never reach the browser's global handlers.
import { captureException, withScope } from "@fixwire/browser";
import type { App, ComponentPublicInstance } from "vue";

/** Options of attachErrorHandler. */
export interface ErrorHandlerOptions {
  /**
   * Log errors to the console as Vue does when it has no errorHandler
   * (default true). An errorHandler the app set before is called either way.
   */
  logErrors?: boolean;
  /** Send the component's props with its errors (default false: they may hold personal data). */
  attachProps?: boolean;
}

interface ComponentOptionsLike {
  name?: string;
  __name?: string;
  __file?: string;
}

/**
 * A component's name: its `name`, the name `<script setup>` gives it, or
 * its file's; "Root" or "Anonymous" without one.
 */
export function componentName(vm: ComponentPublicInstance | null | undefined): string {
  if (!vm) return "Anonymous";
  const o = vm.$options as ComponentOptionsLike;
  const file = o.__file
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.vue$/, "");
  return o.name || o.__name || file || (vm.$root === vm ? "Root" : "Anonymous");
}

/** The component and its parents, innermost first (20 at most). */
function componentTrace(vm: ComponentPublicInstance | null): string[] {
  const trace: string[] = [];
  for (let c = vm; c && trace.length < 20; c = c.$parent) trace.push(componentName(c));
  return trace;
}

/**
 * Reports the errors Vue catches in `app`, with the component, its parents
 * and where in it (a lifecycle hook, a render, an event handler) as the
 * `vue` context. An errorHandler the app set before keeps running after.
 *
 * @example
 * const app = createApp(App);
 * Fixwire.attachErrorHandler(app);
 */
export function attachErrorHandler(app: App, options: ErrorHandlerOptions = {}): void {
  const previous = app.config.errorHandler;
  if ((previous as { fixwire?: boolean } | undefined)?.fixwire) return;
  const handler = (error: unknown, vm: ComponentPublicInstance | null, info: string): void => {
    withScope((scope) => {
      const props = options.attachProps && vm?.$props ? { propsData: { ...vm.$props } } : {};
      scope.setContext("vue", {
        componentName: componentName(vm),
        componentTrace: componentTrace(vm),
        lifecycleHook: info,
        ...props,
      });
      captureException(error, { mechanism: { type: "vue", handled: false } });
    });
    if (previous) previous(error, vm, info);
    else if (options.logErrors !== false) console.error(error);
  };
  app.config.errorHandler = Object.assign(handler, { fixwire: true });
}
