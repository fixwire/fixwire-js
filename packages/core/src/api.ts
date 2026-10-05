/**
 * The top-level API, on the client bound in the global slot, with the
 * familiar names (init, captureException, setUser, withScope, …).
 */
import type { Client } from "./client.ts";
import { carrier, getCurrentScope, getIsolationScope } from "./scope.ts";
import type {
  Breadcrumb,
  CheckIn,
  Event,
  EventHint,
  Feedback,
  MonitorConfig,
  SeverityLevel,
  User,
} from "./types.ts";

let lastId: string | undefined;

/** Makes `client` the one the top-level functions use (init does this). */
export function bindClient(client: Client | undefined): void {
  carrier().client = client;
}

/** The client bound by init(), if any. */
export function getClient(): Client | undefined {
  return carrier().client as Client | undefined;
}

const remember = (id: string | undefined): string | undefined => {
  if (id) lastId = id;
  return id;
};

/**
 * Reports an error (or any thrown value) with the current scopes. Returns
 * the event id, or undefined when it was dropped.
 *
 * @example
 * try { await charge(order) } catch (err) { captureException(err) }
 */
export function captureException(exception: unknown, hint?: EventHint): string | undefined {
  return remember(
    getClient()?.captureException(exception, {
      syntheticException: new Error("Fixwire syntheticException"),
      ...hint,
    }),
  );
}

/** Reports a message (default level "info"). Returns the event id, or undefined when dropped. */
export function captureMessage(message: string, level?: SeverityLevel): string | undefined {
  return remember(getClient()?.captureMessage(message, level));
}

/**
 * Sends feedback: how someone rated an AI answer (score -1 to 1, with the
 * trace that produced it) and/or what they said about a crash (eventId).
 * A negative rating opens a user_feedback issue for the agent. Returns the
 * feedback's id, or undefined when it holds neither a message nor a rating.
 *
 * @example
 * captureFeedback({ score: -1, traceId, message: "It refunded the wrong order" });
 */
export function captureFeedback(feedback: Feedback): string | undefined {
  return getClient()?.captureFeedback(feedback);
}

/**
 * Reports a scheduled job's run to its monitor: `in_progress` when it
 * starts, then `ok` or `error` with the id this returned. A monitor config
 * creates or updates the monitor. Returns the check-in's id.
 *
 * @example
 * const checkInId = captureCheckIn({ monitorSlug: "nightly-report", status: "in_progress" });
 * await report();
 * captureCheckIn({ monitorSlug: "nightly-report", status: "ok", checkInId });
 */
export function captureCheckIn(
  checkIn: CheckIn,
  monitorConfig?: MonitorConfig,
): string | undefined {
  return getClient()?.captureCheckIn(checkIn, monitorConfig);
}

/** Sends an event you built. Returns its id, or undefined when dropped. */
export function captureEvent(event: Event, hint?: EventHint): string | undefined {
  return remember(getClient()?.captureEvent(event, hint));
}

/** The id of the last event the top-level functions sent. */
export const lastEventId = (): string | undefined => lastId;

/** A searchable key/value on the events of this request or task. */
export function setTag(key: string, value: unknown): void {
  getIsolationScope().setTag(key, value);
}

/** Several tags at once. */
export function setTags(tags: Record<string, unknown>): void {
  getIsolationScope().setTags(tags);
}

/** Unindexed data on the events of this request or task. */
export function setExtra(key: string, value: unknown): void {
  getIsolationScope().setExtra(key, value);
}

/** Structured data under `contexts[key]`; null removes it. */
export function setContext(key: string, value: Record<string, unknown> | null): void {
  getIsolationScope().setContext(key, value);
}

/**
 * Who hit the error; null clears it.
 *
 * @example
 * setUser({ id: session.userId, email: session.email })
 */
export function setUser(user: User | null): void {
  getIsolationScope().setUser(user);
}

/**
 * Records a step on the way to an error; events captured later in this
 * request or task carry the latest breadcrumbs.
 *
 * @example
 * addBreadcrumb({ category: "cart", message: "added sku-1", level: "info" })
 */
export function addBreadcrumb(crumb: Breadcrumb, hint?: Record<string, unknown>): void {
  const client = getClient();
  if (client) client.addBreadcrumb(crumb, hint);
  else getIsolationScope().addBreadcrumb({ timestamp: Date.now() / 1000, ...crumb });
}

/** Resolves true once queued events are sent (default timeout 2 s). */
export async function flush(timeoutMs?: number): Promise<boolean> {
  return (await getClient()?.flush(timeoutMs)) ?? true;
}

/** Flushes and unbinds the client: later captures are no-ops. */
export async function close(timeoutMs?: number): Promise<boolean> {
  const client = getClient();
  if (!client) return true;
  const ok = await client.close(timeoutMs);
  bindClient(undefined);
  return ok;
}

export { getCurrentScope };
