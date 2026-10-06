/**
 * Delivery as a sans-IO state machine (the same design as the Python SDK):
 * queue policy, retries with backoff and rate limits. The client feeds it
 * time and HTTP outcomes; it never sets timers itself.
 *
 * Retries (sdks/PROTOCOL.md §2): network errors, 429 and 5xx, with
 * exponential backoff and jitter from 1 s to 5 min, never sooner than the
 * server's Retry-After, up to 6 attempts. Other 4xx answers drop the
 * request. Fixwire-Rate-Limits pauses kinds of data: their requests wait
 * in the (bounded) queue until the pause ends, while the rest keeps flowing.
 * Both pauses are capped at an hour.
 */

export const BACKOFF_BASE = 1;
export const BACKOFF_MAX = 300;
export const MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_AFTER = 60;
/** The longest pause a server can ask for (seconds): past 24.8 days timers fire at once. */
const MAX_RETRY_AFTER = 3600;

/** Seconds from a header, within [0, MAX_RETRY_AFTER]; 0 when it isn't a number. */
const seconds = (v: string | null): number =>
  Math.min(Math.max(Number(v) || 0, 0), MAX_RETRY_AFTER);

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

/** Fixwire-Rate-Limits to {category: until}; "" means every category. */
export function parseRateLimits(header: string, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const limit of header.split(",")) {
    const [secs = "", cats = ""] = limit.trim().split(":");
    if (secs === "" || !Number.isFinite(Number(secs))) continue;
    const n = seconds(secs);
    for (const c of cats.split(";")) {
      const k = c.trim();
      out[k] = Math.max(out[k] ?? 0, now + n);
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

  constructor(maxItems = 64, maxBytes = 8 << 20, rng: () => number = Math.random) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.rng = rng;
  }

  /** Queues a request; the oldest go when the queue is full. */
  offer(item: Outbound): void {
    this.queue.push(item);
    this.bytes += size(item);
    while (
      this.queue.length > this.maxItems ||
      (this.bytes > this.maxBytes && this.queue.length > 1)
    ) {
      this.bytes -= size(this.queue.shift() as Outbound);
    }
  }

  /** When a request may go: after its backoff and its kind's pause. */
  due(item: Outbound): number {
    return Math.max(item.notBefore, this.limits[""] ?? 0, this.limits[item.category] ?? 0);
  }

  next(now: number): Outbound | undefined {
    const i = this.queue.findIndex((item) => this.due(item) <= now);
    if (i < 0) return undefined;
    const [item] = this.queue.splice(i, 1) as [Outbound];
    this.bytes -= size(item);
    return item;
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
    const retryAfter = seconds(header("retry-after"));
    const limits = header("fixwire-rate-limits");
    if (limits) {
      for (const [c, until] of Object.entries(parseRateLimits(limits, now)))
        this.limits[c] = Math.max(this.limits[c] ?? 0, until);
    } else if (status === 429) {
      this.limits[""] = now + (retryAfter || DEFAULT_RETRY_AFTER);
    }
    if (status >= 200 && status < 300) return { sent: true };
    if (status === 429 || status >= 500)
      return this.retry(item, now, `status ${status}`, now + retryAfter);
    return { dropped: true, reason: `status ${status}` };
  }

  onError(item: Outbound, now: number, reason = "network error"): Decision {
    return this.retry(item, now, reason, 0);
  }

  private retry(item: Outbound, now: number, reason: string, notBefore: number): Decision {
    item.attempts++;
    if (item.attempts >= MAX_ATTEMPTS) return { dropped: true, reason };
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (item.attempts - 1));
    item.notBefore = Math.max(notBefore, now + delay * (0.5 + this.rng() / 2));
    this.queue.unshift(item);
    this.bytes += size(item);
    return { retry: true, reason };
  }
}

function size(i: Outbound): number {
  return typeof i.body === "string" ? i.body.length : i.body.byteLength;
}
