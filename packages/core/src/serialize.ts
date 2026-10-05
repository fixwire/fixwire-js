/**
 * Turns values into JSON-safe data within limits: strings capped at
 * maxValueLength, containers capped in depth and breadth, cycles cut,
 * undefined properties left out, and everything else (functions, errors,
 * DOM nodes, bigints) described.
 */
const MAX_DEPTH = 10;
const MAX_BREADTH = 100;

export function clip(s: string, limit: number): string {
  return limit && s.length > limit ? `${s.slice(0, Math.max(0, limit - 3))}...` : s;
}

export function normalize(
  value: unknown,
  maxValueLength = 1024,
  depth = 0,
  seen = new WeakSet<object>(),
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
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? "[Array]" : "[Object]";
  if (obj instanceof Date)
    return Number.isNaN(obj.getTime()) ? "[Invalid Date]" : obj.toISOString();
  if (obj instanceof Error) return { name: obj.name, message: clip(obj.message, maxValueLength) };
  const tag = Object.prototype.toString.call(obj);
  if (/^\[object HTML\w*Element\]$/.test(tag)) return `[${tag.slice(8, -1)}]`;
  seen.add(obj);
  try {
    if (Array.isArray(obj))
      return obj.slice(0, MAX_BREADTH).map((v) => normalize(v, maxValueLength, depth + 1, seen));
    if (obj instanceof Map) return normalize(Object.fromEntries(obj), maxValueLength, depth, seen);
    if (obj instanceof Set) return normalize([...obj], maxValueLength, depth, seen);
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const key of Object.keys(obj)) {
      if (n++ >= MAX_BREADTH) break;
      let v: unknown;
      try {
        v = (obj as Record<string, unknown>)[key];
      } catch {
        v = "[Unreadable]";
      }
      if (v !== undefined) out[key] = normalize(v, maxValueLength, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
