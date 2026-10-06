/**
 * Turns values into JSON-safe data within limits: strings capped at
 * maxValueLength, containers capped in depth and breadth, cycles cut,
 * undefined properties left out, and everything else (functions, errors,
 * DOM nodes, bigints) described. Objects walked are capped too, so shared
 * references can't make it exponential, and one that throws (a proxy, a
 * getter) is "[Unreadable]".
 */
const MAX_DEPTH = 10;
const MAX_BREADTH = 100;
const MAX_OBJECTS = 10_000;

export function clip(s: string, limit: number): string {
  return limit && s.length > limit ? `${s.slice(0, Math.max(0, limit - 3))}...` : s;
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
      if (v !== undefined) out[key] = next(v);
    }
    return out;
  } catch {
    return "[Unreadable]";
  } finally {
    seen.delete(obj);
  }
}
