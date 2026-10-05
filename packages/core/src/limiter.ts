/**
 * Client budgets: a fingerprint per event, a token bucket per fingerprint
 * and one across them. Suppressed occurrences are counted and ride on the
 * next event of that fingerprint (contexts.fixwire.suppressed), so issue
 * counts stay right while a crash loop costs a few events. The server's
 * grouping stays authoritative; this fingerprint only drives budgets.
 */
import type { Event } from "./types.ts";

const NUMBERS =
  /\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|\b[0-9a-fA-F]{16,}\b|\d+(?:\.\d+)?|\S+@\S+\.\w+/g;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const QUERY_HASH = /[?#].*$/;
const BUNDLE_HASH = /([.-])[0-9a-f]{6,}(?=\.\w+$)/i;

/** FNV-1a 32 twice (with different seeds) gives a cheap 64-bit hash. */
function fnv(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const template = (message: string): string => message.replace(NUMBERS, "<*>");

const where = (filename: string): string =>
  filename
    .replace(QUERY_HASH, "")
    .replace(/^[a-z]+:\/\/[^/]+/i, "")
    .replace(LINE_SUFFIX, "")
    .replace(BUNDLE_HASH, "$1<hash>");

export function fingerprint(event: Event): string {
  const parts: string[] = [];
  const values = event.exception?.values ?? [];
  if (values.length) {
    for (const v of values) parts.push(v.type ?? "");
    const frames = values[values.length - 1]?.stacktrace?.frames ?? [];
    const app = frames.filter((f) => f.in_app);
    for (const f of (app.length ? app : frames).slice(-5))
      parts.push(`${f.module ?? where(f.filename ?? "")}|${f.function ?? ""}`);
    if (!frames.length) parts.push(template(values[values.length - 1]?.value ?? ""));
  } else {
    parts.push(template(event.message ?? ""));
  }
  if (event.fingerprint?.length) parts.push(event.fingerprint.join("\x1f"));
  const text = parts.join("\x1e");
  return fnv(text, 0x811c9dc5) + fnv(text, 0x050c5d1f);
}

export interface Suppressed {
  count: number;
  first: number;
  last: number;
}

interface Bucket {
  tokens: number;
  updated: number;
  suppressed: number;
  first: number;
  last: number;
}

export interface RateLimitOptions {
  /** Events per issue sent in a burst (default 10). */
  perIssueBurst?: number;
  /** Then this many per minute per issue (default 1). Suppressed ones are counted. */
  perIssuePerMinute?: number;
  /** Events per minute across issues (default 100 in browsers, 600 on servers). */
  globalPerMinute?: number;
  /** false turns the budgets off (default true). */
  enabled?: boolean;
}

const LRU = 1024;

export class Limiter {
  private readonly issues = new Map<string, Bucket>();
  private readonly global: Bucket;
  private readonly burst: number;
  private readonly rate: number;
  private readonly globalRate: number;
  private readonly enabled: boolean;

  constructor(o: RateLimitOptions, defaultGlobal: number) {
    this.burst = o.perIssueBurst ?? 10;
    this.rate = o.perIssuePerMinute ?? 1;
    this.globalRate = o.globalPerMinute ?? defaultGlobal;
    this.enabled = o.enabled ?? true;
    this.global = { tokens: this.globalRate, updated: 0, suppressed: 0, first: 0, last: 0 };
  }

  /** Whether to send, and the occurrences suppressed since the last one sent. */
  allow(fp: string, now: number): [boolean, Suppressed | undefined] {
    if (!this.enabled) return [true, undefined];
    let b = this.issues.get(fp);
    if (b) {
      this.issues.delete(fp);
    } else {
      b = { tokens: this.burst, updated: now, suppressed: 0, first: 0, last: 0 };
      if (this.issues.size >= LRU) this.issues.delete(this.issues.keys().next().value as string);
    }
    this.issues.set(fp, b);
    if (!this.global.updated) this.global.updated = now;
    if (
      take(b, this.burst, this.rate, now) &&
      take(this.global, this.globalRate, this.globalRate, now)
    ) {
      if (b.suppressed) {
        const out = { count: b.suppressed, first: b.first, last: b.last };
        b.suppressed = 0;
        return [true, out];
      }
      return [true, undefined];
    }
    if (!b.suppressed) b.first = now;
    b.suppressed++;
    b.last = now;
    return [false, undefined];
  }
}

function take(b: Bucket, burst: number, perMinute: number, now: number): boolean {
  b.tokens = Math.min(burst, b.tokens + ((now - b.updated) * perMinute) / 60);
  b.updated = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}
