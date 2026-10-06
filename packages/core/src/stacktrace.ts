// Ported (MIT) from upstream packages/core/src/utils/stacktrace.ts; copyright and provenance: NOTICE, UPSTREAM.md. Modified for Fixwire: our
// own API frames are stripped, Vue helpers dropped.
import type { StackFrame, StackLineParser, StackParser } from "./types.ts";

const STACKTRACE_FRAME_LIMIT = 100;
export const UNKNOWN_FUNCTION = "?";
// Used to sanitize webpack (error: *) wrapped stack errors
const WEBPACK_ERROR_REGEXP = /\(error: (.*)\)/;
const STRIP_FRAME_REGEXP = /captureMessage|captureException/;

/**
 * Creates a stack parser with the supplied line parsers. Frames come out
 * oldest first, with our own frames removed from the top and bottom: at
 * most `limit`, the newest.
 */
export function createStackParser(...parsers: StackLineParser[]): StackParser {
  const sortedParsers = parsers.sort((a, b) => a[0] - b[0]).map((p) => p[1]);

  return (
    stack: string,
    skipFirstLines: number = 0,
    framesToPop: number = 0,
    limit: number = STACKTRACE_FRAME_LIMIT,
  ): StackFrame[] => {
    const frames: StackFrame[] = [];
    const lines = stack.split("\n");

    for (let i = skipFirstLines; i < lines.length; i++) {
      let line = lines[i] as string;
      // Truncate lines over 1kb because many of the regular expressions use
      // backtracking which results in run time that increases exponentially
      // with input size.
      if (line.length > 1024) {
        line = line.slice(0, 1024);
      }

      // Remove webpack (error: *) wrappers
      const cleanedLine = WEBPACK_ERROR_REGEXP.test(line)
        ? line.replace(WEBPACK_ERROR_REGEXP, "$1")
        : line;

      // Skip Error: lines (includes(), not a regex, to avoid O(n²) backtracking on long lines)
      if (cleanedLine.includes("Error: ")) {
        continue;
      }

      for (const parser of sortedParsers) {
        const frame = parser(cleanedLine);

        if (frame) {
          frames.push(frame);
          break;
        }
      }

      // Lines run newest first: the newest frames are kept.
      if (frames.length >= limit + framesToPop + 2) {
        break;
      }
    }

    return stripSdkFramesAndReverse(frames.slice(framesToPop)).slice(-limit);
  };
}

/**
 * Removes our frames from the top and bottom of the stack. The input is
 * newest first; the result is oldest first, so the frame that raised is last.
 */
export function stripSdkFramesAndReverse(stack: ReadonlyArray<StackFrame>): StackFrame[] {
  if (!stack.length) {
    return [];
  }

  const localStack = Array.from(stack);

  if (/fixwireWrapped/.test(getLastStackFrame(localStack).function || "")) {
    localStack.pop();
  }

  localStack.reverse();

  if (STRIP_FRAME_REGEXP.test(getLastStackFrame(localStack).function || "")) {
    localStack.pop();
    // client.captureException() under the top-level captureException()
    if (STRIP_FRAME_REGEXP.test(getLastStackFrame(localStack).function || "")) {
      localStack.pop();
    }
  }

  return localStack.map((frame) => ({
    ...frame,
    filename: frame.filename || getLastStackFrame(localStack).filename,
    function: frame.function || UNKNOWN_FUNCTION,
  }));
}

function getLastStackFrame(arr: StackFrame[]): StackFrame {
  return arr[arr.length - 1] || {};
}

/** Normalizes stack line paths by removing file:// and the leading slash of Windows paths. */
export function normalizeStackTracePath(path: string | undefined): string | undefined {
  let filename = path?.startsWith("file://") ? path.slice(7) : path;
  // If it's a Windows path, trim the leading slash so that `/C:/foo` becomes `C:/foo`
  if (filename?.match(/\/[A-Z]:/)) {
    filename = filename.slice(1);
  }
  return filename;
}
