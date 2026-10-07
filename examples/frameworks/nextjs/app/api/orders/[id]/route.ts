// A route handler whose store is down: onRequestError reports the error
// with the route `/api/orders/[id]`, and Next.js answers 500.
export async function GET(_request: Request, { params }: RouteContext<"/api/orders/[id]">) {
  const { id } = await params;
  throw new Error(`The order store is down (order ${id})`);
}
