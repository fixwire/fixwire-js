// Ported (MIT) from upstream packages/browser/src/stack-parsers.ts; copyright and provenance: NOTICE, UPSTREAM.md. Modified for Fixwire: the
// Opera 10/11 and WinJS parsers are dropped, and the gecko expression is a scan linear in the line.
//
// This was originally forked from https://github.com/csnover/TraceKit, and was largely
// re - written as part of raven - js.
//
// This code was later copied to the JavaScript mono - repo and further modified and
// refactored over the years.

// Copyright (c) 2013 Onur Can Cakmak onur.cakmak@gmail.com and all TraceKit contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files(the 'Software'), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify,
// merge, publish, distribute, sublicense, and / or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following
// conditions:
//
// The above copyright notice and this permission notice shall be included in all copies
// or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
// OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { StackFrame, StackLineParser, StackLineParserFn } from "@fixwire/core";
import { createStackParser, UNKNOWN_FUNCTION } from "@fixwire/core";

// Fixwire: takes the captures as they are (an empty function is unknown, an empty line or column
// unset), and does what upstream's extractSafariExtensionDetails did for both parsers: Safari web
// extensions can give "frames-only" stacks (`function@url:row:col` lines, no `Error: wat` line
// before them), which fall into the gecko parser.
function createFrame(func: string, filename: string, lineno?: string, colno?: string): StackFrame {
  let name = func || UNKNOWN_FUNCTION;
  const extension = ["safari-extension", "safari-web-extension"].find((e) => name.includes(e));
  if (extension) {
    name = name.includes("@") ? (name.split("@")[0] as string) : UNKNOWN_FUNCTION;
    filename = `${extension}:${filename}`;
  }
  const frame: StackFrame = {
    filename,
    function: name === "<anonymous>" ? UNKNOWN_FUNCTION : name,
    in_app: true, // All browser frames are considered in_app
  };

  if (lineno) {
    frame.lineno = +lineno;
  }

  if (colno) {
    frame.colno = +colno;
  }

  return frame;
}

// This regex matches frames that have no function name (ie. are at the top level of a module).
// For example "at http://localhost:5000//script.js:1:126"
// Frames _with_ function names usually look as follows: "at commitLayoutEffects (react-dom.development.js:23426:1)"
const chromeRegexNoFnName = /^\s*at (\S+?)(?::(\d+))(?::(\d+))\s*$/i;

