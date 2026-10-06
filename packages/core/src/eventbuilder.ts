/** Events from errors and other thrown values, with causes and AggregateErrors. */
import { normalize } from "./serialize.ts";
import type { Event, EventHint, Exception, Mechanism, StackParser } from "./types.ts";

type DebugImage = { type: string; code_file: string; debug_id: string };

/** Bundle file → debug id, parsed once per set of registered bundles. */
let debugIds: [number, Record<string, string>] | undefined;

/**
 * Source map debug ids of the bundles in an event's stack (sdks/PROTOCOL.md
 * §10). fixwire-cli injects into each bundle a line that registers it in
 * `globalThis._fixwireDebugIds`: the stack at that line, mapped to the
 * bundle's debug id. That stack's newest frame names the bundle's file.
 */
export function debugImages(parser: StackParser, event: Event): DebugImage[] | undefined {
  const ids = (globalThis as { _fixwireDebugIds?: Record<string, string> })._fixwireDebugIds;
  if (!ids) return undefined;
  const stacks = Object.keys(ids);
  if (debugIds?.[0] !== stacks.length) {
    const byFile: Record<string, string> = {};
    for (const stack of stacks) {
      const file = parser(stack)
        .reverse()
        .find((f) => f.filename)?.filename;
      if (file) byFile[file] = ids[stack] as string;
    }
    debugIds = [stacks.length, byFile];
  }
  const byFile = debugIds[1];
  const images: DebugImage[] = [];
  for (const v of event.exception?.values ?? []) {
    for (const f of v.stacktrace?.frames ?? []) {
      const id = f.filename && byFile[f.filename];
      if (id && !images.some((i) => i.code_file === f.filename))
        images.push({ type: "sourcemap", code_file: f.filename as string, debug_id: id });
    }
  }
  return images.length ? images : undefined;
}

/** Exceptions in one event: the one thrown, its causes and grouped errors. */
const MAX_EXCEPTIONS = 10;

/** An error's exception value, with at most `maxFrames` frames (the newest). */
export function exceptionFromError(parser: StackParser, err: Error, maxFrames?: number): Exception {
  const ex: Exception = { type: err.name || err.constructor?.name || "Error", value: err.message };
  // V8 stacks start with "name: message". The message is no frames, and its
  // lines may be anyone's text (input): fake frames, or lines slow to parse.
  const frames = err.stack
    ? parser(err.stack.replace(`: ${err.message}\n`, ":\n"), 0, 0, maxFrames)
    : [];
  if (frames.length) ex.stacktrace = { frames };
  return ex;
}

const isError = (v: unknown): v is Error =>
  v instanceof Error ||
  (typeof v === "object" &&
    v !== null &&
    typeof (v as Error).message === "string" &&
    typeof (v as Error).stack === "string");

/**
 * The exception values of an error and its causes (oldest last raised
 * first, as the protocol wants): at most MAX_EXCEPTIONS, the chain cut
 * where it comes back to one already in it.
 */
export function exceptionsFromError(
  parser: StackParser,
  err: Error,
  mechanism: Mechanism,
  maxFrames?: number,
): Exception[] {
  const out: Exception[] = [];
  const seen = new Set<unknown>();
  let id = 0;
  const visit = (e: Error, source: string | undefined, parentId: number | undefined): void => {
    if (seen.has(e) || out.length >= MAX_EXCEPTIONS) return;
    seen.add(e);
    const ex = exceptionFromError(parser, e, maxFrames);
    const myId = id++;
    ex.mechanism = { ...mechanism, exception_id: myId };
    if (parentId !== undefined) {
      ex.mechanism.type = "chained";
      ex.mechanism.parent_id = parentId;
      if (source) ex.mechanism.source = source;
    }
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors)) ex.mechanism.is_exception_group = true;
    out.push(ex);
    if (isError(e.cause)) visit(e.cause, "cause", myId);
    if (Array.isArray(errors)) {
      for (let i = 0; i < errors.length && out.length < MAX_EXCEPTIONS; i++)
        if (isError(errors[i])) visit(errors[i], `errors[${i}]`, myId);
    }
  };
  visit(err, undefined, undefined);
  return out.reverse();
}

/** An event for anything thrown or rejected. */
export function eventFromUnknown(
  parser: StackParser,
  value: unknown,
  hint: EventHint,
  mechanism: Mechanism,
  maxValueLength: number,
  maxFrames?: number,
): Event {
  if (isError(value)) {
    return {
      level: "error",
      exception: { values: exceptionsFromError(parser, value, mechanism, maxFrames) },
    };
  }
  // Not an error: describe it, with the stack of where it was captured.
  const ex: Exception = { type: "Error", mechanism: { ...mechanism, synthetic: true } };
  const event: Event = { level: "error", exception: { values: [ex] } };
  if (typeof value === "string") {
    ex.value = value;
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const ctor = (value as object).constructor?.name;
    ex.type = ctor && ctor !== "Object" ? ctor : "Error";
    ex.value = keys.length
      ? `Object captured as exception with keys: ${keys.slice(0, 10).join(", ")}`
      : `${ex.type} captured as exception`;
    event.extra = { __serialized__: normalize(value, maxValueLength, 3) };
  } else {
    ex.value = `Non-Error value captured as exception: ${String(value)}`;
  }
  const synthetic = hint.syntheticException?.stack;
  if (synthetic) {
    const frames = parser(synthetic, 1, 0, maxFrames);
    if (frames.length) ex.stacktrace = { frames };
  }
  return event;
}
