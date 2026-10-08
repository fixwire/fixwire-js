import * as Fixwire from '@fixwire/sveltekit';
import { PUBLIC_FIXWIRE_DSN } from '$app/env/public';
import type { ClientInit, HandleClientError } from '@sveltejs/kit/hooks';

// When the app starts in the browser; the server hands it PUBLIC_FIXWIRE_DSN
// (declared in src/env.ts).
export const init: ClientInit = () => {
	Fixwire.init({ dsn: PUBLIC_FIXWIRE_DSN, tracesSampleRate: 1 });
};

// Unexpected errors while navigating, such as a load function that throws.
export const handleError: HandleClientError = Fixwire.handleErrorWithFixwire();
