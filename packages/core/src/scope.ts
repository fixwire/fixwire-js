/**
 * Scopes in three layers, merged in this order into every event:
 * global (the process or page), isolation (a request or task, forked by
 * integrations; top-level setTag/setUser/addBreadcrumb write here) and
 * current (a withScope block). Which isolation and current scopes are
 * active comes from an async context strategy: a stack in browsers,
 * AsyncLocalStorage on Node.
 */
import type { RequestSession } from "./sessions.ts";
import type { PropagationContext, Span } from "./tracing.ts";
import type { Breadcrumb, Event, EventHint, SeverityLevel, User } from "./types.ts";

/** Changes an event, or drops it by returning null. */
export type EventProcessor = (event: Event, hint: EventHint) => Event | null;

/** Data merged into the events captured while the scope is active. */
export class Scope {
  tags: Record<string, string> = {};
  extra: Record<string, unknown> = {};
  contexts: Record<string, Record<string, unknown>> = {};
  user: User | undefined;
  level: SeverityLevel | undefined;
  fingerprint: string[] | undefined;
  private crumbs: Breadcrumb[] = [];
  processors: EventProcessor[] = [];
  maxBreadcrumbs = 100;
  /** The active span (current scopes): startSpan sets it for its callback. */
  span: Span | undefined;
  /** The trace of this request or task (isolation scopes). */
  propagation: PropagationContext | undefined;
  /** The session of the request this isolation scope serves (not copied by clone). */
  requestSession: RequestSession | undefined;

  /** A copy: changes to it don't touch this scope. */
  clone(): Scope {
    const s = new Scope();
    s.tags = { ...this.tags };
    s.extra = { ...this.extra };
    s.contexts = Object.fromEntries(Object.entries(this.contexts).map(([k, v]) => [k, { ...v }]));
    s.user = this.user ? { ...this.user } : undefined;
    s.level = this.level;
    s.fingerprint = this.fingerprint ? [...this.fingerprint] : undefined;
    s.crumbs = this.breadcrumbs;
    s.processors = [...this.processors];
    s.maxBreadcrumbs = this.maxBreadcrumbs;
    s.span = this.span;
    s.propagation = this.propagation;
    return s;
  }

  /** A searchable key/value (the value becomes a string). */
  setTag(key: string, value: unknown): this {
    try {
      this.tags[key] = String(value);
    } catch {
      // a value whose toString throws is not a tag
    }
    return this;
  }

  /** Several tags at once. */
  setTags(tags: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(tags)) this.setTag(k, v);
    return this;
  }

  /** Unindexed data on the events. */
  setExtra(key: string, value: unknown): this {
    this.extra[key] = value;
    return this;
  }

  /** Structured data under `contexts[key]`; null removes it. */
  setContext(key: string, value: Record<string, unknown> | null): this {
    if (value === null) delete this.contexts[key];
    else this.contexts[key] = value;
    return this;
  }

  /** Who hit the error; null clears it. */
  setUser(user: User | null): this {
    this.user = user ?? undefined;
    return this;
  }

  /** Overrides the level of the events captured in this scope. */
  setLevel(level: SeverityLevel): this {
    this.level = level;
    return this;
  }

  /** Groups this scope's events by these values instead of the stack. */
  setFingerprint(fingerprint: string[]): this {
    this.fingerprint = fingerprint;
    return this;
  }

  /** The last maxBreadcrumbs breadcrumbs, oldest first. */
  get breadcrumbs(): Breadcrumb[] {
    return this.maxBreadcrumbs > 0 ? this.crumbs.slice(-this.maxBreadcrumbs) : [];
  }

  set breadcrumbs(crumbs: Breadcrumb[]) {
    this.crumbs = crumbs;
  }

  /** Amortized constant time: the oldest go in one cut, once twice as many are kept. */
  addBreadcrumb(crumb: Breadcrumb): this {
    if (this.crumbs.push(crumb) >= 2 * this.maxBreadcrumbs) this.crumbs = this.breadcrumbs;
    return this;
  }

  clearBreadcrumbs(): this {
    this.crumbs = [];
    return this;
  }

  /** Runs `fn(event, hint)` on this scope's events; it returns the event, or null to drop it. */
  addEventProcessor(fn: EventProcessor): this {
    this.processors.push(fn);
    return this;
  }
}

/** Where the active isolation and current scopes live (a stack, AsyncLocalStorage, …). */
export interface AsyncContextStrategy {
  getIsolationScope(): Scope;
  getCurrentScope(): Scope;
  withScope<T>(cb: (scope: Scope) => T): T;
  withIsolationScope<T>(cb: (scope: Scope) => T): T;
}

