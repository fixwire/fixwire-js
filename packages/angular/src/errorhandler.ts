// Angular's ErrorHandler: the errors Angular catches (event handlers,
// change detection, @boundary blocks, and with
// provideBrowserGlobalErrorListeners the window's) reach it, not the
// browser's global handlers.

import { ErrorHandler } from "@angular/core";
import { captureException, type EventProcessor, getGlobalScope, withScope } from "@fixwire/browser";

/** Options of the error handler. */
export interface ErrorHandlerOptions {
  /** Log errors to the console as Angular's own handler does (default true). */
  logErrors?: boolean;
}

/** HttpClient's error: not an Error, but carries the request's URL and status. */
interface HttpErrorResponseLike {
  name: "HttpErrorResponse";
  message: string;
  status: number;
  statusText: string;
  url: string | null;
}

function isHttpErrorResponse(error: unknown): error is HttpErrorResponseLike {
  const e = error as Partial<HttpErrorResponseLike> | null;
  return (
    !!e && typeof e === "object" && e.name === "HttpErrorResponse" && typeof e.status === "number"
  );
}

/**
 * An event processor for HttpClient's errors, however they're captured
 * (Angular's ErrorHandler, or the window's error event when an observable's
 * error went unhandled): named HttpErrorResponse with its message, the
 * request's URL and status as the `http` context, and without the response
 * body the SDK would otherwise send.
 */
export const httpErrorResponses: EventProcessor = (event, hint) => {
  const error = hint.originalException;
  const [exception] = event.exception?.values ?? [];
  if (!isHttpErrorResponse(error) || !exception) return event;
  exception.type = "HttpErrorResponse";
  exception.value = error.message;
  event.contexts = {
    ...event.contexts,
    http: { url: error.url, status: error.status, statusText: error.statusText },
  };
  event.tags = { ...event.tags, "http.response.status_code": String(error.status) };
  if (event.extra) delete event.extra.__serialized__;
  return event;
};

const processed = new WeakSet<object>();

/** Adds httpErrorResponses to every event, once. */
export function describeHttpErrors(): void {
  const scope = getGlobalScope();
  if (processed.has(scope)) return;
  processed.add(scope);
  scope.addEventProcessor(httpErrorResponses);
}

interface DefinitionLike {
  selectors?: unknown[][];
}

/**
 * A component or directive, as Angular gives it in details: its selector
 * (production builds minify class names), or its class's name for a
 * component without one.
 */
function nameOf(type: unknown): string | undefined {
  if (typeof type !== "function") return undefined;
  const t = type as { ɵcmp?: DefinitionLike; ɵdir?: DefinitionLike };
  const selector = (t.ɵcmp ?? t.ɵdir)?.selectors?.[0]?.[0];
  if (typeof selector === "string" && selector && selector !== "ng-component") return selector;
  return type.name || undefined;
}

/** What onViewError says about where an error happened. */
export interface ViewErrorDetails {
  readonly declarationType?: unknown;
  readonly boundary?: { readonly type?: unknown };
}

/**
 * Reports what Angular hands its ErrorHandler, as it is: the window's error
 * listener may have reported the same object, which is sent once. The
 * `angular` context names the component of a view error.
 */
function report(error: unknown, handled: boolean, details?: ViewErrorDetails): void {
  withScope((scope) => {
    if (details) {
      scope.setContext("angular", {
        component: nameOf(details.declarationType),
        boundary: nameOf(details.boundary?.type),
      });
    }
    captureException(error, { mechanism: { type: "angular", handled } });
  });
}

/**
 * An ErrorHandler that reports to Fixwire, then logs as Angular's does.
 * Provide it with `provideFixwire()`, or `createErrorHandler()`.
 */
export class FixwireErrorHandler extends ErrorHandler {
  readonly #options: ErrorHandlerOptions;

  constructor(options: ErrorHandlerOptions = {}) {
    super();
    this.#options = options;
  }

  override handleError(error: unknown): void {
    report(error, false);
    if (this.#options.logErrors !== false) super.handleError(error);
  }

  /** An error a @boundary block caught while rendering: handled, with the component. */
  onViewError(error: Error, details: ViewErrorDetails): void {
    report(error, true, details);
    if (this.#options.logErrors !== false) super.handleError(error);
  }
}

/**
 * An ErrorHandler that reports to Fixwire, for apps that provide it
 * themselves.
 *
 * @example
 * providers: [{ provide: ErrorHandler, useValue: Fixwire.createErrorHandler() }]
 */
export function createErrorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  return new FixwireErrorHandler(options);
}
