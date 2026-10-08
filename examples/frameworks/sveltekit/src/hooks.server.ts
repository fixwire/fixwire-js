import * as Fixwire from '@fixwire/sveltekit';
import {
	sequence,
	type Handle,
	type HandleServerError,
	type ServerInit
} from '@sveltejs/kit/hooks';

// Before the first request: the DSN comes from FIXWIRE_DSN or PUBLIC_FIXWIRE_DSN.
export const init: ServerInit = () => {
	Fixwire.init({ tracesSampleRate: 1 });
};

// Each request named after its route (`GET /users/[id]`).
export const handle: Handle = sequence(Fixwire.fixwireHandle());

// Unexpected errors in load functions, actions and endpoints.
export const handleError: HandleServerError = Fixwire.handleErrorWithFixwire();
