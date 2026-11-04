// Run: pnpm test -- server/merge-queue/branch-summaries.test.ts
// The merge queue's branch summaries (branch-summaries.ts): the ask's caps on a large branch, what counts as usable
// bullets, the store's transitions (writing → written, failed → Try Again, an earlier commit's bullets marked), one
// write in flight per commit, pruning, and the writer: the summary-line chain (never the title models), its calls
// recorded under the project with their own purpose (never `branch-summary`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { currentUsageContext } from "../../pi-config/extensions/llm-inflight/attribution.ts";
import type { LlmRuntime } from "../decide-llm";
import { scratchRoot } from "../test-scratch";
import {
  BODY_BUDGET,
  BRANCH_SUMMARY_PURPOSE,
  type BranchFacts,
  branchSummaryPrompt,
  BranchSummaries,
  type BulletWriter,
  FILES_MAX,
  readBranchFacts,
  readSummaryFile,
  SUBJECTS_MAX,
  summaryLineChain,
  summaryLineWriter,
  validBullets,
} from "./branch-summaries";
import { realGit } from "./guard";

const root = scratchRoot("sova-branch-summaries-");
const sha = (n: number) => n.toString(16).padStart(40, "0");

function facts(n: number, files = 3, body = "A body line that explains why.\nAnd another."): BranchFacts {
  return {
    branch: "feat/x",
    commit: sha(1),
    target: "master",
    messages: Array.from({ length: n }, (_, i) => ({ subject: `Change number ${n - i}`, body })),
    files: Array.from({ length: files }, (_, i) => ({ path: `src/part-${i}.ts`, added: i, removed: 1 })),
  };
}

test("the ask on a large branch: newest bodies in full until the budget, then subjects; at most 200 subjects and 80 parts", () => {
  const big = facts(260, 150, "x".repeat(2000));
  const p = branchSummaryPrompt(big);
  // Subjects capped, the cut said.
  assert.match(p, new RegExp(`the newest ${SUBJECTS_MAX} of 260`));
  assert.equal((p.match(/^- Change number /gm) ?? []).length, SUBJECTS_MAX);
  assert.ok(p.includes("Change number 260"), "the newest is in");
  assert.ok(!p.includes("Change number 60\n"), "the oldest beyond the cap are out");
  // Bodies only while they fit the budget: the newest has its body, an old one doesn't.
  const bodies = (p.match(/x{2000}/g) ?? []).length;
  assert.ok(bodies > 0 && bodies <= Math.floor(BODY_BUDGET / 2000), `${bodies} bodies`);
  // The parts: the largest 80, then "and N more".
  assert.equal((p.match(/^src\/part-\d+\.ts \+\d+ -\d+$/gm) ?? []).length, FILES_MAX);
  assert.match(p, /^and 70 more$/m);
  assert.ok(p.includes("src/part-149.ts"), "largest first");
  // Flat cost: twice the branch, about the same ask.
  const bigger = branchSummaryPrompt(facts(520, 300, "x".repeat(2000)));
  assert.ok(Math.abs(bigger.length - p.length) < 200, `${bigger.length} vs ${p.length}`);
  assert.ok(p.length < 60_000);
});

test("the ask fences its material as data, with a fence the material doesn't hold", () => {
  const f = facts(2);
  f.messages[0]!.body = "has ``` inside";
  const p = branchSummaryPrompt(f);
  assert.ok(p.includes("~~~~"));
  assert.ok(!branchSummaryPrompt(facts(1)).includes("~~~~"));
  assert.match(branchSummaryPrompt({ ...facts(0, 0) }), /\(none recorded\)/);
});

test("usable bullets: 1 to 5 plain strings, cut at 140, no code fence or HTML", () => {
  assert.deepEqual(validBullets(["Adds a thing", "  - Fixes   another "]), ["Adds a thing", "Fixes another"]);
  assert.equal(validBullets(Array.from({ length: 8 }, (_, i) => `b${i}`))?.length, 5);
  assert.equal(validBullets(["x".repeat(300)])![0]!.length, 140);
  assert.equal(validBullets([]), null);
  assert.equal(validBullets("Adds a thing"), null);
  assert.equal(validBullets(["ok", 3]), null);
  assert.equal(validBullets(["```js"]), null);
  assert.equal(validBullets(["<b>bold</b>"]), null);
  assert.equal(validBullets(["", "  "]), null);
});

