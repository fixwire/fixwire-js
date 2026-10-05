/**
 * The offline store for browsers (opt-in): encoded requests in IndexedDB
 * until the server has them, so events from flaky mobile connections and
 * closed tabs arrive later. Bounded: 100 requests, 5 MB, 72 hours, oldest
 * dropped first. Web Locks keep two tabs from sending the same requests.
 */
import type { ClientOptions, Spool, StoredRequest } from "@fixwire/core";

const STORE = "requests";
const MAX_ITEMS = 100;
const MAX_BYTES = 5 << 20;
const TTL_MS = 72 * 3600 * 1000;

interface Row extends StoredRequest {
  id?: number;
  created: number;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const size = (b: string | Uint8Array): number => (typeof b === "string" ? b.length : b.byteLength);

/**
 * The IndexedDB offline store. Pass it as the `offline` option:
 *
 *   import { makeIndexedDbSpool } from "@fixwire/browser/offline";
 *   Fixwire.init({ dsn, offline: makeIndexedDbSpool });
 */
export function makeIndexedDbSpool(
  _options: ClientOptions,
  dsn: { publicKey: string },
): Spool | undefined {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return undefined;
  let opened: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const r = idb.open(`fixwire-requests-${dsn.publicKey}`, 1);
      r.onupgradeneeded = () =>
        r.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await db()).transaction(STORE, mode).objectStore(STORE);

  const trim = async (): Promise<Row[]> => {
    const rows = (await req((await store("readonly")).getAll())) as Row[];
    const now = Date.now();
    const keep: Row[] = [];
    const drop: number[] = [];
    for (const r of rows) {
      if (now - r.created > TTL_MS) drop.push(r.id as number);
      else keep.push(r);
    }
    let total = keep.reduce((n, r) => n + size(r.body), 0);
    while (keep.length > MAX_ITEMS || (total > MAX_BYTES && keep.length)) {
      const old = keep.shift() as Row;
      total -= size(old.body);
      drop.push(old.id as number);
    }
    if (drop.length) {
      const s = await store("readwrite");
      await Promise.all(drop.map((id) => req(s.delete(id))));
    }
    return keep;
  };

  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;

  return {
    async put(request) {
      const id = await req(
        (await store("readwrite")).add({ ...request, created: Date.now() } satisfies Row),
      );
      await trim();
      return id as number;
    },
    async delete(id) {
      await req((await store("readwrite")).delete(id as number));
    },
    async load() {
      const read = async () =>
        (await trim()).map(({ created: _, id, ...r }) => ({ ...r, id: id as number }));
      if (!locks) return read();
      // Only one tab drains the store; the others leave it alone.
      return locks.request("fixwire-queue", { ifAvailable: true }, (lock) => (lock ? read() : []));
    },
  };
}
