# @fixwire/react

Error boundaries and React 19 root error handlers for `@fixwire/browser`.

```sh
npm install @fixwire/browser @fixwire/react
```

```jsx
import * as Fixwire from "@fixwire/browser";
import { ErrorBoundary, reactErrorHandler } from "@fixwire/react";

Fixwire.init({ dsn: "https://fw_pk_live_…@ingest.eu.fixwire.io" });

createRoot(el, {
  onUncaughtError: reactErrorHandler(),
  onCaughtError: reactErrorHandler({ handled: true }),
}).render(
  <ErrorBoundary fallback={({ resetError }) => <button onClick={resetError}>Try again</button>}>
    <App />
  </ErrorBoundary>,
);
```

- `ErrorBoundary` reports what it catches with the component stack and
  renders `fallback` (an element, or a function of the error); `beforeCapture`
  adds tags or context to that event.
- `withErrorBoundary(Component, props)` wraps a component.
- `reactErrorHandler()` reports errors React passes to the root; errors a
  Fixwire boundary caught are left to the boundary, and nothing is sent twice.
