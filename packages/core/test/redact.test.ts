// The shared corpus from pkg/redact in fixwire/fixwire: the server's scrubber and this
// port must agree on every case.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_DETECTORS, DEFAULT_SENSITIVE_KEYS, Redactor } from "../src/redact.ts";

/** The corpus, in the repository root's pkg/ above this SDK (wherever it sits). */
function corpusPath(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, "pkg", "redact", "testdata", "vectors.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir)
      throw new Error("pkg/redact/testdata/vectors.json not found above this test");
  }
}

const corpus = JSON.parse(readFileSync(corpusPath(), "utf8")) as {
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
