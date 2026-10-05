/** Source lines around in-app frames, read asynchronously and cached. */
import { readFile } from "node:fs/promises";

import type { Event } from "@fixwire/core";

const LINES = 5;
const MAX_FILES = 100;
const MAX_LINE = 200;
const cache = new Map<string, string[] | null>();

async function linesOf(path: string): Promise<string[] | null> {
  if (cache.has(path)) return cache.get(path) ?? null;
  let lines: string[] | null = null;
  try {
    lines = (await readFile(path, "utf8")).split(/\r?\n/);
  } catch {
    lines = null;
  }
  if (cache.size >= MAX_FILES) cache.delete(cache.keys().next().value as string);
  cache.set(path, lines);
  return lines;
}

const clip = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}...` : s);

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
      f.pre_context = lines.slice(Math.max(0, i - LINES), i).map(clip);
      f.context_line = clip(lines[i] as string);
      f.post_context = lines.slice(i + 1, i + 1 + LINES).map(clip);
    }
  }
}
