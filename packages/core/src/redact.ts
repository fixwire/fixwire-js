/**
 * Client-side redaction: a port of the Fixwire server's scrubber
 * (pkg/redact in fixwire/fixwire) with identical output, proven by the shared corpus
 * pkg/redact/testdata/vectors.json.
 *
 * Patterns are ASCII-only like Go's RE2: no `u` flag (so `\b` and `\d`
 * stay ASCII) and whitespace classes spelled out (RE2's `\s` has no `\v`).
 */

export const FILTERED = "[Filtered]";

export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "accesskey",
  "token",
  "credential",
  "privatekey",
  "authorization",
  "cookie",
  "sessionid",
  "csrf",
  "xsrf",
  "cvv",
  "cvc",
  "ssn",
  "creditcard",
  "cardnumber",
];

export interface Finding {
  detector: string;
  start: number;
  end: number;
}

type Span = [number, number];

interface Detector {
  name: string;
  prefilter?: string[];
  caseSensitive?: boolean;
  re?: RegExp;
  group?: number;
  validate?: (s: string) => boolean;
  scan?: (s: string) => Span[];
  may?: (s: string) => boolean;
  /** The group's least length in code points, where the pattern counts UTF-16 units. */
  minCodePoints?: number;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isAlpha = (c: number): boolean => isUpper(c) || (c >= 97 && c <= 122);
const isWord = (c: number): boolean => c === 95 || isDigit(c) || isAlpha(c);

function digits(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) if (isDigit(s.charCodeAt(i))) out += s[i];
  return out;
}

const CARD_PREFIXES = [
  "4",
  "51",
  "52",
  "53",
  "54",
  "55",
  "2221",
  "2720",
  "34",
  "37",
  "6011",
  "65",
  "35",
  "36",
  "38",
  "300",
  "305",
  "62",
];

function validCard(s: string): boolean {
  const d = digits(s);
  if (d.length < 13 || d.length > 19 || !CARD_PREFIXES.some((p) => d.startsWith(p))) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function validIBAN(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const c = rearranged.charCodeAt(i);
    let chunk: string;
    if (isDigit(c)) chunk = rearranged[i] as string;
    else if (isUpper(c)) chunk = String(c - 55);
    else return false;
    for (let j = 0; j < chunk.length; j++) rem = (rem * 10 + (chunk.charCodeAt(j) - 48)) % 97;
  }
  return rem === 1;
}

function validSSN(s: string): boolean {
  const area = s.slice(0, 3);
  return (
    area !== "000" &&
    area !== "666" &&
    area[0] !== "9" &&
    s.slice(4, 6) !== "00" &&
    s.slice(7, 11) !== "0000"
  );
}

function validTCKN(s: string): boolean {
  if (s.length !== 11 || s[0] === "0") return false;
  const d = Array.from(s, (ch) => ch.charCodeAt(0) - 48) as number[];
  const at = (i: number): number => d[i] as number;
  const odd = at(0) + at(2) + at(4) + at(6) + at(8);
  const even = at(1) + at(3) + at(5) + at(7);
  if ((((odd * 7 - even) % 10) + 10) % 10 !== at(9)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += at(i);
  return sum % 10 === at(10);
}

const validPhone = (s: string): boolean => {
  const n = digits(s).length;
  return n >= 8 && n <= 15;
};

interface NumberSpan {
  start: number;
  end: number;
  digits: number;
  sep: string;
  groups: number[];
}

/** Runs of digits, optionally split by single spaces or dashes, that stand alone as words. */
function numberSpans(s: string): NumberSpan[] {
  const out: NumberSpan[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (!isDigit(s.charCodeAt(i)) || (i > 0 && isWord(s.charCodeAt(i - 1)))) {
      i++;
      continue;
    }
    const span: NumberSpan = { start: i, end: i, digits: 0, sep: "", groups: [] };
    let group = 0;
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isDigit(c)) {
        span.digits++;
        group++;
        j++;
        continue;
      }
      const ch = s[j] as string;
      if (
        (ch === " " || ch === "-") &&
        j + 1 < n &&
        isDigit(s.charCodeAt(j + 1)) &&
        (span.sep === "" || span.sep === ch)
      ) {
        span.sep = ch;
        span.groups.push(group);
        group = 0;
        j++;
        continue;
      }
      break;
    }
    span.groups.push(group);
    span.end = j;
    if (j === n || !isWord(s.charCodeAt(j))) out.push(span);
    i = j + 1;
  }
  return out;
}

