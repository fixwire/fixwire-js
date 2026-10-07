"use client";

import * as Fixwire from "@fixwire/nextjs";

export default function ErrorPage({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // A server error arrives with a digest: the server reported it already.
  Fixwire.useCaptureException(error);
  return (
    <div role="alert">
      <h2>Something went wrong</h2>
      {error.digest && <p>Reference: {error.digest}</p>}
      <button type="button" onClick={() => unstable_retry()}>
        Try again
      </button>
    </div>
  );
}
