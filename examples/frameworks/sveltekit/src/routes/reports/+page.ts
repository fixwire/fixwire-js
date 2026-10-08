import type { PageLoad } from './$types';

// Runs in the browser on a client-side navigation: the error reaches
// hooks.client.ts' handleError.
export const load: PageLoad = async () => {
	throw new Error('Reports are unavailable: the reporting service timed out');
};