const cardSpans = (s: string): Span[] =>
  numberSpans(s)
    .filter((x) => x.digits >= 13 && x.digits <= 19 && validCard(s.slice(x.start, x.end)))
    .map((x) => [x.start, x.end]);

const ssnSpans = (s: string): Span[] =>
  numberSpans(s)
    .filter(
      (x) =>
        x.sep === "-" &&
        x.groups.length === 3 &&
        x.groups[0] === 3 &&
        x.groups[1] === 2 &&
        x.groups[2] === 4 &&
        validSSN(s.slice(x.start, x.end)),
    )
    .map((x) => [x.start, x.end]);

const tcknSpans = (s: string): Span[] =>
  numberSpans(s)
    .filter((x) => x.sep === "" && x.digits === 11 && validTCKN(s.slice(x.start, x.end)))
    .map((x) => [x.start, x.end]);

const isLocal = (c: number): boolean => isWord(c) || c === 46 || c === 37 || c === 43 || c === 45;
const isDomain = (c: number): boolean => (isWord(c) && c !== 95) || c === 46 || c === 45;

function emailSpans(s: string): Span[] {
  const out: Span[] = [];
  let i = s.indexOf("@");
  while (i >= 0) {
    let start = i;
    let end = i + 1;
    while (start > 0 && isLocal(s.charCodeAt(start - 1))) start--;
    while (end < s.length && isDomain(s.charCodeAt(end))) end++;
    while (end > i + 1 && (s[end - 1] === "." || s[end - 1] === "-")) end--;
    const dom = s.slice(i + 1, end);
    const dot = dom.lastIndexOf(".");
    if (start < i && dot > 0) {
      const tld = dom.slice(dot + 1);
      let ok = tld.length >= 2 && tld.length <= 24;
      for (let k = 0; k < tld.length && ok; k++) ok = isAlpha(tld.charCodeAt(k));
      while (start < i && (s[start] === "." || s[start] === "-")) start++;
      if (ok && start < i) out.push([start, end]);
    }
    i = s.indexOf("@", i + 1);
  }
  return out;
}

function mayHoldIBAN(s: string): boolean {
  for (let i = 0; i + 4 <= s.length; i++) {
    if (
      isUpper(s.charCodeAt(i)) &&
      isUpper(s.charCodeAt(i + 1)) &&
      isDigit(s.charCodeAt(i + 2)) &&
      isDigit(s.charCodeAt(i + 3)) &&
      (i === 0 || !isWord(s.charCodeAt(i - 1)))
    ) {
      return true;
    }
  }
  return false;
}

const WS = "[\\t\\n\\f\\r ]";

// Case-insensitive "s" and "k" as the server folds them (the long s and the
// Kelvin sign), and the letters its case-insensitive classes add to [A-Za-z].
const S = "[s\\u017f]";
const K = "[k\\u212a]";
const FOLDED = "\\u017f\\u212a";

/**
 * Lower case one code point at a time, like the server: only U+0130 lowers
 * to two code units in JavaScript, and the server makes it "i".
 */
const lower = (s: string): string =>
  (s.includes("\u0130") ? s.replaceAll("\u0130", "i") : s).toLowerCase();

// Scanners for two of the server's patterns: the same leftmost matches in
// linear time (as regular expressions they backtrack quadratically on text
// like "a.a.a….://" or many BEGIN lines without an END).

