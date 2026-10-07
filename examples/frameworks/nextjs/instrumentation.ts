import * as Fixwire from "@fixwire/nextjs";

// Runs once when the server starts, on the Node.js runtime and the edge
// runtime alike: the DSN comes from FIXWIRE_DSN or NEXT_PUBLIC_FIXWIRE_DSN.
export function register() {
  Fixwire.init({ tracesSampleRate: 1 });
}

// Errors in server components, route handlers, server actions and the proxy.
export const onRequestError = Fixwire.captureRequestError;