// This regex matches all the frames that have a function name.
const chromeRegex =
  /^\s*at (?:(.+?\)(?: \[.+\])?|.*?) ?\((?:address at )?)?(?:async )?((?:<anonymous>|[-a-z]+:|.*bundle|\/)?.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i;

const chromeEvalRegex = /\((\S*)(?::(\d+))(?::(\d+))\)/;

// Matches stack frames with data URIs instead of filename so we can still get the function name
// Example: "at dynamicFn (data:application/javascript,export function dynamicFn() {..."
const chromeDataUriRegex = /at (.+?) ?\(data:(.+?),/;

// Chromium based browsers: Chrome, Brave, new Opera, new Edge
// We cannot call this variable `chrome` because it can conflict with global `chrome` variable in certain environments
const chromeStackParserFn: StackLineParserFn = (line) => {
  const dataUriMatch = line.match(chromeDataUriRegex);
  if (dataUriMatch) {
    return {
      filename: `<data:${dataUriMatch[2]}>`,
      function: dataUriMatch[1],
    };
  }

  // If the stack line has no function name, we need to parse it differently
  const noFnParts = chromeRegexNoFnName.exec(line) as null | [string, string, string, string];

  if (noFnParts) {
    return createFrame("", noFnParts[1], noFnParts[2], noFnParts[3]);
  }

  const parts = chromeRegex.exec(line) as null | [string, string, string, string, string];

  if (parts) {
    const isEval = parts[2]?.startsWith("eval"); // start of line

    if (isEval) {
      const subMatch = chromeEvalRegex.exec(parts[2]) as null | [string, string, string, string];

      if (subMatch) {
        // throw out eval line/column and use top-most line/column number
        parts[2] = subMatch[1]; // url
        parts[3] = subMatch[2]; // line
        parts[4] = subMatch[3]; // column
      }
    }

    return createFrame(parts[1], parts[2], parts[3], parts[4]);
  }

  return;
};

// Priorities, lowest tried first: chrome 30, gecko 50.
export const chromeStackLineParser: StackLineParser = [30, chromeStackParserFn];

// gecko: Fixwire scans the trimmed line once, from the right, for the captures of the expression it
// ran (all but the second, which nothing reads), which backtracked polynomially (seconds on 1 KB of
// parentheses):
//   /^(.*?)(?:\((.*?)\))?(?:^|@)?((?:[-a-z]+)?:\/.*?|\[native code\]|[^@]*(?:bundle|\d\.js)|\/[\w\-. /=]+)(?::(\d+))?(?::(\d+))?$/i
// `bundle` is for react native, `\d\.js` for its ram bundles, whose filenames have no prefix (42.js).
// Group 3 always ends where `(?::(\d+))?(?::(\d+))?$` first matches: `.*?` stops there, `[\w\-. /=]+`
// takes no `:`, and `bundle`, `\d\.js` or `[native code]` end in no digit, unlike any later place.
// The eval expression has the captures of upstream's `/(\S+) line (\d+)(?: > eval line \d+)* > eval/i`
// (`\S+` takes whole words; ` > eval` follows the digits), but starts only where a word does.
const geckoEvalRegex = /(^|\s)(\S+) line (\d+) > eval/i;

const gecko: StackLineParserFn = (line) => {
  const s = line.trim();
  // The line and column start at `end`, with a `[native code]` (13 characters), `bundle` or
  // `\d\.js` right before at `at`. (Each start tries a few characters and the digits after it.)
  const tail = /(\[native code\]|bundle|\d\.js)?(?::(\d+))?(?::(\d+))?$/i.exec(
    s,
  ) as RegExpExecArray;
  const at = tail.index;
  const end = at + (tail[1] || "").length;
  // At p: url says whether `[-a-z]*:\/` matches at p, path whether `\[native code\]` or
  // `[^@]*(?:bundle|\d\.js)` takes p to the end, word whether `[\w\-. /=]*` takes p + 1 to it, nl
  // whether a line terminator (which `.` doesn't take) follows. H is where group 3 starts after
  // `@?` at p, plus one (falsy: nowhere): p if one of its forms takes p to the end; after an `@`,
  // p + 1 if it starts there (h, H at p + 1; it never starts at an `@`). close is H after the
  // first `)` from p + 1 that has one; i and start are the match with the shortest group 1 so far.
  // Groups 1 and 2 take no line terminator: there, both start over.
  let url: boolean | undefined;
  let path: boolean | undefined;
  let word = true;
  let nl: number | undefined;
  let h: number | false | undefined;
  let close: number | false | undefined;
  let i = -1;
  let start: number | undefined;
  for (let p = end; p--; ) {
    const c = s[p] as string;
    url = /[-a-z]/i.test(c) ? url : s.startsWith(":/", p);
    path = p === at || (path && c !== "@" && end - at < 13);
    const H =
      c === "@"
        ? h === p + 2 && h
        : ((url && !nl) || path || (c === "/" && word && p + 1 < end)) && p + 1;
    if (!/./.test(c)) {
      nl = i = -1;
      close = 0;
    }
    const m = (c === "(" && close) || H;
    if (m) {
      i = p;
      start = m - 1;
    }
    if (c === ")" && h) close = h;
    word &&= /[\w\-. /=]/.test(c);
    h = H;
  }
  if (i < 0) return;
  const func = s.slice(0, i);
  const filename = s.slice(start, end);
  const subMatch = filename.includes(" > eval") && geckoEvalRegex.exec(filename);

  // throw out eval line/column and use top-most line number
  return subMatch
    ? createFrame(func || "eval", subMatch[2] as string, subMatch[3])
    : createFrame(func, filename, tail[2], tail[3]);
};

export const geckoStackLineParser: StackLineParser = [50, gecko];

export const defaultStackLineParsers = [chromeStackLineParser, geckoStackLineParser];

export const defaultStackParser = createStackParser(...defaultStackLineParsers);
