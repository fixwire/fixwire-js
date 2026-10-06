/**
 * Turns values into JSON-safe data within limits: strings capped in UTF-8
 * bytes, containers capped in depth and breadth, cycles cut, undefined
 * properties left out, and everything else (functions, errors, DOM nodes,
 * bigints) described. Objects walked are capped too, so shared references
 * can't make it exponential, and one that throws (a proxy, a getter) is
 * "[Unreadable]".
 *
 * Strings are cut twice: first to what redaction reads (ahead: the part
 * kept and the next 16 kB, so a secret the cut goes through is found
 * whole), then, once redacted, to maxValueLength (clipStrings).
 */
const MAX_DEPTH = 10;
const MAX_BREADTH = 100;
const MAX_OBJECTS = 10_000;

/**
 * At most `limit` bytes of UTF-8 (0: no limit), cut on a character boundary
 * and ending in "..." (within the limit).
 */
export function clip(s: string, limit: number): string {
  if (!limit || s.length * 3 <= limit) return s; // a UTF-16 unit is at most 3 bytes
  let bytes = 0;
  let keep = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // A surrogate pair is 4 bytes; a lone surrogate 3, as U+FFFD.
    if ((c & 0xfc00) === 0xd800 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes <= limit - 3) keep = i + 1;
    if (bytes > limit) return s.slice(0, keep) + "...".slice(0, limit);
  }
  return s;
}

/** What redaction reads of a string cut to `limit`: the part kept and the next 16 kB. */
export const ahead = (limit: number): number => (limit ? limit + (16 << 10) : 0);

/** Every string of JSON-like data, keys too, cut to `limit` bytes, in place. */
export function clipStrings(v: unknown, limit: number): unknown {
  if (typeof v === "string") return clip(v, limit);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const value = clipStrings(o[k], limit);
      const key = Array.isArray(o) ? k : clip(k, limit);
      if (key !== k) delete o[k];
      o[key] = value;
    }
  }
  return v;
}

export function normalize(
  value: unknown,
  maxValueLength = 1024,
  depth = 0,
  seen = new WeakSet<object>(),
  budget = { objects: MAX_OBJECTS },
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return clip(value, maxValueLength);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "<anonymous>"}]`;
  const obj = value as object;
  if (seen.has(obj)) return "[Circular ~]";
  seen.add(obj);
  try {
    if (depth >= MAX_DEPTH || budget.objects-- <= 0)
      return Array.isArray(obj) ? "[Array]" : "[Object]";
    if (obj instanceof Date)
      return Number.isNaN(obj.getTime()) ? "[Invalid Date]" : obj.toISOString();
    if (obj instanceof Error) return { name: obj.name, message: clip(obj.message, maxValueLength) };
    const tag = Object.prototype.toString.call(obj);
    if (/^\[object HTML\w*Element\]$/.test(tag)) return `[${tag.slice(8, -1)}]`;
    const next = (v: unknown): unknown => normalize(v, maxValueLength, depth + 1, seen, budget);
    if (Array.isArray(obj)) return obj.slice(0, MAX_BREADTH).map(next);
    if (obj instanceof Map)
      return normalize(Object.fromEntries(obj), maxValueLength, depth, seen, budget);
    if (obj instanceof Set) return normalize([...obj], maxValueLength, depth, seen, budget);
    const out: Record<string, unknown> = {};
    let n = 0;
    // A typed array (a Buffer) has a key per byte: only those kept are listed.
    const view = ArrayBuffer.isView(obj) && (obj as Uint8Array).subarray?.(0, MAX_BREADTH);
    for (const key of Object.keys(view || obj)) {
      if (n++ >= MAX_BREADTH) break;
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[key];
      } catch {
        v = "[Unreadable]";
      }
      if (v !== undefined) out[clip(key, maxValueLength)] = next(v);
    }
    return out;
  } catch {
    return "[Unreadable]";
  } finally {
    seen.delete(obj);
  }
}