const KEY_LABEL = "PRIVATE KEY-----";

/**
 * The end of `(?:[A-Z ]+ )?PRIVATE KEY-----` at i, or -1. "PRIVATE KEY"
 * can only end the run of capitals and spaces from i.
 */
function keyLabelEnd(s: string, i: number): number {
  let run = i;
  while (run < s.length && (isUpper(s.charCodeAt(run)) || s.charCodeAt(run) === 32)) run++;
  const label = run - 11; // "PRIVATE KEY"
  if (label < i || !s.startsWith(KEY_LABEL, label)) return -1;
  if (label > i && (label < i + 2 || s.charCodeAt(label - 1) !== 32)) return -1;
  return label + KEY_LABEL.length;
}

/** Each BEGIN line of a private key with the first END line after it. */
function privateKeySpans(s: string): Span[] {
  const out: Span[] = [];
  for (let from = 0; ; ) {
    const begin = s.indexOf("-----BEGIN ", from);
    if (begin < 0) return out;
    const head = keyLabelEnd(s, begin + 11);
    if (head < 0) {
      from = begin + 1;
      continue;
    }
    let end = -1;
    for (
      let line = s.indexOf("-----END ", head);
      line >= 0;
      line = s.indexOf("-----END ", line + 1)
    ) {
      end = keyLabelEnd(s, line + 9);
      if (end >= 0) break;
    }
    if (end < 0) return out; // a later BEGIN line finds no END line either
    out.push([begin, end]);
    from = end;
  }
}

const isScheme = (c: number): boolean =>
  isAlpha(c) || isDigit(c) || c === 43 || c === 46 || c === 45; // + . -
const endsPassword = (c: number): boolean =>
  c === 9 ||
  c === 10 ||
  c === 12 ||
  c === 13 ||
  c === 32 ||
  c === 47 ||
  c === 63 ||
  c === 35 ||
  c === 64; // \t\n\f\r /?#@

/**
 * The password in scheme://user:password@host. Every start in the scheme
 * before one "://" shares the rest of the match, so only the first is tried.
 */
function urlCredentialSpans(s: string): Span[] {
  const out: Span[] = [];
  const n = s.length;
  let from = 0;
  let sep = s.indexOf("://");
  while (sep >= 0) {
    let scheme = sep;
    while (scheme > from && isScheme(s.charCodeAt(scheme - 1))) scheme--;
    // The first letter at a word boundary starts the scheme.
    while (
      scheme < sep &&
      !(isAlpha(s.charCodeAt(scheme)) && (scheme === 0 || !isWord(s.charCodeAt(scheme - 1))))
    )
      scheme++;
    if (scheme < sep) {
      let user = sep + 3;
      while (user < n && s.charCodeAt(user) !== 58 && !endsPassword(s.charCodeAt(user))) user++;
      if (user < n && s.charCodeAt(user) === 58) {
        let end = user + 1;
        while (end < n && !endsPassword(s.charCodeAt(end))) end++;
        if (end > user + 1 && end < n && s.charCodeAt(end) === 64) {
          out.push([user + 1, end]);
          from = end + 1;
          sep = s.indexOf("://", from);
          continue;
        }
      }
    }
    sep = s.indexOf("://", sep + 1);
  }
  return out;
}

/**
 * The JWT pattern at one start, else the rest of the start's run of
 * base64url characters ([\w-]): each part of a JWT is a whole run, so no
 * start in that run can match either.
 */
const JWT = /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}|[\w-]+/y;

/**
 * `\bJWT` with the same matches in linear time: searched as one regular
 * expression it backtracks quadratically on text like "eyJ-eyJ-…".
 */
