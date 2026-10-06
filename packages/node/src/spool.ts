/**
 * The offline spool for Node (opt-in): one file per encoded request (a
 * line of JSON saying where it goes, then its body) in a directory per
 * DSN, written atomically (temp file, then rename). Bounded:
 * 1,000 files, 50 MB, 72 hours, oldest dropped first. One process owns a
 * spool at a time (a lock file with its PID); others run without one.
 * Directories are private to the user (0700) and files to the owner (0600).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ClientOptions, Spool, StoredRequest } from "@fixwire/core";

const MAX_FILES = 1000;
const MAX_BYTES = 50 << 20;
const TTL_MS = 72 * 3600 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the directory's lock, or returns false when a live process holds it. */
function lock(dir: string): boolean {
  const file = join(dir, "lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      process.once("exit", () => rmSync(file, { force: true }));
      return true;
    } catch {
      const pid = Number(readFileSync(file, "utf8")) || 0;
      if (pid === process.pid) return true;
      if (alive(pid)) return false;
      rmSync(file, { force: true }); // a stopped process's lock
    }
  }
  return false;
}

/**
 * Whether a directory under the shared temp directory is this user's own (not
 * another user's, nor a link to elsewhere), made private if it is.
 */
function ours(path: string): boolean {
  const s = lstatSync(path);
  if (!s.isDirectory() || (process.getuid && s.uid !== process.getuid())) return false;
  chmodSync(path, 0o700);
  return true;
}

export function makeFileSpool(
  options: ClientOptions,
  dsn: { publicKey: string; baseUrl: string },
): Spool | undefined {
  const shared = typeof options.offline !== "string";
  const dir = shared
    ? join(
        tmpdir(),
        "fixwire",
        createHash("sha256").update(`${dsn.publicKey}@${dsn.baseUrl}`).digest("hex").slice(0, 16),
      )
    : (options.offline as string);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (shared && !(ours(dirname(dir)) && ours(dir))) return undefined;
    if (!lock(dir)) return undefined;
  } catch {
    return undefined;
  }

  // The files, oldest first (names start with the time they were written),
  // with their sizes: read from the directory once, then kept up to date, so
  // a put costs no directory scan.
  let total = 0;
  let index: Promise<Map<string, number>> | undefined;
  const files = (): Promise<Map<string, number>> => {
    index ??= (async () => {
      const found = new Map<string, number>();
      for (const name of (await readdir(dir)).filter((n) => n.endsWith(".req")).sort()) {
        const s = await stat(join(dir, name)).catch(() => undefined);
        if (!s) continue;
        found.set(name, s.size);
        total += s.size;
      }
      return found;
    })();
    return index;
  };
  const forget = async (name: string): Promise<void> => {
    const found = await files();
    total -= found.get(name) ?? 0;
    found.delete(name);
    await rm(join(dir, name), { force: true });
  };

  const trim = async (): Promise<void> => {
    const found = await files();
    const now = Date.now();
    for (const name of found.keys()) {
      const fresh = now - Number(name.slice(0, 15)) <= TTL_MS;
      if (fresh && found.size <= MAX_FILES && total <= MAX_BYTES) break;
      await forget(name);
    }
  };

  return {
    async put({ body, ...meta }) {
      const found = await files();
      const name = `${Date.now().toString().padStart(15, "0")}-${randomBytes(4).toString("hex")}.req`;
      const head = Buffer.from(`${JSON.stringify(meta)}\n`);
      const data = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
      const tmp = join(dir, `${name}.tmp`);
      await writeFile(tmp, Buffer.concat([head, data]), { mode: 0o600 });
      await rename(tmp, join(dir, name));
      found.set(name, head.byteLength + data.byteLength);
      total += head.byteLength + data.byteLength;
      await trim();
      return name;
    },
    async delete(id) {
      await forget(String(id));
    },
    async load() {
      await trim();
      const out = [];
      for (const name of [...(await files()).keys()]) {
        const raw = await readFile(join(dir, name)).catch(() => undefined);
        if (!raw) continue;
        const nl = raw.indexOf(10);
        try {
          const meta = JSON.parse(raw.subarray(0, nl).toString("utf8")) as Omit<
            StoredRequest,
            "body"
          >;
          // Sent to the DSN's base URL plus this path: a path, never another host.
          if (typeof meta.path !== "string" || !meta.path.startsWith("/"))
            throw new Error("not a path");
          out.push({ ...meta, id: name, body: new Uint8Array(raw.subarray(nl + 1)) });
        } catch {
          await forget(name);
        }
      }
      return out;
    },
  };
}
