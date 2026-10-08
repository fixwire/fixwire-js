import type { PageServerLoad } from './$types';

// Runs on the server: an error here reaches hooks.server.ts' handleError,
// with the route `/users/[id]`.
export const load: PageServerLoad = async ({ params }) => {
	if (params.id === 'crash') throw new Error('The user service is unavailable');
	return { user: { id: params.id, name: `User ${params.id}` } };
};
