/**
 * Fixwire for React: an error boundary that reports what it catches, with
 * the component stack, and handlers for React 19's root error options.
 *
 *   import * as Fixwire from "@fixwire/browser";
 *   import { ErrorBoundary, reactErrorHandler } from "@fixwire/react";
 *
 *   Fixwire.init({ dsn: "…" });
 *   createRoot(el, { onUncaughtError: reactErrorHandler() }).render(
 *     createElement(ErrorBoundary, { fallback: createElement(Oops) }, createElement(App)),
 *   );
 */
import { captureException, type Scope, withScope } from "@fixwire/browser";
import {
  Component,
  type ComponentType,
  createElement,
  type ErrorInfo,
  type ReactNode,
} from "react";

/** What a fallback function receives. */
export interface FallbackProps {
  error: unknown;
  /** Where in the component tree it happened. */
  componentStack: string;
  /** The reported event's id (undefined when it was dropped or Fixwire isn't set up). */
  eventId: string | undefined;
  /** Clears the error and renders the children again. */
  resetError(): void;
}

/** Props of ErrorBoundary. */
export interface ErrorBoundaryProps {
  children?: ReactNode;
  /** What to render after an error: an element, or a function of the error. Default: nothing. */
  fallback?: ReactNode | ((props: FallbackProps) => ReactNode);
  /** Adds data to this error's event (tags, context, a level) before it is sent. */
  beforeCapture?(scope: Scope, error: unknown, componentStack: string): void;
  /** Called once the error is reported. */
  onError?(error: unknown, componentStack: string, eventId: string | undefined): void;
  /** Called when resetError() clears the error. */
  onReset?(error: unknown): void;
}

interface State {
  failed: boolean;
  error: unknown;
  componentStack: string;
  eventId: string | undefined;
}

const INITIAL: State = { failed: false, error: undefined, componentStack: "", eventId: undefined };

/** Reports one error with the component stack as context. */
function report(
  error: unknown,
  componentStack: string,
  handled: boolean,
  mechanism: string,
  beforeCapture?: (scope: Scope) => void,
): string | undefined {
  return withScope((scope) => {
    if (componentStack) scope.setContext("react", { componentStack });
    beforeCapture?.(scope);
    return captureException(error, { mechanism: { type: mechanism, handled } });
  });
}

/**
 * Catches render errors in its children, reports them (with the component
 * stack) and renders the fallback instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = INITIAL;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    const eventId = report(error, componentStack, true, "react.errorboundary", (scope) =>
      this.props.beforeCapture?.(scope, error, componentStack),
    );
    this.props.onError?.(error, componentStack, eventId);
    this.setState({ componentStack, eventId });
  }

  /** Clears the error and renders the children again. */
  resetError = (): void => {
    const { error } = this.state;
    this.setState(INITIAL);
    this.props.onReset?.(error);
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") {
      const { error, componentStack, eventId } = this.state;
      return fallback({ error, componentStack, eventId, resetError: this.resetError });
    }
    return fallback ?? null;
  }
}

/** A component wrapped in an ErrorBoundary with these props. */
export function withErrorBoundary<P extends object>(
  WrappedComponent: ComponentType<P>,
  boundary: Omit<ErrorBoundaryProps, "children"> = {},
): ComponentType<P> {
  const name = WrappedComponent.displayName ?? WrappedComponent.name ?? "Component";
  const Wrapped = (props: P): ReactNode =>
    createElement(ErrorBoundary, boundary, createElement(WrappedComponent, props));
  Wrapped.displayName = `withErrorBoundary(${name})`;
  return Wrapped;
}

/** Options of reactErrorHandler(). */
export interface ReactErrorHandlerOptions {
  /**
   * Whether the errors were handled: false for onUncaughtError (the
   * default), true for onCaughtError and onRecoverableError.
   */
  handled?: boolean;
  /** Called after each report, e.g. to keep logging to the console. */
  callback?(error: unknown, errorInfo: RootErrorInfo, eventId: string | undefined): void;
}

/** What React passes to root error handlers. */
export interface RootErrorInfo {
  componentStack?: string;
  /** The boundary that caught the error (onCaughtError). */
  errorBoundary?: unknown;
}

/**
 * A handler for React 19's root error options. Errors caught by a Fixwire
 * ErrorBoundary are left to it (it reports them with its own options), and
 * no error is sent twice.
 *
 * @example
 * createRoot(el, {
 *   onUncaughtError: reactErrorHandler(),
 *   onCaughtError: reactErrorHandler({ handled: true }),
 *   onRecoverableError: reactErrorHandler({ handled: true }),
 * });
 */
export function reactErrorHandler(
  options: ReactErrorHandlerOptions = {},
): (error: unknown, errorInfo: RootErrorInfo) => void {
  return (error, errorInfo) => {
    if (errorInfo.errorBoundary instanceof ErrorBoundary) return;
    const eventId = report(
      error,
      errorInfo.componentStack ?? "",
      options.handled ?? false,
      "react.root",
    );
    options.callback?.(error, errorInfo, eventId);
  };
}
