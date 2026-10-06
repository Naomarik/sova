// The golden harness (README.md here): fixtures × probes → recorded outputs that characterize the readers.
// golden.test.ts compares; `node scripts/harness-golden.mjs record` re-records them (missing and differing
// files alike), and the diff is reviewed with the change that caused it. Nothing here imports pi.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const GOLDEN_DIR = import.meta.dirname;
export const REPO = join(GOLDEN_DIR, "../../../..");
/** The local real-session corpus `sample` writes (gitignored, never committed): absent = that set is skipped. */
export const REAL_DIR = process.env.SOVA_GOLDEN_REAL_DIR ?? join(REPO, ".agent/golden-real");

export type Format = "pi" | "cc";

/** One fixture as a probe sees it. `file()` is a private copy in the test's agent dir; `copy(text)` another. */
export interface Fixture {
  set: string;
  /** The real corpus: per-entry probes ask about a sample of targets (`targetsOf`). */
  private: boolean;
  name: string;
  format: Format;
  text: string;
  file(): string;
  copy(suffix: string, text: string): string;
}

export interface Probe {
  /** Unique across probes files: the expected file's name. */
  name: string;
  formats: readonly Format[];
  run(f: Fixture): unknown;
}

export interface FixtureSet {
  name: string;
  /** Real sessions: reports carry hashes and JSON paths, never content. */
  private: boolean;
  /** Where its expected files live: `<expected>/<fixture>/<probe>.json`. */
  expected: string;
  fixtures: { name: string; format: Format; path: string }[];
}

const jsonlIn = (dir: string, format: Format) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => ({ name: f.slice(0, -".jsonl".length), format, path: join(dir, f) })) : [];

/** The committed sets, and the real one when its directory exists. */
export function fixtureSets(): FixtureSet[] {
  const fx = join(GOLDEN_DIR, "fixtures");
  const fauxDir = join(fx, "faux");
  const faux = existsSync(fauxDir)
    ? readdirSync(fauxDir).filter((d) => existsSync(join(fauxDir, d, "session.jsonl"))).sort().map((d) => ({ name: d, format: "pi" as const, path: join(fauxDir, d, "session.jsonl") }))
    : [];
  const sets: FixtureSet[] = [
    { name: "synthetic", private: false, expected: join(GOLDEN_DIR, "expected/synthetic"), fixtures: jsonlIn(join(fx, "synthetic"), "pi") },
    { name: "faux", private: false, expected: join(GOLDEN_DIR, "expected/faux"), fixtures: faux },
    { name: "cc", private: false, expected: join(GOLDEN_DIR, "expected/cc"), fixtures: jsonlIn(join(fx, "cc"), "cc") },
  ];
  if (existsSync(join(REAL_DIR, "sessions"))) sets.push({ name: "real", private: true, expected: join(REAL_DIR, "expected"), fixtures: jsonlIn(join(REAL_DIR, "sessions"), "pi") });
  return sets;
}

/** The first 12 hex of a file's sha256: how a private fixture is named in any report. */
export const shortHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);

/**
 * A probe's output as JSON: Map and Set kept as `{"$map": [[k, v]…]}` / `{"$set": […]}`, Dates as ISO strings,
 * a thrown error as `{"$throws": message}`. Object keys whose value is undefined drop out (JSON's rule).
 * Every occurrence of `scrub`'s keys in a string becomes its value (the run's temp paths).
 */
export function encode(v: unknown, scrub: ReadonlyMap<string, string> = new Map()): unknown {
  const fix = (s: string) => {
    for (const [from, to] of scrub) if (s.includes(from)) s = s.split(from).join(to);
    return s;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return fix(x);
    if (x === undefined) return undefined;
    if (x === null || typeof x !== "object") return typeof x === "number" && !Number.isFinite(x) ? { $number: String(x) } : x;
    if (x instanceof Map) return { $map: [...x.entries()].map(([k, y]) => [walk(k), walk(y) ?? null]) };
    if (x instanceof Set) return { $set: [...x].map((y) => walk(y) ?? null) };
    if (x instanceof Date) return x.toISOString();
    if (Buffer.isBuffer(x)) return { $buffer: x.toString("base64") };
    if (Array.isArray(x)) return x.map((y) => walk(y) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(x)) {
      const w = walk(y);
      if (w !== undefined) out[fix(k)] = w;
    }
    return out;
  };
  return walk(v);
}

