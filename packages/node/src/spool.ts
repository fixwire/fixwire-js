/**
 * The offline spool for Node (opt-in): one file per encoded request (a
 * line of JSON saying where it goes, then its body) in a directory per
 * DSN, written atomically (temp file, then rename). Bounded:
 * 1,000 files, 50 MB, 72 hours, oldest dropped first. One process owns a
 * spool at a time (a lock file with its PID); others run without one.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      const fd = openSync(file, "wx");
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

export function makeFileSpool(
  options: ClientOptions,
  dsn: { publicKey: string; baseUrl: string },
): Spool | undefined {
  const dir =
    typeof options.offline === "string"
      ? options.offline
      : join(
          tmpdir(),
          "fixwire",
          createHash("sha256").update(`${dsn.publicKey}@${dsn.baseUrl}`).digest("hex").slice(0, 16),
        );
  try {
    mkdirSync(dir, { recursive: true });
    if (!lock(dir)) return undefined;
  } catch {
    return undefined;
  }

  const trim = async (): Promise<void> => {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".req")).sort();
    const now = Date.now();
    let total = 0;
    const kept: { name: string; size: number }[] = [];
    for (const name of names) {
      const s = await stat(join(dir, name)).catch(() => undefined);
      if (!s) continue;
      if (now - s.mtimeMs > TTL_MS) await rm(join(dir, name), { force: true });
      else kept.push({ name, size: s.size });
    }
    for (const k of kept) total += k.size;
    while (kept.length > MAX_FILES || (total > MAX_BYTES && kept.length)) {
      const old = kept.shift() as { name: string; size: number };
      total -= old.size;
      await rm(join(dir, old.name), { force: true });
    }
  };

  return {
    async put({ body, ...meta }) {
      const name = `${Date.now().toString().padStart(15, "0")}-${randomBytes(4).toString("hex")}.req`;
      const head = Buffer.from(`${JSON.stringify(meta)}\n`);
      const data = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
      const tmp = join(dir, `${name}.tmp`);
      await writeFile(tmp, Buffer.concat([head, data]));
      await rename(tmp, join(dir, name));
      await trim();
      return name;
    },
    async delete(id) {
      await rm(join(dir, String(id)), { force: true });
    },
    async load() {
      await trim();
      const out = [];
      for (const name of (await readdir(dir)).filter((n) => n.endsWith(".req")).sort()) {
        const raw = await readFile(join(dir, name)).catch(() => undefined);
        if (!raw) continue;
        const nl = raw.indexOf(10);
        try {
          const meta = JSON.parse(raw.subarray(0, nl).toString("utf8")) as Omit<
            StoredRequest,
            "body"
          >;
          out.push({ ...meta, id: name, body: new Uint8Array(raw.subarray(nl + 1)) });
        } catch {
          await rm(join(dir, name), { force: true });
        }
      }
      return out;
    },
  };
}