/** A summaries store over a scratch file, with a writer the test holds. */
function store(name: string) {
  const file = join(root, name, "branch-summaries.json");
  const changed: string[] = [];
  const asks: string[] = [];
  let release: ((v: { bullets: string[]; model: string } | null) => void) | null = null;
  let answer: { bullets: string[]; model: string } | null = { bullets: ["Adds the thing"], model: "prov/a" };
  let hold = false;
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const writer: BulletWriter = (prompt) => {
    asks.push(prompt);
    if (hold) return new Promise((r) => (release = r));
    return Promise.resolve(answer);
  };
  const s = new BranchSummaries({
    fileOf: () => file,
    facts: async (_root, branch, commit) => ({ ...facts(2), branch, commit }),
    writer: () => writer,
    projectOf: () => "p1",
    changed: (r) => changed.push(r),
    // Each write a second after the last: "newest" is never a tie.
    now: () => (clock += 1000),
  });
  return {
    s,
    file,
    changed,
    asks,
    setAnswer: (a: typeof answer) => (answer = a),
    hold: (on: boolean) => (hold = on),
    release: (v: { bullets: string[]; model: string } | null) => release?.(v),
  };
}

test("written once per commit: Summarizing… while it runs, then the bullets; one write in flight; never rewritten", async () => {
  const t = store("once");
  t.hold(true);
  assert.equal(t.s.summaryOf("/r", "feat/x", sha(1)), undefined, "nothing before it reads Ready");
  const a = t.s.ensure("/r", "feat/x", sha(1));
  assert.equal(a.result, "started");
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(1)), { commit: sha(1), state: "writing" });
  assert.equal(t.s.ensure("/r", "feat/x", sha(1)).result, "busy");
  await new Promise((r) => setImmediate(r));
  t.release({ bullets: ["Adds the thing", "Fixes a bug"], model: "prov/a" });
  await a.done;
  assert.equal(t.asks.length, 1, "one ask for the commit");
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(1)), { commit: sha(1), state: "ready", bullets: ["Adds the thing", "Fixes a bug"] });
  assert.equal(t.s.ensure("/r", "feat/x", sha(1)).result, "known");
  assert.equal(t.asks.length, 1);
  assert.ok(t.changed.length >= 2, "started and written each publish the rows");
  // Kept on disk: a new store (a restart) reads it.
  const rec = readSummaryFile(t.file)[sha(1)];
  assert.ok(rec && "bullets" in rec && rec.bullets.length === 2);
  // A summary that worked offers no Try Again.
  const r = t.s.retry("/r", "feat/x", sha(1));
  assert.equal(r.ok, false);
});

test("a failure says so and waits for Try Again; Try Again writes the same commit again", async () => {
  const t = store("fail");
  t.setAnswer(null);
  await t.s.ensure("/r", "feat/x", sha(2)).done;
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(2)), { commit: sha(2), state: "failed" });
  assert.equal(t.s.ensure("/r", "feat/x", sha(2)).result, "known", "no automatic retry for the same commit");
  t.setAnswer({ bullets: ["Now it works"], model: "prov/b" });
  const r = t.s.retry("/r", "feat/x", sha(2));
  assert.ok(r.ok);
  await r.done;
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(2))?.bullets, ["Now it works"]);
  assert.equal(t.s.retry("/r", "feat/x", sha(9)).ok, false, "nothing to retry for an unknown commit");
});

test("a newer commit: the earlier bullets stay up, marked, until new ones are written", async () => {
  const t = store("stale");
  await t.s.ensure("/r", "feat/x", sha(3)).done;
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(4)), { commit: sha(4), state: "ready", bullets: ["Adds the thing"], stale: { commit: sha(3) } });
  assert.equal(t.s.summaryOf("/r", "feat/other", sha(4)), undefined, "another branch's bullets are never shown");
  t.hold(true);
  const w = t.s.ensure("/r", "feat/x", sha(4));
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(4)), { commit: sha(4), state: "writing", bullets: ["Adds the thing"], stale: { commit: sha(3) } });
  await new Promise((r) => setImmediate(r));
  t.release({ bullets: ["The new thing"], model: "prov/a" });
  await w.done;
  assert.deepEqual(t.s.summaryOf("/r", "feat/x", sha(4)), { commit: sha(4), state: "ready", bullets: ["The new thing"] });
});

