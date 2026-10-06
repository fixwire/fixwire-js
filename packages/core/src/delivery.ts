/**
 * Delivery as a sans-IO state machine (the same design as the Python SDK):
 * queue policy, retries with backoff and rate limits. The client feeds it
 * time and HTTP outcomes; it never sets timers itself.
 *
 * Bounds (fixwire-protocol §13): a request is sent at most 4 times in all:
 * again after no answer or a 5xx (about 1 s, then twice as long each time,
 * never sooner than Retry-After) and after a 429's pause. One whose next
 * try would be more than 5 minutes away is dropped. Retry-After (seconds
 * or an HTTP date) and Fixwire-Rate-Limits pause from 0 to a day: a 429
 * without Fixwire-Rate-Limits pauses everything for Retry-After, a minute
 * at least, and a 5xx with Retry-After everything for that long. Other
 * answers drop the request. At most maxQueue requests wait to be sent, and
 * as many for a retry; past that, new ones are dropped.
 */

export const BACKOFF_BASE = 1;
/** A request whose next try would be further away (seconds) is dropped. */
export const MAX_WAIT = 300;
/** Sends of one request in all, 429s included. */
export const MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_AFTER = 60;
/** The longest pause a server can ask for: a day (seconds). */
const MAX_PAUSE = 86_400;
/** The kinds of data a pause may name (fixwire-protocol §2); "" is all of them. */
const CATEGORIES = ["", "error", "log", "span", "session", "check_in", "feedback", "file"];

/** Whole seconds from a header, at most a day; undefined when broken. */
const seconds = (v: string): number | undefined =>
  /^\s*\d+\s*$/.test(v) ? Math.min(Number(v), MAX_PAUSE) : undefined;

/** Retry-After, seconds or an HTTP date, as seconds from `now` (at most a day); undefined when missing or broken. */
export function retryAfter(v: string | null, now: number): number | undefined {
  if (!v) return undefined;
  const s = seconds(v);
  const at = /^\s*[a-z]/i.test(v) ? Date.parse(v) / 1000 : Number.NaN;
  return s ?? (Number.isNaN(at) ? undefined : Math.min(Math.max(at - now, 0), MAX_PAUSE));
}

/** One request to the ingest, as queued, retried and kept offline. */
export interface Outbound {
  /** Relative to the DSN's base URL, e.g. `/v1/logs`. */
  path: string;
  contentType: string;
  body: string | Uint8Array;
  /** The kind of data, for rate limits: error, log, span, session, check_in, feedback or file. */
  category: string;
  attempts: number;
  notBefore: number;
  /** Headers the body needs (e.g. Content-Encoding). */
  headers?: Record<string, string>;
  /** Its key in the offline spool, if one is on. */
  spoolId?: string | number;
}

export interface Decision {
  sent?: boolean;
  retry?: boolean;
  dropped?: boolean;
  reason?: string;
}

/**
 * Fixwire-Rate-Limits to {category: until}; "" means every category.
 * Broken parts and categories that aren't the protocol's are left out.
 */
export function parseRateLimits(header: string, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const limit of header.split(",")) {
    const [secs = "", cats = ""] = limit.trim().split(":");
    const n = seconds(secs);
    if (n === undefined) continue;
    for (const c of cats.split(";")) {
      const k = c.trim();
      if (CATEGORIES.includes(k)) out[k] = Math.max(out[k] ?? 0, now + n);
    }
  }
  return out;
}

export class Delivery {
  readonly queue: Outbound[] = [];
  readonly limits: Record<string, number> = {};
  private bytes = 0;

  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly rng: () => number;

  constructor(maxItems = 100, maxBytes = 8 << 20, rng: () => number = Math.random) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.rng = rng;
  }

  /** Queues a new request; false (it is dropped) when maxItems wait already, or their bytes are too many. */
  offer(item: Outbound): boolean {
    if (
      this.waiting(false) >= this.maxItems ||
      (this.queue.length > 0 && this.bytes + size(item) > this.maxBytes)
    )
      return false;
    this.queue.push(item);
    this.bytes += size(item);
    return true;
  }

  /** Requests waiting for their first send (false) or for a retry (true). */
  private waiting(retries: boolean): number {
    return this.queue.filter((i) => i.attempts > 0 === retries).length;
  }

  /** When a request may go: after its backoff and its kind's pause. */
  due(item: Outbound): number {
    return Math.max(item.notBefore, this.limits[""] ?? 0, this.limits[item.category] ?? 0);
  }

  /** The next request due, if any; those that would wait past MAX_WAIT are dropped. */
  next(now: number): Outbound | undefined {
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i] as Outbound;
      const due = this.due(item);
      if (due > now && due - now <= MAX_WAIT) continue;
      this.queue.splice(i--, 1);
      this.bytes -= size(item);
      if (due <= now) return item;
    }
    return undefined;
  }

  wakeAt(): number | undefined {
    let min: number | undefined;
    for (const i of this.queue) min = Math.min(min ?? Infinity, this.due(i));
    return min;
  }

  onResponse(
    item: Outbound,
    status: number,
    header: (name: string) => string | null,
    now: number,
  ): Decision {
    const after = retryAfter(header("retry-after"), now);
    const limits = header("fixwire-rate-limits");
    const pause = (c: string, until: number): void => {
      this.limits[c] = Math.max(this.limits[c] ?? 0, until);
    };
    if (limits) {
      for (const [c, until] of Object.entries(parseRateLimits(limits, now))) pause(c, until);
    } else if (status === 429) {
      pause("", now + Math.max(after ?? 0, DEFAULT_RETRY_AFTER));
    }
    if (status >= 500 && after !== undefined) pause("", now + after);
    if (status >= 200 && status < 300) return { sent: true };
    if (status === 429 || status >= 500)
      return this.retry(item, now, `status ${status}`, after ?? 0);
    return { dropped: true, reason: `status ${status}` };
  }

  onError(item: Outbound, now: number, reason = "network error"): Decision {
    return this.retry(item, now, reason, 0);
  }

  private retry(item: Outbound, now: number, reason: string, wait: number): Decision {
    // The last send, a next try too far away, or too many waiting already.
    const delay = Math.max(wait, BACKOFF_BASE * 2 ** item.attempts * (0.5 + this.rng() / 2));
    if (++item.attempts >= MAX_ATTEMPTS || delay > MAX_WAIT || this.waiting(true) >= this.maxItems)
      return { dropped: true, reason };
    item.notBefore = now + delay;
    this.queue.unshift(item);
    this.bytes += size(item);
    return { retry: true, reason };
  }
}

function size(i: Outbound): number {
  return typeof i.body === "string" ? i.body.length : i.body.byteLength;
}
