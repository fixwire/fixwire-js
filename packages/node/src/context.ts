/** Isolation and current scopes per async context, with AsyncLocalStorage. */
import { AsyncLocalStorage } from "node:async_hooks";

import { type AsyncContextStrategy, Scope, setAsyncContextStrategy } from "@fixwire/core";

interface Scopes {
  isolation: Scope;
  current: Scope;
}

const storage = new AsyncLocalStorage<Scopes>();
const root: Scopes = { isolation: new Scope(), current: new Scope() };
const get = (): Scopes => storage.getStore() ?? root;

const strategy: AsyncContextStrategy = {
  getIsolationScope: () => get().isolation,
  getCurrentScope: () => get().current,
  withScope: (cb) => {
    const s = get();
    const scope = s.current.clone();
    return storage.run({ isolation: s.isolation, current: scope }, () => cb(scope));
  },
  withIsolationScope: (cb) => {
    const s = get();
    const isolation = s.isolation.clone();
    return storage.run({ isolation, current: s.current.clone() }, () => cb(isolation));
  },
};

export function useAsyncLocalStorage(): void {
  setAsyncContextStrategy(strategy);
}

/** Forks the scopes for the rest of the current async context (a request). */
export function enterIsolationScope(): void {
  const s = get();
  storage.enterWith({ isolation: s.isolation.clone(), current: s.current.clone() });
}
