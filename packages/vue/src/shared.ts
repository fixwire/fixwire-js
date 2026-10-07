/**
 * The parts of @fixwire/vue that don't need the browser SDK: reporting an
 * error Vue caught and naming routes. For server rendering and hosts that
 * set the SDK up themselves, such as @fixwire/nuxt.
 */
export {
  attachErrorHandler,
  captureVueError,
  componentName,
  type ErrorHandlerOptions,
} from "./errorhandler.ts";
export { instrumentRouter, type RouteLike, type RouterLike, routeName } from "./router.ts";
