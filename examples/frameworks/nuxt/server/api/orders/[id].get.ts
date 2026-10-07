// An API route whose store is down: Nitro answers 500, and Fixwire reports
// the error with the route `/api/orders/:id`.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  throw new Error(`The order store is down (order ${id})`)
})
