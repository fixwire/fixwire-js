import type { RequestHandler } from './$types';

// An endpoint whose store is down: SvelteKit answers 500, and Fixwire reports
// the error with the route `/api/orders/[id]`.
export const GET: RequestHandler = async ({ params }) => {
	throw new Error(`The order store is down (order ${params.id})`);
};
