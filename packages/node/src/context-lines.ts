/**
 * Source lines around in-app frames, read asynchronously and cached. Lines
 * are sent whole: the client cuts them to maxValueLength after redaction.
 */
import { readFile, stat } from "node:fs/promises";

import type { Event } from "@fixwire/core";

const LINES = 5;
/** What the cache keeps at most: files, and their bytes. */
const MAX_FILES = 64;
const MAX_CACHE_BYTES = 32 << 20;
/** Larger files (bundles, data) get no context lines. */
const MAX_FILE_BYTES = 10 << 20;
const cache = new Map<string, { lines: string[] | null; bytes: number }>();
let cachedBytes = 0;

/** What the cache holds (for tests). */
export const cached = (): { files: number; bytes: number } => ({
  files: cache.size,
  bytes: cachedBytes,
});

async function linesOf(path: string): Promise<string[] | null> {
  const hit = cache.get(path);
  if (hit) return hit.lines;
  let lines: string[] | null = null;
  let bytes = 0;
  try {
    // A frame's path is text an error message can fake: only a regular,
    // non-empty file of a source file's size is read, never a device, a
    // FIFO or a /proc file (they report no size).
    const s = await stat(path);
    if (s.isFile() && s.size > 0 && s.size <= MAX_FILE_BYTES) {
      lines = (await readFile(path, "utf8")).split(/\r?\n/);
      bytes = s.size;
    }
  } catch {
    lines = null;
  }
  if (cache.has(path)) return lines; // read twice at once: cached already
  cache.set(path, { lines, bytes });
  cachedBytes += bytes;
  for (const [key, old] of cache) {
    if (cache.size <= MAX_FILES && cachedBytes <= MAX_CACHE_BYTES) break;
    cache.delete(key);
    cachedBytes -= old.bytes;
  }
  return lines;
}

export async function addContextLines(event: Event): Promise<void> {
  for (const ex of event.exception?.values ?? []) {
    for (const f of ex.stacktrace?.frames ?? []) {
      if (
        !f.in_app ||
        !f.filename ||
        !f.lineno ||
        f.context_line !== undefined ||
        f.filename.startsWith("node:")
      )
        continue;
      const lines = await linesOf(f.filename);
      const i = f.lineno - 1;
      if (!lines || i < 0 || i >= lines.length) continue;
      f.pre_context = lines.slice(Math.max(0, i - LINES), i);
      f.context_line = lines[i] as string;
      f.post_context = lines.slice(i + 1, i + 1 + LINES);
    }
  }
}
