import * as Fixwire from "@fixwire/nextjs";

async function loadUser(id: string): Promise<{ id: string; name: string }> {
  if (id === "crash") throw new Error("The user service is unavailable");
  return { id, name: `User ${id}` };
}

// Rendered on the server for each request. An error here reaches
// instrumentation.ts' onRequestError, with the route `/users/[id]`.
export default async function UserPage({ params }: PageProps<"/users/[id]">) {
  const { id } = await params;
  Fixwire.setTag("user.id", id);
  const user = await loadUser(id);
  return <h1>{user.name}</h1>;
}

export const dynamic = "force-dynamic";