/**
 * The browser strategy: a stack. A withScope callback that returns a promise
 * keeps its scope until the promise settles; interleaving such blocks is not
 * supported, as browsers have no async context yet.
 */
export function stackStrategy(): AsyncContextStrategy {
  let isolation = new Scope();
  let current = new Scope();
  const run = <T>(enter: () => () => void, cb: () => T): T => {
    const leave = enter();
    let result: T;
    try {
      result = cb();
    } catch (e) {
      leave();
      throw e;
    }
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (result as unknown as Promise<unknown>).finally(leave) as unknown as T;
    }
    leave();
    return result;
  };
  return {
    getIsolationScope: () => isolation,
    getCurrentScope: () => current,
    withScope: (cb) => {
      const prev = current;
      const scope = current.clone();
      return run(
        () => {
          current = scope;
          return () => {
            current = prev;
          };
        },
        () => cb(scope),
      );
    },
    withIsolationScope: (cb) => {
      const prevI = isolation;
      const prevC = current;
      const scope = isolation.clone();
      return run(
        () => {
          isolation = scope;
          current = current.clone();
          return () => {
            isolation = prevI;
            current = prevC;
          };
        },
        () => cb(scope),
      );
    },
  };
}

interface Carrier {
  v: 1;
  globalScope: Scope;
  acs: AsyncContextStrategy;
  client?: unknown;
  instrumented: Record<string, boolean>;
}

/** One slot on the global object, distinct from the upstream SDK's, so both SDKs can share a page. */
export function carrier(): Carrier {
  const g = globalThis as unknown as { __FIXWIRE__?: Carrier };
  g.__FIXWIRE__ ??= { v: 1, globalScope: new Scope(), acs: stackStrategy(), instrumented: {} };
  return g.__FIXWIRE__;
}

/** The process's (or page's) scope: applies to every event. */
export const getGlobalScope = (): Scope => carrier().globalScope;
/** The scope of the current request or task: top-level setTag/setUser write here. */
export const getIsolationScope = (): Scope => carrier().acs.getIsolationScope();
/** The innermost withScope block's scope. */
export const getCurrentScope = (): Scope => carrier().acs.getCurrentScope();
/** Runs `cb` with a forked current scope: what it sets stays inside. */
export const withScope = <T>(cb: (scope: Scope) => T): T => carrier().acs.withScope(cb);
/** Runs `cb` with forked isolation and current scopes, as for a new request or job. */
export const withIsolationScope = <T>(cb: (scope: Scope) => T): T =>
  carrier().acs.withIsolationScope(cb);

/** Installs the runtime's strategy (the Node and browser SDKs do it in init). */
export function setAsyncContextStrategy(acs: AsyncContextStrategy): void {
  carrier().acs = acs;
}

/** Merges the three layers into an event (the event's own fields win) and returns its processors. */
export function applyScopes(event: Event, maxBreadcrumbs: number): EventProcessor[] {
  const layers = [getGlobalScope(), getIsolationScope(), getCurrentScope()];
  const tags: Record<string, string> = {};
  const extra: Record<string, unknown> = {};
  const contexts: Record<string, Record<string, unknown>> = {};
  const user: User = {};
  let level: SeverityLevel | undefined;
  let fingerprint: string[] | undefined;
  const crumbs: Breadcrumb[] = [];
  const processors: EventProcessor[] = [];
  for (const s of layers) {
    Object.assign(tags, s.tags);
    Object.assign(extra, s.extra);
    for (const [k, v] of Object.entries(s.contexts)) contexts[k] = { ...v };
    if (s.user) Object.assign(user, s.user);
    level = s.level ?? level;
    fingerprint = s.fingerprint ?? fingerprint;
    crumbs.push(...s.breadcrumbs);
    processors.push(...s.processors);
  }
  if (Object.keys(tags).length) event.tags = { ...tags, ...event.tags };
  if (Object.keys(extra).length) event.extra = { ...extra, ...event.extra };
  if (Object.keys(contexts).length) event.contexts = { ...contexts, ...event.contexts };
  if (Object.keys(user).length) event.user = { ...user, ...event.user };
  // A level set on a scope wins over the event's default.
  if (level) event.level = level;
  if (fingerprint && !event.fingerprint) event.fingerprint = fingerprint;
  if (crumbs.length) {
    crumbs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    event.breadcrumbs = [...crumbs.slice(-maxBreadcrumbs), ...(event.breadcrumbs ?? [])];
  }
  return processors;
}
