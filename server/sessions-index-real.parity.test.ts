// Run: pnpm test -- server/sessions-index-real.parity.test.ts
//
// The no-regression gate on REAL sessions: a sample of this checkout's hermetic copy of the user's
// sessions (<checkout>/.agent/sessions, which the A/B bench fills; never ~/.pi) is copied into a
// throwaway agent dir, with the list's own stores (titles, groups, archive marks, drafts, seen,
// tags, web ids) when the copy has them. On it, the baseline revision's own full build, the new
// tracked list and the new full list must agree row for row; then an agent-like load appends real
// lines (each a copy of one the file already holds) to random files, and they must agree after
// each burst. With no copy present the file says so and checks nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "../shared/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
/** The copy to sample: this checkout's hermetic .agent, or what a local, untracked
    .tmp/verifier/real-source names (one line: an agent dir, or a sessions folder itself, as the
    bench's .tmp/bench-sessions; read only, never written). */
const pointer = join(repo, ".tmp", "verifier", "real-source");
const named = existsSync(pointer) ? resolve(repo, readFileSync(pointer, "utf8").trim()) : join(repo, ".agent");
const sessionsRoot = existsSync(join(named, "sessions")) ? join(named, "sessions") : named;
const source = existsSync(join(named, "sessions")) ? named : dirname(named);
const SAMPLE = 300;

/** Every session file of the copy, by folder (the sessions dir's own layout). */
function sourceFiles(): string[] {
  const root = sessionsRoot;
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, d.name);
    if (d.isFile() && d.name.endsWith(".jsonl")) out.push(p);
    else if (d.isDirectory() && d.name !== "live") for (const f of readdirSync(p, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl")) out.push(join(p, f.name));
  }
  return out;
}
const all = sourceFiles();

