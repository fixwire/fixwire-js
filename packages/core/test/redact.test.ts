// The shared corpus of the Fixwire server's redaction (a copy of
// pkg/redact/testdata/vectors.json in fixwire/fixwire, kept identical): the
// server's scrubber and this port must agree on every case.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_DETECTORS, DEFAULT_SENSITIVE_KEYS, Redactor } from "../src/redact.ts";

const corpus = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors.json"), "utf8"),
) as {
  detectors: string[];
  sensitive_keys: string[];
  fixtures: Record<string, string[]>;
  strings: { name: string; input: string; masked: string; findings: string[] }[];
  documents: { name: string; input: unknown; masked: unknown; count: number }[];
};

const expand = (s: string): string =>
  Object.entries(corpus.fixtures).reduce(
    (acc, [name, parts]) => acc.split(`{{${name}}}`).join(parts.join("")),
    s,
  );

const expandValue = (v: unknown): unknown => {
  if (typeof v === "string") return expand(v);
  if (Array.isArray(v)) return v.map(expandValue);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandValue(x)]));
  return v;
};

test("same detectors and keys as the server", () => {
  assert.deepEqual([...DEFAULT_DETECTORS], corpus.detectors);
  assert.deepEqual([...DEFAULT_SENSITIVE_KEYS], corpus.sensitive_keys);
});

for (const c of corpus.strings) {
  test(`string: ${c.name}`, () => {
    const [masked, findings] = new Redactor().mask(expand(c.input));
    assert.equal(masked, c.masked);
    assert.deepEqual(
      findings.map((f) => f.detector),
      c.findings,
    );
  });
}

for (const c of corpus.documents) {
  test(`document: ${c.name}`, () => {
    const [out, count] = new Redactor().walk(expandValue(c.input));
    assert.deepEqual(out, c.masked);
    assert.equal(count, c.count);
  });
}

// Beyond the corpus: what fuzzing against the server's code found.

const BEGIN = "-----BEGIN "; // split, so no scanner sees a whole key

for (const [name, text] of [
  ["a URL scheme that never ends", `${"a.".repeat(50_000)}://`],
  ["BEGIN lines without an END", `${BEGIN}RSA PRIVATE KEY-----\n`.repeat(3_000)],
  ["many URLs without a password", "x://u:".repeat(20_000)],
  // As a regular expression the JWT detector took 16 s on these 200 kB.
  ["JWT starts without the dots", "eyJ-".repeat(50_000)],
  // Each finding was checked against every earlier one.
  ["thirty thousand findings", "a@b.cc ".repeat(30_000)],
  // secret_assignment has no word boundary now: a name anywhere, then spaces to backtrack.
  ["a name and spaces without a value", `token${" ".repeat(100_000)}`],
  ["a name, '=' and spaces", `token=${" ".repeat(100_000)}x`],
  ["names run together", "sessid".repeat(50_000)],
  ["names with empty values", "sessid= ".repeat(30_000)],
  ["query codes run together", "?code".repeat(50_000)],
  ["query codes with short values", "?code=ab".repeat(30_000)],
  ["names that may go on", "secret_key_".repeat(30_000)],
]) {
  test(`hostile text is masked in linear time: ${name}`, () => {
    const started = performance.now();
    new Redactor().mask(text);
    assert.ok(performance.now() - started < 500);
  });
}

for (const [text, masked] of [
  // The server folds the long s and the Kelvin sign in its case-insensitive detectors
  // (once a plain keyword got the text past their prefilter). Expected values from its code.
  ["to\u212aen=abcdefgh", "to\u212aen=[REDACTED:secret_assignment]"],
  [
    "password: hunter2 pa\u017f\u017fword: hunter2hunter2",
    "password: [REDACTED:secret_assignment] pa\u017f\u017fword: [REDACTED:secret_assignment]",
  ],
  ["basic x ba\u017fic dXNlcjpwYXNzd29yZA==", "basic x ba\u017fic [REDACTED:http_auth]"],
  ["bearer abcdefghij\u212a/x", "bearer [REDACTED:http_auth]"],
  // Six characters as the server counts them: code points.
  ["pwd:abc\u{1F600}a", "pwd:abc\u{1F600}a"],
  // Too short there, so the server looks again one character on and finds the next assignment.
  [
    'token=\u{1F600}\u{1F600}pwd"=abcdefgh',
    'token=\u{1F600}\u{1F600}pwd"=[REDACTED:secret_assignment]',
  ],
  [
    `a ${BEGIN}RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY----- b ${BEGIN}EC PRIVATE KEY-----`,
    `a [REDACTED:private_key] b ${BEGIN}EC PRIVATE KEY-----`,
  ],
  [
    "x://u:p:q@h://v:w@z 1a://u:p@h",
    "x://u:[REDACTED:url_credentials]@h://v:[REDACTED:url_credentials]@z 1a://u:p@h",
  ],
]) {
  test(`matches the server beyond the corpus: ${JSON.stringify(text).slice(0, 40)}`, () => {
    assert.equal(new Redactor().mask(text)[0], masked);
  });
}

test("a JWT after hostile text is still found", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz";
  const hostile = "eyJ-".repeat(1_000);
  assert.equal(new Redactor().mask(`${hostile} ${jwt}`)[0], `${hostile} [REDACTED:jwt]`);
  // Joined by "-" (a non-word character), the run is one token from its first "eyJ".
  assert.equal(new Redactor().mask(`x ${hostile}${jwt}`)[0], "x [REDACTED:jwt]");
});

test("keys that mask alike are numbered in linear time", () => {
  const doc: Record<string, number> = {};
  for (let i = 0; i < 20_000; i++) doc[`user${i}@example.com`] = i;
  const started = performance.now();
  const [out, n] = new Redactor().walk(doc);
  assert.ok(performance.now() - started < 1000);
  assert.equal(n, 20_000);
  assert.equal(Object.keys(out).length, 20_000);
  assert.ok(Object.hasOwn(out, "[REDACTED:email] (20000)"));
});

test("text redaction fails on is sent as [Filtered]", () => {
  const r = new Redactor();
  (r as unknown as { find(): never }).find = () => {
    throw new RangeError("Maximum call stack size exceeded");
  };
  assert.deepEqual(r.mask("token=abcdefgh"), ["[Filtered]", []]);
  // Keys are text too.
  assert.deepEqual(r.walk({ note: "token=abcdefgh" })[0], { "[Filtered]": "[Filtered]" });
});

test("keys lower-case like the server", () => {
  // JavaScript lowers U+0130 to two code units; the server to "i".
  const [doc, n] = new Redactor().walk({ "ap\u0130key": "abc", x: "y" });
  assert.deepEqual(doc, { "ap\u0130key": "[Filtered]", x: "y" });
  assert.equal(n, 1);
});