function jwtSpans(s: string): Span[] {
  const out: Span[] = [];
  for (let i = s.indexOf("eyJ"); i >= 0; i = s.indexOf("eyJ", i + 1)) {
    if (i > 0 && isWord(s.charCodeAt(i - 1))) continue;
    JWT.lastIndex = i;
    if ((JWT.exec(s) as RegExpExecArray)[0].includes(".")) out.push([i, JWT.lastIndex]);
    i = JWT.lastIndex - 1;
  }
  return out;
}

/** Rejects values a scrubber already replaced. */
const unmasked = (v: string): boolean => !v.startsWith("[REDACTED") && v !== FILTERED;

/**
 * Tells a token from a word after "basic": it has a digit, a base64 symbol,
 * or capitals past its first letter ("dXNlcjpwYXNz", not "Authentication").
 */
function credentialLike(v: string): boolean {
  if (/[0-9+/=]/.test(v)) return true;
  const rest = v.slice(1);
  return /[A-Z]/.test(rest) && /[a-z]/.test(rest);
}
const g = (p: string, flags = ""): RegExp => new RegExp(p, `g${flags}`);

const REGISTRY: Detector[] = [
  {
    name: "private_key",
    prefilter: ["PRIVATE KEY-----"],
    caseSensitive: true,
    scan: privateKeySpans,
  },
  {
    name: "aws_access_key",
    prefilter: ["AKIA", "ASIA", "ABIA", "ACCA"],
    caseSensitive: true,
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  { name: "gcp_api_key", prefilter: ["AIza"], caseSensitive: true, re: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    name: "azure_storage_key",
    prefilter: ["accountkey="],
    re: g(`Account${K}ey=([A-Za-z0-9+/${FOLDED}]{86}==)`, "di"),
    group: 1,
  },
  {
    name: "github_token",
    prefilter: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
    caseSensitive: true,
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g,
  },
  {
    name: "stripe_key",
    prefilter: ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "whsec_"],
    caseSensitive: true,
    re: /\b(?:(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,247}|whsec_[A-Za-z0-9+/=]{24,})/g,
  },
  {
    name: "slack_token",
    prefilter: ["xox"],
    caseSensitive: true,
    re: /\bxox[abposr]-[0-9A-Za-z-]{10,250}\b/g,
  },
  {
    name: "slack_webhook",
    prefilter: ["hooks.slack.com/services/"],
    caseSensitive: true,
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  {
    name: "anthropic_key",
    prefilter: ["sk-ant-"],
    caseSensitive: true,
    re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g,
  },
  {
    name: "openai_key",
    prefilter: ["sk-"],
    caseSensitive: true,
    re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
  },
  { name: "jwt", prefilter: ["eyJ"], caseSensitive: true, scan: jwtSpans },
  {
    name: "fixwire_secret_key",
    prefilter: ["_sk_live_", "_sk_test_"],
    caseSensitive: true,
    re: /\b[a-z]{2,4}_sk_(?:live|test)_[0-9A-Za-z]{38}\b/g,
  },
  {
    // The password in scheme://user:password@host (the user stays).
    name: "url_credentials",
    prefilter: ["://"],
    caseSensitive: true,
    scan: urlCredentialSpans,
    validate: unmasked,
  },
  {
    // Bearer and Basic credentials outside a header (messages, breadcrumbs).
    name: "http_auth",
    prefilter: ["bearer", "basic"],
    re: g(`\\b(?:bearer|ba${S}ic)${WS}+([A-Za-z0-9._~+/${FOLDED}-]{12,}=*)`, "di"),
    group: 1,
    validate: credentialLike,
  },
  {
    name: "secret_assignment",
    prefilter: ["pass", "secret", "token", "api_key", "apikey", "api-key", "pwd"],
    re: g(
      `\\b(?:pa${S}${S}word|pa${S}${S}wd|pwd|${S}ecret|to${K}en|api[_-]?${K}ey|acce${S}${S}[_-]?${K}ey)["']?${WS}*[:=]${WS}*["']?([^\\t\\n\\f\\r "',;&]{6,})`,
      "di",
    ),
    group: 1,
    // Six characters as the server counts them: code points, not UTF-16 units.
    minCodePoints: 6,
    validate: unmasked,
  },
  { name: "email", prefilter: ["@"], caseSensitive: true, scan: emailSpans },
  { name: "credit_card", scan: cardSpans },
  {
    name: "iban",
    may: mayHoldIBAN,
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    validate: validIBAN,
  },
  { name: "us_ssn", prefilter: ["-"], caseSensitive: true, scan: ssnSpans },
  { name: "tr_tckn", scan: tcknSpans },
  {
    name: "phone",
    prefilter: ["+"],
    caseSensitive: true,
    re: /\+\d(?:[ .\-()]?\d){7,14}\b/g,
    validate: validPhone,
  },
  {
    name: "ipv4",
    prefilter: ["."],
    caseSensitive: true,
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  },
];

export const DEFAULT_DETECTORS: readonly string[] = REGISTRY.filter((d) => d.name !== "ipv4").map(
  (d) => d.name,
);

function spans(d: Detector, s: string): Span[] {
  if (d.scan) return d.scan(s);
  const out: Span[] = [];
  const re = new RegExp(d.re as RegExp); // its own lastIndex
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const start = m.index;
    const group = d.group
      ? (m as RegExpExecArray & { indices?: [number, number][] }).indices?.[d.group]
      : undefined;
    const [from, to] = group ?? [start, start + m[0].length];
    if (m[0].length === 0) re.lastIndex = start + 1; // never loop on an empty match
    if (d.minCodePoints && codePoints(s, from, to) < d.minCodePoints) {
      // The server finds no match starting here: look again one character on.
      re.lastIndex = start + 1;
      continue;
    }
    out.push([from, to]);
  }
  return out;
}