if (!all.length) {
  test("real-session parity: no copy of the real sessions in .agent/sessions yet (nothing checked)", (t) => {
    t.skip(`${sessionsRoot} holds no session files: run the bench's copy first`);
  });
} else {
  const agentDir = mkdtempSync(join(tmpdir(), "sova-list-real-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  after(() => rmSync(agentDir, { recursive: true, force: true }));

  // The sample: the 40 biggest, the 160 newest, and a seeded spread of the rest.
  const st = new Map(all.map((p) => [p, statSync(p)]));
  const bySize = [...all].sort((a, b) => st.get(b)!.size - st.get(a)!.size);
  const byTime = [...all].sort((a, b) => st.get(b)!.mtimeMs - st.get(a)!.mtimeMs);
  const pick = new Set<string>([...bySize.slice(0, 40), ...byTime.slice(0, 160)]);
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  while (pick.size < Math.min(SAMPLE, all.length)) pick.add(all[Math.floor(rand() * all.length)]!);
  const copies: string[] = [];
  for (const p of pick) {
    const rel = p.slice(sessionsRoot.length + 1);
    const to = join(agentDir, "sessions", rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(p, to);
    const s = st.get(p)!;
    utimesSync(to, s.atime, s.mtime);
    copies.push(to);
  }
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
  // The list's own stores, when the copy has them (no live records: no copied process is alive).
  const stores = ["archived-sessions.json", "session-titles.json", "session-groups.json", "drafts.json", "seen.json", "session-tags.json", "web-sessions.json", "signals.json"];
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  for (const f of stores) if (existsSync(join(source, "sova", f))) copyFileSync(join(source, "sova", f), join(agentDir, "sova", f));

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const rev = process.env.SOVA_PARITY_BASE || git("merge-base", "HEAD", "master");
  let src = git("show", `${rev}:server/sessions-index.ts`);
  src = src.replace(/(from\s+|import\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_m, pre: string, q: string, rel: string) => `${pre}${q}${resolve(here, rel)}${q}`);
  src += "\nexport { buildSessions as __parityBuild };\n";
  const baseDir = mkdtempSync(join(tmpdir(), "sova-list-real-base-"));
  writeFileSync(join(baseDir, "sessions-index.baseline.ts"), src);
  const OLD = await import(join(baseDir, "sessions-index.baseline.ts"));
  // Merge readiness reads Git and runs the spec tools on the trees the sessions name, in the
  // background: on copied sessions those are the user's real worktrees. Made inert here (no
  // answer ever arrives, nothing runs, nothing is sent), so both builds read the same (absent)
  // readiness; readiness itself is compared in sessions-index.parity.test.ts with Git faked.
  const readiness = await import("./merge-readiness");
  readiness.configureReadiness({
    insights: { treeStatus: () => new Promise<never>(() => {}) },
    git: async () => ({ code: 1, stdout: "", stderr: "" }),
    gone: async () => null as never,
    treeStamp: () => null,
    inputsStamp: () => null,
    finished: () => "off" as never,
    drafts: () => undefined,
    draftsHash: () => undefined,
    docsPreview: undefined,
    nudge: async () => {},
    served: async () => false,
    followUps: undefined,
    asksUser: () => undefined,
  });
  const NEW = await import("./sessions-index");
  const { sessionsChanged } = await import("./list-generation");
  const { canonicalPath } = await import("./paths");
  const tracked = NEW.trackSessionFiles();
  after(() => tracked.stop());

  const order = (rows: readonly SessionSummary[]) => [...rows].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || (a.path < b.path ? -1 : 1));
  async function agree(label: string): Promise<number> {
    const fresh = order(await NEW.listSessionsTracked());
    const old = order(await OLD.__parityBuild());
    sessionsChanged();
    const full = order(await NEW.listSessions());
    const oldBy = new Map(old.map((s) => [s.path, s]));
    const diff = (a: SessionSummary[]): unknown[] =>
      a.flatMap((s): unknown[] => {
        const o = oldBy.get(s.path);
        if (!o) return [{ path: s.path, only: "new" }];
        const keys = [...new Set([...Object.keys(s), ...Object.keys(o)])].filter((k) => JSON.stringify((s as any)[k]) !== JSON.stringify((o as any)[k]));
        return keys.length ? [{ path: basename(s.path), fields: Object.fromEntries(keys.map((k) => [k, { new: (s as any)[k], old: (o as any)[k] }])) }] : [];
      });
    assert.deepEqual(diff(fresh).slice(0, 5), [], `${label}: the tracked list's rows`);
    assert.deepEqual(diff(full).slice(0, 5), [], `${label}: the full list's rows`);
    assert.deepEqual(fresh.map((s) => s.path), old.map((s) => s.path), `${label}: the same rows in the same order (tracked)`);
    assert.deepEqual(full.map((s) => s.path), old.map((s) => s.path), `${label}: the same rows in the same order (full)`);
    return old.length;
  }

  test(`real-session parity on a sample of ${pick.size} of ${all.length} copied sessions: the first build`, async () => {
    const n = await agree("first build");
    assert.ok(n > 0, "the sample lists something");
  });

  test("real-session parity under an agent-like load: real lines appended in bursts, each burst noted", async () => {
    const lines = new Map<string, string[]>();
    const tailLines = (p: string) => {
      let l = lines.get(p);
      if (!l) {
        const text = readFileSync(p, "utf8");
        l = text.slice(Math.max(0, text.length - 64 * 1024)).split("\n").slice(1).filter((x) => x.trim().startsWith("{"));
        lines.set(p, l);
      }
      return l;
    };
    for (let burst = 0; burst < 12; burst++) {
      const touched = new Set<string>();
      const count = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < count; i++) {
        const p = copies[Math.floor(rand() * copies.length)]!;
        const l = tailLines(p);
        if (!l.length) continue;
        appendFileSync(p, `${l[Math.floor(rand() * l.length)]}\n`);
        touched.add(p);
      }
      for (const p of touched) tracked.note(canonicalPath(p));
      await agree(`burst ${burst} (${touched.size} files)`);
    }
  });
}
