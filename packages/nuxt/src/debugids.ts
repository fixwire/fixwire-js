// Debug ids for the browser build, stamped while Nuxt builds: Nitro records
// each public file's size and etag when it builds the server, so files
// changed afterwards (by `fixwire-cli sourcemaps inject`) would be served
// cut short. Same snippet and ids as fixwire-cli (protocol/PROTOCOL.md §10).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const snippet = (id: string): string =>
  `;(function(){try{var g=typeof globalThis!=="undefined"?globalThis:typeof window!=="undefined"?window:` +
  `typeof self!=="undefined"?self:{};var s=new g.Error().stack;if(s){g._fixwireDebugIds=g._fixwireDebugIds||{};` +
  `g._fixwireDebugIds[s]="${id}"}}catch(e){}})();`;

const DEBUG_ID = /^\/\/# debugId=[0-9a-fA-F-]{36}\s*$/m;
const MAP_URL = /^\/\/[#@] sourceMappingURL=(\S+)\s*$/m;

/** A UUID (version 4 layout) from the file's content, as fixwire-cli derives it. */
export function debugIdFor(content: string): string {
  const b = createHash("sha256").update(content).digest().subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Stamps each JavaScript file under `dir` that has a source map: the
 * snippet on a line of its own before the code (so the map's lines move down
 * by one and nothing else changes), a `//# debugId=` comment, and the id in
 * the map. Files stamped before, with a directive prologue or a hashbang
 * (which must stay first), or whose map is outside `dir` are left alone.
 * Returns how many it stamped.
 */
export function stampDebugIds(dir: string): number {
  const root = resolve(dir);
  let stamped = 0;
  for (const name of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!name.isFile() || !/\.m?js$/.test(name.name)) continue;
    // parentPath arrived in Node.js 20.12; path is its older name.
    const parent = name.parentPath ?? (name as { path?: string }).path ?? root;
    const file = join(parent, name.name);
    const code = readFileSync(file, "utf8");
    if (DEBUG_ID.test(code) || /^\s*(#!|["'])/.test(code)) continue;
    const ref = MAP_URL.exec(code)?.[1];
    if (ref?.startsWith("data:")) continue;
    const map = resolve(dirname(file), ref ? decodeURIComponent(ref) : `${name.name}.map`);
    if (relative(root, map).startsWith("..") || !existsSync(map)) continue;
    let parsed: { mappings?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(readFileSync(map, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed.mappings !== "string") continue;
    const id = debugIdFor(code);
    const end = code.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${snippet(id)}\n${code}${end}//# debugId=${id}\n`);
    writeFileSync(
      map,
      JSON.stringify({ ...parsed, mappings: `;${parsed.mappings}`, debug_id: id, debugId: id }),
    );
    stamped++;
  }
  return stamped;
}