function codePoints(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (
      !(
        c >= 0xdc00 &&
        c <= 0xdfff &&
        i > from &&
        s.charCodeAt(i - 1) >= 0xd800 &&
        s.charCodeAt(i - 1) <= 0xdbff
      )
    )
      n++;
  }
  return n;
}

/**
 * Whether [start, end) overlaps one of `fs`, sorted by start and disjoint:
 * of those starting before `end`, the last ends last. (Not quite so with an
 * empty finding, which only a custom pattern matching "" makes.)
 */
function overlaps(fs: Finding[], start: number, end: number): boolean {
  let lo = 0;
  let hi = fs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((fs[mid] as Finding).start < end) lo = mid + 1;
    else hi = mid;
  }
  return start < (fs[lo - 1]?.end ?? 0);
}

/** Orders strings like Go and Python do (by code point, not UTF-16 unit). */
const byCodePoint = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

const normalizeKey = (k: string): string => lower(k).replace(/[-_ ]/g, "");
const tokenCount = (k: string): boolean =>
  k.endsWith("tokens") || k.includes("tokencount") || k.includes("usage");
const empty = (v: unknown): boolean => v === null || v === undefined || v === "";

export interface RedactorOptions {
  detectors?: readonly string[];
  patterns?: Record<string, string>;
  sensitiveKeys?: readonly string[];
}

/** Masks secrets and personal data. */
export class Redactor {
  private readonly detectors: Detector[];
  private readonly keys: readonly string[];

  constructor(o: RedactorOptions = {}) {
    this.detectors = (o.detectors ?? DEFAULT_DETECTORS).map((name) => {
      const d = REGISTRY.find((x) => x.name === name);
      if (!d) throw new Error(`redact: unknown detector ${name}`);
      return d;
    });
    for (const name of Object.keys(o.patterns ?? {}).sort()) {
      this.detectors.push({
        name,
        re: new RegExp((o.patterns as Record<string, string>)[name] as string, "g"),
      });
    }
    this.keys = o.sensitiveKeys ? o.sensitiveKeys.map(normalizeKey) : DEFAULT_SENSITIVE_KEYS;
  }