/** An output whose key-sorted compact JSON is longer than this is stored as its digest. Every committed
    synthetic, faux and cc output is below it, so those stay whole; a real session's large outputs don't. */
export const DIGEST_ABOVE = 256 * 1024;
/** How much of a digested output's JSON is kept, for a reader (a real fixture's is gitignored). */
const HEAD_CHARS = 200;
/** A digested array's parts: hashes of at most this many runs of elements. */
const ARRAY_PARTS = 64;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** `v` (decoded JSON) with every object's keys sorted: a digest then compares by value, as the whole form does. */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
  return out;
}

/**
 * The output as stored: itself, or above DIGEST_ABOVE `{"$digest": {sha256, bytes, head, parts}}`, where `parts`
 * hashes each top-level key (an object) or each of up to 64 runs of elements (an array), so a difference still
 * has a path. sha256 is over the key-sorted compact JSON.
 */
export function compact(v: unknown): unknown {
  const c = canonical(v);
  const s = JSON.stringify(c) ?? "null";
  if (s.length <= DIGEST_ABOVE) return v;
  const short = (x: unknown) => sha(JSON.stringify(x) ?? "null").slice(0, 16);
  let parts: unknown;
  if (Array.isArray(c)) {
    const step = Math.max(1, Math.ceil(c.length / ARRAY_PARTS));
    const runs: string[] = [];
    for (let i = 0; i < c.length; i += step) runs.push(`${i}-${Math.min(c.length, i + step) - 1}:${short(c.slice(i, i + step))}`);
    parts = runs;
  } else if (c && typeof c === "object") {
    parts = Object.fromEntries(Object.entries(c).map(([k, x]) => [k, short(x)]));
  }
  return { $digest: { sha256: sha(s), bytes: Buffer.byteLength(s), head: s.slice(0, HEAD_CHARS), ...(parts !== undefined ? { parts } : {}) } };
}

/** Lines as one text (joined by "\n"), whole when short, else hashed as they come: never one giant string. */
export function linesOrDigest(lines: readonly string[]): string[] | { $digest: { sha256: string; bytes: number; lines: number; head: string } } {
  let bytes = 0;
  for (const l of lines) bytes += l.length + 1;
  if (bytes <= DIGEST_ABOVE) return [...lines];
  const h = createHash("sha256");
  let n = 0;
  lines.forEach((l, i) => {
    if (i) h.update("\n");
    h.update(l);
    n += Buffer.byteLength(l) + (i ? 1 : 0);
  });
  return { $digest: { sha256: h.digest("hex"), bytes: n, lines: lines.length, head: (lines[0] ?? "").slice(0, HEAD_CHARS) } };
}

/** How many entries a per-entry probe (fork, regenerate, rewind) asks about before it samples them. */
export const TARGETS_ALL_UP_TO = 200;

/**
 * The entry ids a per-entry probe asks about: all of them on a committed fixture with at most TARGETS_ALL_UP_TO;
 * otherwise (the real corpus, a large fixture) the first, the last and up to 8 evenly spaced between.
 */
export function targetsOf(f: Pick<Fixture, "private">, ids: readonly string[]): string[] {
  if (!f.private && ids.length <= TARGETS_ALL_UP_TO) return [...ids];
  if (ids.length <= 10) return [...ids];
  const picked = new Set<number>([0, ids.length - 1]);
  for (let k = 1; k <= 8; k++) picked.add(Math.round((k * (ids.length - 1)) / 9));
  return [...picked].sort((a, b) => a - b).map((i) => ids[i]!);
}