test("pruned: a branch gone or landed loses what no row shows; a live branch keeps its newest", async () => {
  const t = store("prune");
  for (const n of [10, 11, 12, 13]) await t.s.ensure("/r", "feat/live", sha(n)).done;
  await t.s.ensure("/r", "feat/gone", sha(20)).done;
  await t.s.ensure("/r", "feat/landed", sha(30)).done;
  const dropped = t.s.prune("/r", new Set(["feat/live"]), new Set([sha(30)]));
  const left = Object.keys(readSummaryFile(t.file)).sort();
  assert.equal(dropped, 2);
  assert.deepEqual(left, [sha(11), sha(12), sha(13), sha(30)].sort());
});

test("the writer is the summary-line chain, recorded under the project as its own purpose", async () => {
  const dir = join(root, "agent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "topic-outline.json");
  writeFileSync(file, JSON.stringify({ summarizers: [{ backend: "pi", model: "prov/outline-a", timeoutMs: 7000 }, { backend: "pi", model: "prov/outline-b" }] }));
  const chain = summaryLineChain(file);
  assert.deepEqual(
    chain.map((c) => c.choice.model),
    ["prov/outline-a", "prov/outline-b"],
  );
  assert.equal(chain[0]!.timeoutMs, 7000);
  const seen: { model: string; purpose?: string; project?: string; owner?: string | null }[] = [];
  const runtime: LlmRuntime = {
    getModel: (_p: string, id: string) => ({ id, reasoning: false }),
    hasConfiguredAuth: () => true,
    completeSimple: async (m: never) => {
      const ctx = currentUsageContext();
      const model = (m as { id: string }).id;
      seen.push({ model, ...(ctx?.purpose ? { purpose: ctx.purpose } : {}), ...(ctx?.project ? { project: ctx.project } : {}), owner: ctx?.owner });
      const text = model === "outline-a" ? "not json" : '{"bullets": ["Adds branch summaries"]}';
      return { content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1 } } as never;
    },
  } as unknown as LlmRuntime;
  const write = summaryLineWriter(() => ({ runtime: async () => runtime, agentDir: () => dir }), () => chain);
  const out = await write("the ask", "proj-1");
  assert.deepEqual(out, { bullets: ["Adds branch summaries"], model: "prov/outline-b" });
  assert.deepEqual(
    seen.map((s) => s.model),
    ["outline-a", "outline-b"],
    "primary first, then the fallback after an unusable answer",
  );
  for (const s of seen) {
    assert.equal(s.purpose, BRANCH_SUMMARY_PURPOSE);
    assert.notEqual(s.purpose, "branch-summary");
    assert.equal(s.project, "proj-1");
    assert.equal(s.owner, null);
  }
  // A model Settings → Models turns off is skipped.
  seen.length = 0;
  const skip = summaryLineWriter(() => ({ runtime: async () => runtime, agentDir: () => dir, problem: async (c) => (c.model === "prov/outline-a" ? "turned off" : null) }), () => chain);
  await skip("the ask", "proj-1");
  assert.deepEqual(
    seen.map((s) => s.model),
    ["outline-b"],
  );
});

test("the facts from git: messages newest first with bodies, parts with +/− (binary as unknown)", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feat/x");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git("commit", "-qam", "First change\n\nWhy it was needed.");
  writeFileSync(join(repo, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
  git("add", "-A");
  git("commit", "-qm", "Second change");
  const head = git("rev-parse", "HEAD");
  const f = await readBranchFacts(realGit, repo, { branch: "feat/x", commit: head, target: "master", targetHead: base });
  assert.ok(f);
  assert.deepEqual(
    f.messages.map((m) => m.subject),
    ["Second change", "First change"],
  );
  assert.equal(f.messages[1]!.body, "Why it was needed.");
  assert.deepEqual(f.files.find((x) => x.path === "a.txt"), { path: "a.txt", added: 1, removed: 0 });
  assert.deepEqual(f.files.find((x) => x.path === "b.bin"), { path: "b.bin", added: null, removed: null });
  assert.ok(!readFileSync(join(repo, "a.txt"), "utf8").includes("x"));
});
