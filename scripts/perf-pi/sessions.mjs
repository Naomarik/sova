// perf-pi session data: synthesized pi sessions of a given length, and a sample of real ones copied in.
// Builtins only. Nothing here writes outside the directories it is given; ~/.pi/agent/sessions is only read.
//
// Synthesized sessions follow server/harness/pi/golden/fixtures/large.ts (the same entry shapes and
// seeded filler), minus its rewind and compaction, so one file is one straight branch: a header, a
// model_change onto the mock model, then turns of user → assistant (text + tool call) → toolResult →
// assistant reply, 4 entries a turn. The session's model is the mock's, so a turn needs no set_model.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const MOCK_PROVIDER = "perfmock";
export const MOCK_MODEL = "mock-1";

/** mulberry32, as large.ts. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ["parser", "branch", "entry", "reader", "golden", "session", "token", "window", "fork", "rows", "watch", "usage", "context", "tool", "result", "model"];

/** pi's session directory name for a cwd (`--<cwd with / → ->--`). */
export const sessionDirName = (cwd) => `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;

/** A straight session of about `entries` entries (header excluded) in `cwd`; `seed` varies the id and filler. */
export function synthSession(entries, cwd, seed = 1) {
  const rand = prng(seed);
  const words = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
  const T0 = Date.parse("2026-09-04T09:00:00.000Z");
  const hex = (seed * 1000003 + entries).toString(16).padStart(12, "0").slice(-12);
  const sessionId = `0190a000-0000-7000-8000-${hex}`;
  const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(T0).toISOString(), cwd })];
  let n = 0;
  let leaf = null;
  const add = (type, body) => {
    const id = (++n).toString(16).padStart(8, "0");
    const ms = T0 + n * 1000;
    const b = body.message ? { ...body, message: { ...body.message, timestamp: ms } } : body;
    lines.push(JSON.stringify({ type, ...b, id, parentId: leaf, timestamp: new Date(ms).toISOString() }));
    leaf = id;
  };
  const usage = (i) => ({ input: 1000 + i, output: 200, cacheRead: 3000 + i, cacheWrite: 50, totalTokens: 4250 + i * 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const asst = (content, i, stopReason) => ({ message: { role: "assistant", content, api: "openai-completions", provider: MOCK_PROVIDER, model: MOCK_MODEL, usage: usage(i), stopReason } });
  add("model_change", { provider: MOCK_PROVIDER, modelId: MOCK_MODEL });
  add("thinking_level_change", { thinkingLevel: "off" });
  for (let i = 0; n < entries; i++) {
    add("message", { message: { role: "user", content: [{ type: "text", text: `Turn ${i}: ${words(30)}` }] } });
    add("message", asst([{ type: "text", text: words(80) }, { type: "toolCall", id: `call_${i}`, name: "read", arguments: { path: `src/f${i}.ts` } }], i, "toolUse"));
    add("message", { message: { role: "toolResult", toolCallId: `call_${i}`, toolName: "read", content: [{ type: "text", text: words(400) }], isError: false } });
    add("message", asst([{ type: "text", text: words(120) }], i, "stop"));
  }
  return { id: sessionId, text: `${lines.join("\n")}\n`, entries: n };
}

/** Every .jsonl under `root` (live/ excluded) with its size, smallest first. */
export function listSessions(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (relative(root, p) !== "live") walk(p);
      } else if (e.name.endsWith(".jsonl")) out.push({ path: p, size: statSync(p).size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.size - b.size);
}

/**
 * Pick the real sample: `small` (25th percentile by size), `medium` (75th), `large` (the largest under
 * 12 MB, so a full transcript stays in reach), and every `listEvery`-th file for a listing of realistic
 * breadth. Returns [{ role, path, size }].
 */
export function pickRealSample(root, listEvery = 12) {
  const all = listSessions(root);
  if (all.length < 4) throw new Error(`too few sessions under ${root}: ${all.length}`);
  const at = (q) => all[Math.min(all.length - 1, Math.floor(q * all.length))];
  const large = [...all].reverse().find((f) => f.size < 12_000_000) ?? all.at(-1);
  const picked = [
    { role: "real-small", ...at(0.25) },
    { role: "real-medium", ...at(0.75) },
    { role: "real-large", ...large },
  ];
  const seen = new Set(picked.map((p) => p.path));
  all.forEach((f, i) => {
    if (i % listEvery === 0 && !seen.has(f.path)) picked.push({ role: "list", ...f });
  });
  return picked;
}

/**
 * Copy one real session file into `destRoot`, its header's cwd rewritten to `cwd` (so the hosted runtime
 * runs in a scratch directory, never in the real project), under pi's directory name for that cwd.
 * The source is only read.
 */
export function copyRealSession(src, destRoot, cwd) {
  const text = readFileSync(src, "utf8");
  const nl = text.indexOf("\n");
  const header = JSON.parse(text.slice(0, nl));
  header.cwd = cwd;
  const dir = join(destRoot, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(src));
  writeFileSync(dest, `${JSON.stringify(header)}${text.slice(nl)}`);
  return dest;
}

/** Write a synthesized session into `destRoot` under pi's naming; returns its path. */
export function writeSynth(entries, destRoot, cwd, seed) {
  const s = synthSession(entries, cwd, seed);
  const dir = join(destRoot, sessionDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.parse("2026-09-04T09:00:00.000Z") + seed * 1000).toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, `${ts}_${s.id}.jsonl`);
  writeFileSync(dest, s.text);
  return { path: dest, entries: s.entries };
}
