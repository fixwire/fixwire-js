import * as Fixwire from "@fixwire/nextjs";

// Runs in the browser before the app: the DSN comes from
// NEXT_PUBLIC_FIXWIRE_DSN, which Next.js puts into the bundle at build time.
Fixwire.init({ tracesSampleRate: 1 });

// A breadcrumb for each navigation.
export const onRouterTransitionStart = Fixwire.onRouterTransitionStart;