  /** Non-overlapping findings, leftmost first; on overlap the earlier detector wins. */
  find(s: string): Finding[] {
    let out: Finding[] = [];
    let lowered: string | undefined;
    for (const d of this.detectors) {
      if (d.prefilter) {
        if (!d.caseSensitive && lowered === undefined) lowered = lower(s);
        const hay = d.caseSensitive ? s : (lowered as string);
        if (!d.prefilter.some((p) => hay.includes(p))) continue;
      }
      if (d.may && !d.may(s)) continue;
      // A detector's spans come leftmost first, so its findings stay sorted
      // too: both lists are searched, not scanned.
      const mine: Finding[] = [];
      for (const [start, end] of spans(d, s)) {
        if (d.validate && !d.validate(s.slice(start, end))) continue;
        if (overlaps(out, start, end) || overlaps(mine, start, end)) continue;
        mine.push({ detector: d.name, start, end });
      }
      if (mine.length) out = out.concat(mine).sort((a, b) => a.start - b.start);
    }
    return out;
  }

  /** Replaces each finding with [REDACTED:<detector>]. */
  mask(s: string): [string, Finding[]] {
    const fs = this.find(s);
    if (!fs.length) return [s, fs];
    let out = "";
    let last = 0;
    for (const f of fs) {
      out += `${s.slice(last, f.start)}[REDACTED:${f.detector}]`;
      last = f.end;
    }
    return [out + s.slice(last), fs];
  }

  sensitive(key: string): boolean {
    const k = normalizeKey(key);
    if (k === "auth") return true;
    return this.keys.some((frag) => k.includes(frag) && (frag !== "token" || !tokenCount(k)));
  }

  /** Masks every string of a JSON-like value in place and filters sensitive keys; returns the value and the count. */
  walk<T>(value: T): [T, number] {
    const n = { count: 0 };
    return [this.walkInner(value, n) as T, n.count];
  }

  private walkInner(v: unknown, n: { count: number }): unknown {
    if (Array.isArray(v)) {
      // Some maps are sent as [key, value] pairs (headers, tags).
      if (v.length === 2 && typeof v[0] === "string" && this.sensitive(v[0]) && !empty(v[1])) {
        v[1] = FILTERED;
        n.count++;
        return v;
      }
      for (let i = 0; i < v.length; i++) v[i] = this.walkInner(v[i], n);
      return v;
    }
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const renamed: string[] = [];
      for (const k of Object.keys(o)) {
        if (this.mask(k)[0] !== k) renamed.push(k);
        const val = o[k];
        if (this.sensitive(k) && !empty(val)) {
          // A typed attribute ({"type": …, "value": …}) keeps its shape.
          if (
            val !== null &&
            typeof val === "object" &&
            !Array.isArray(val) &&
            (val as Record<string, unknown>).value != null
          ) {
            const typed = val as Record<string, unknown>;
            if (typed.value !== FILTERED) {
              typed.value = FILTERED;
              typed.type = "string";
              n.count++;
            }
            continue;
          }
          if (val !== FILTERED) {
            o[k] = FILTERED;
            n.count++;
          }
          continue;
        }
        o[k] = this.walkInner(val, n);
      }
      // Keys hold data too ({"ada@example.com": 3}). Keys that mask alike
      // are numbered in key order: "[REDACTED:email] (2)".
      for (const k of renamed.sort(byCodePoint)) {
        const [masked, fs] = this.mask(k);
        let key = masked;
        for (let i = 2; Object.hasOwn(o, key); i++) key = `${masked} (${i})`;
        o[key] = o[k];
        delete o[k];
        n.count += fs.length;
      }
      return o;
    }
    if (typeof v === "string") {
      const [masked, fs] = this.mask(v);
      n.count += fs.length;
      return masked;
    }
    return v;
  }
}
