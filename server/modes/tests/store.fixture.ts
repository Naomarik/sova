// The modes recordings' storage (harness.fixture.ts records them): one file per case in cases/, and the big values
// they share in store/, named by content. No side effects: `bun server/modes/tests/show.fixture.ts <case>` reads
// one back whole.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = join(HERE, "../golden/cases");
export const RECORD = process.env.SOVA_MODES_GOLDEN === "record";

// ── Recordings ────────────────────────────────────────────────────────────────────────────────────

/** Where big values live once for every case: `<sha256 prefix>.json`, named by their content. */
export const STORE_DIR = join(HERE, "../golden/store");
const REF = /^@[0-9a-f]{16}$/;
const BIG_STRING = 240;
const BIG_OBJECT = 2000;
/** Objects this shallow stay in the case file, so its steps, calls, entries and tool lists read there:
    a recording (0), its steps (1), a step's fields (2), a call (3), a call's messages (4). */
const INLINE_DEPTH = 5;

/**
 * A case's recording as stored, and the big values it refers to: bottom-up, every string over 240
 * characters and every object or array at least INLINE_DEPTH deep whose JSON (its own big values already
 * replaced) is over 2000 becomes `@<hash>`, its value in the store. Two cases sharing a system prompt or a
 * tool share its file.
 */
export function encode(record: unknown): { text: string; blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  const put = (json: string) => {
    const key = `@${createHash("sha256").update(json).digest("hex").slice(0, 16)}`;
    blobs.set(key, json);
    return key;
  };
  const intern = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return v.length > BIG_STRING ? put(JSON.stringify(v)) : v;
    if (Array.isArray(v) || (v && typeof v === "object")) {
      const inner = Array.isArray(v) ? v.map((x) => intern(x, depth + 1)) : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, intern(x, depth + 1)]));
      const json = JSON.stringify(inner, null, 1);
      return depth >= INLINE_DEPTH && json.length > BIG_OBJECT ? put(json) : inner;
    }
    return v;
  };
  return { text: JSON.stringify(intern(record), null, 1) + "\n", blobs };
}
/** A stored recording's value, its references resolved from `blobs` (else the store). */
export function decode(text: string, blobs: Map<string, string> = new Map()): unknown {
  const out = (v: unknown): unknown => {
    if (typeof v === "string" && REF.test(v)) {
      const json = blobs.get(v) ?? (existsSync(join(STORE_DIR, `${v.slice(1)}.json`)) ? readFileSync(join(STORE_DIR, `${v.slice(1)}.json`), "utf8") : undefined);
      return json === undefined ? `<missing ${v}>` : out(JSON.parse(json));
    }
    if (Array.isArray(v)) return v.map(out);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, out(x)]));
    return v;
  };
  return out(JSON.parse(text));
}

/** The first JSON path where two values differ, with both sides (short). */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return `${path}: key order differs`;
  }
  const show = (v: unknown) => {
    if (typeof a === "string" && typeof b === "string") {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return `…${JSON.stringify((v as string).slice(Math.max(0, i - 80), i + 160))}… (at character ${i})`;
    }
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  };
  return `${path}\n  recorded: ${show(b)}\n  now:      ${show(a)}`;
}

/**
 * Compare a case's record with its recording, byte for byte: the case file's bytes, and through its
 * content-named references every big value's. In record mode rewrite it (from Sova's engine, the only owner).
 */
export function matchRecording(name: string, record: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`);
  const now = encode(record);
  if (RECORD) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    mkdirSync(STORE_DIR, { recursive: true });
    for (const [key, json] of now.blobs) {
      const f = join(STORE_DIR, `${key.slice(1)}.json`);
      if (!existsSync(f)) writeFileSync(f, json + "\n");
    }
    writeFileSync(file, now.text);
    return;
  }
  assert.ok(existsSync(file), `no recording ${file}: take it with SOVA_MODES_GOLDEN=record`);
  const was = readFileSync(file, "utf8");
  const missing = [...now.blobs.keys()].filter((k) => !existsSync(join(STORE_DIR, `${k.slice(1)}.json`)));
  if (was === now.text && missing.length === 0) return;
  const d = firstDiff(decode(now.text, now.blobs), decode(was));
  assert.fail(`${name} differs from its recording at ${d ?? `the stored values ${missing.join(", ")}`}`);
}

/** Every store file some recording refers to (a re-record leaves the old ones: prune with this). */
export function referencedBlobs(): Set<string> {
  const seen = new Set<string>();
  const walk = (json: string) => {
    for (const m of json.matchAll(/"@([0-9a-f]{16})"/g)) {
      if (seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      const f = join(STORE_DIR, `${m[1]}.json`);
      if (existsSync(f)) walk(readFileSync(f, "utf8"));
    }
  };
  for (const f of existsSync(GOLDEN_DIR) ? readdirSync(GOLDEN_DIR) : []) if (f.endsWith(".json")) walk(readFileSync(join(GOLDEN_DIR, f), "utf8"));
  return seen;
}
