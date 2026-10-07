"use client";

import * as Fixwire from "@fixwire/nextjs";

// Shown when the root layout itself fails; it replaces the whole page.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  Fixwire.useCaptureException(error);
  return (
    <html lang="en">
      <body>
        <h2>Something went wrong</h2>
      </body>
    </html>
  );
}
