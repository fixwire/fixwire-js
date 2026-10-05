/** Event and breadcrumb levels, most severe first. */
export type SeverityLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";

/** One frame of a stack trace. */
export interface StackFrame {
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  /** Your code (true) or a library's (false). */
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  vars?: Record<string, unknown>;
}

/** How an error was captured. */
export interface Mechanism {
  /** "generic", "onerror", "onunhandledrejection", "express", "uncaughtException", … */
  type: string;
  /** false for errors nothing caught (they make the event fatal). */
  handled?: boolean;
  /** For nested errors: the property it came from, e.g. "cause" or "errors[0]". */
  source?: string;
  exception_id?: number;
  parent_id?: number;
  is_exception_group?: boolean;
  /** Set when the stack is the SDK's own (the thrown value was not an Error). */
  synthetic?: boolean;
  data?: Record<string, unknown>;
}

/** One error in an event: the thrown one, or one of its causes. */
export interface Exception {
  type?: string;
  value?: string;
  mechanism?: Mechanism;
  /** Frames oldest first: the last frame threw. */
  stacktrace?: { frames?: StackFrame[] };
}

/** Who hit the error. Other keys are kept as user data. */
export interface User {
  id?: string | number;
  email?: string;
  username?: string;
  ip_address?: string;
  [key: string]: unknown;
}

/** A step on the way to an error: a click, a request, a log line. */
export interface Breadcrumb {
  /** e.g. "http", "navigation", "ui", "default". */
  type?: string;
  /** What produced it, e.g. "fetch", "console", "cart". */
  category?: string;
  level?: SeverityLevel;
  message?: string;
  data?: Record<string, unknown>;
  /** Unix seconds (set when missing). */
  timestamp?: number;
}

/** The HTTP request an event happened in. Headers come from an allowlist. */
export interface RequestInfo {
  url?: string;
  method?: string;
  query_string?: string;
  headers?: Record<string, string>;
}

/** An error or message, as sent to Fixwire. */
export interface Event {
  event_id?: string;
  /** Unix seconds. */
  timestamp?: number;
  platform?: string;
  level?: SeverityLevel;
  logger?: string;
  message?: string;
  logentry?: { message?: string; formatted?: string; params?: unknown[] };
  /** Errors oldest first: the last one is the error that was thrown. */
  exception?: { values?: Exception[] };
  /** The route, task or page the event happened in. */
  transaction?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
  user?: User;
  breadcrumbs?: Breadcrumb[];
  /** Overrides grouping: events with the same fingerprint are one issue. */
  fingerprint?: string[];
  release?: string;
  environment?: string;
  dist?: string;
  server_name?: string;
  request?: RequestInfo;
  sdk?: { name: string; version: string; packages?: { name: string; version: string }[] };
  /** Source map debug ids of the bundles in the stack. */
  debug_meta?: { images?: { type: string; code_file: string; debug_id: string }[] };
}

/**
 * Feedback: how someone rated an answer (an agent run's, by its trace)
 * and/or what they said about a crash (by its event). A negative rating
 * opens a user_feedback issue for the agent.
 */
export interface Feedback {
  /** What the person said. */
  message?: string;
  /** -1 to 1: below 0 negative (thumbs down is -1), above 0 positive (thumbs up is 1). */
  score?: number;
  /**
   * The trace that produced the answer being rated, e.g. the one your
   * backend sent back with it. Defaults to the current trace.
   */
  traceId?: string;
  /** The event it is about, e.g. lastEventId() after a crash. */
  eventId?: string;
  /** The page it was given on (default in browsers: the current page). */
  url?: string;
  /** Where it came from, e.g. "thumbs" or "widget" (default "api"). */
  source?: string;
}

/** A scheduled job's run, reported to its monitor (sdks/PROTOCOL.md §6). */
export interface CheckIn {
  /** The monitor's slug, e.g. `"nightly-report"`. */
  monitorSlug: string;
  /** `in_progress` when the job starts, then `ok` or `error`. */
  status: "in_progress" | "ok" | "error";
  /** The id of the `in_progress` check-in this one ends (captureCheckIn returned it). */
  checkInId?: string | undefined;
  /** How long the job ran, in seconds. */
  duration?: number;
}

/** Creates or updates the monitor a check-in reports to. */
export interface MonitorConfig {
  schedule:
    | { type: "crontab"; value: string }
    | {
        type: "interval";
        value: number;
        unit: "minute" | "hour" | "day" | "week" | "month" | "year";
      };
  /** Minutes a check-in may be late before it counts as missed. */
  checkinMargin?: number;
  /** Minutes a run may take before it counts as failed. */
  maxRuntime?: number;
  /** The schedule's time zone, e.g. `"Europe/Berlin"` (default UTC). */
  timezone?: string;
}

/** What a captured event came from; beforeSend and processors receive it. */
export interface EventHint {
  /** The value passed to captureException (or thrown). */
  originalException?: unknown;
  /** An Error made by the SDK, for a stack when the thrown value has none. */
  syntheticException?: Error;
  mechanism?: Mechanism;
  [key: string]: unknown;
}

/** Parses one line of an `Error.stack`; undefined when it doesn't match. */
export type StackLineParserFn = (line: string) => StackFrame | undefined;
/** A stack line parser with its priority (lower runs first). */
export type StackLineParser = [number, StackLineParserFn];
/** Turns an `Error.stack` into frames, oldest first. */
export type StackParser = (
  stack: string,
  skipFirstLines?: number,
  framesToPop?: number,
) => StackFrame[];
