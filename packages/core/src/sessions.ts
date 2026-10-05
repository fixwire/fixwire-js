/**
 * Release health: sessions. In a browser a page load is one session; it
 * ends crashed on an unhandled error, else exited when the page goes away.
 * On a server each request is one, counted per minute and user and sent as
 * aggregates. Sessions need a release, and send no content: their user is
 * a hash of the user's id, email or username, made on this device.
 */
import type { User } from "./types.ts";

/** How a request ended, for its session. */
export type RequestStatus = "ok" | "errored" | "crashed";

/** The session of the request an isolation scope serves. */
export interface RequestSession {
  status: RequestStatus;
}

/** A browser page's session. */
export interface PageSession {
  sid: string;
  started: number;
  status: "ok" | "exited" | "crashed";
  errors: number;
  init: boolean;
  ended: boolean;
}

/** Who a session belongs to, before hashing. */
export function identity(user: User | undefined): string | undefined {
  const v = user?.id ?? user?.email ?? user?.username;
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

/** A device-side hash of an identity (32 hex), or undefined without Web Crypto. */
export async function hashIdentity(value: string | undefined): Promise<string | undefined> {
  const subtle = (
    globalThis as {
      crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
    }
  ).crypto?.subtle;
  if (value === undefined || !subtle) return undefined;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

interface Bucket {
  started: number; // Unix seconds, start of the minute
  did: string | undefined;
  exited: number;
  errored: number;
  crashed: number;
}

/** Request sessions counted per minute and user, until sent. */
export class SessionAggregates {
  private buckets = new Map<string, Bucket>();

  get size(): number {
    return this.buckets.size;
  }

  record(status: RequestStatus, did: string | undefined, at: number): void {
    const minute = Math.floor(at / 60) * 60;
    const key = `${minute}\x00${did ?? ""}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { started: minute, did, exited: 0, errored: 0, crashed: 0 };
      this.buckets.set(key, b);
    }
    if (status === "crashed") b.crashed++;
    else if (status === "errored") b.errored++;
    else b.exited++;
  }

  /** Empties the counts into the `aggregates` of a /v1/sessions body (users hashed). */
  async take(): Promise<Record<string, unknown>[]> {
    const buckets = [...this.buckets.values()];
    this.buckets = new Map();
    const aggregates: Record<string, unknown>[] = [];
    for (const b of buckets) {
      const a: Record<string, unknown> = { started: new Date(b.started * 1000).toISOString() };
      const did = await hashIdentity(b.did);
      if (did) a.did = did;
      if (b.exited) a.exited = b.exited;
      if (b.errored) a.errored = b.errored;
      if (b.crashed) a.crashed = b.crashed;
      aggregates.push(a);
    }
    return aggregates;
  }
}