/** Runs a probe: its output, or `{"$throws": message}` (a throw is an output too). */
export async function runProbe(p: Probe, f: Fixture): Promise<unknown> {
  try {
    return await p.run(f);
  } catch (err) {
    return { $throws: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export const serialize = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** The JSON path of the first difference between two decoded JSON values, or null when they are equal.
    Objects compare by key set and values (key order is not compared); arrays and strings exactly. */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    for (let i = 0; i < Math.max(a.length, bb.length); i++) {
      if (i >= a.length || i >= bb.length) return `${path}[${i}]`;
      const d = firstDiff(a[i], bb[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
  for (const k of keys) {
    const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
    if (!(k in ao) || !(k in bo)) return p;
    const d = firstDiff(ao[k], bo[k], p);
    if (d) return d;
  }
  return null;
}

/** The value at a JSON path firstDiff produced (for a committed fixture's failure message only). */
export function valueAt(v: unknown, path: string): unknown {
  const parts = path.slice(1).match(/\.[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\]/g) ?? [];
  let cur: any = v;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = p.startsWith(".") ? cur[p.slice(1)] : p.startsWith('["') ? cur[JSON.parse(p.slice(1, -1))] : cur[Number(p.slice(1, -1))];
  }
  return cur;
}

/** A fixture's private copies live under `root` (inside the agent dir's sessions dir, as real files do). */
export function workspaceFixture(set: FixtureSet, fx: FixtureSet["fixtures"][number], root: string): Fixture {
  mkdirSync(root, { recursive: true });
  const base = `${set.name}__${fx.name}`;
  let main: string | null = null;
  return {
    set: set.name,
    private: set.private,
    name: fx.name,
    format: fx.format,
    text: readFileSync(fx.path, "utf8"),
    file() {
      if (!main) {
        main = join(root, `${base}.jsonl`);
        copyFileSync(fx.path, main);
      }
      return main;
    },
    copy(suffix, text) {
      const p = join(root, `${base}--${suffix}.jsonl`);
      writeFileSync(p, text);
      return p;
    },
  };
}

export type Mode = "compare" | "record";

export interface Outcome {
  status: "same" | "differs" | "missing" | "written" | "rewritten";
  path: string;
  /** For "differs": the first JSON path and, for a committed fixture, both values there. */
  where?: string;
  detail?: string;
}

/**
 * Compares (or records) one probe's output against its expected file. Record writes a missing file and
 * rewrites a differing one, unless `keep` (a contract file: a difference stays a failure even in record).
 */
export function settle(set: FixtureSet, fixture: string, probe: string, output: unknown, mode: Mode, opts: { keep?: boolean } = {}): Outcome {
  const path = join(set.expected, fixture, `${probe}.json`);
  const fresh = serialize(output);
  if (!existsSync(path)) {
    if (mode !== "record") return { status: "missing", path };
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, fresh);
    return { status: "written", path };
  }
  const had = readFileSync(path, "utf8");
  if (had === fresh) return { status: "same", path };
  let expected: unknown;
  try {
    expected = JSON.parse(had);
  } catch (err) {
    return { status: "differs", path, where: "$", detail: `the expected file is not JSON (${(err as Error).message})` };
  }
  const where = firstDiff(expected, JSON.parse(fresh));
  if (where === null) return { status: "same", path };
  if (mode === "record" && !opts.keep) {
    writeFileSync(path, fresh);
    return { status: "rewritten", path, where };
  }
  const detail = set.private
    ? undefined
    : `expected ${clip(JSON.stringify(valueAt(expected, where)))}, got ${clip(JSON.stringify(valueAt(JSON.parse(fresh), where)))}`;
  return { status: "differs", path, where, ...(detail ? { detail } : {}) };
}

const clip = (s: string | undefined) => (s === undefined ? "(absent)" : s.length > 300 ? `${s.slice(0, 300)}…` : s);

/** Expected files with no fixture or probe left to produce them. */
export function staleExpected(set: FixtureSet, probes: readonly Probe[]): string[] {
  if (!existsSync(set.expected)) return [];
  const fixtures = new Map(set.fixtures.map((f) => [f.name, f.format]));
  const out: string[] = [];
  for (const dir of readdirSync(set.expected).sort()) {
    const abs = join(set.expected, dir);
    if (!statSync(abs).isDirectory()) continue;
    const format = fixtures.get(dir);
    for (const file of readdirSync(abs).sort()) {
      const probe = probes.find((p) => `${p.name}.json` === file);
      if (!format || !probe || !probe.formats.includes(format)) out.push(relative(REPO, join(abs, file)));
    }
  }
  return out;
}
