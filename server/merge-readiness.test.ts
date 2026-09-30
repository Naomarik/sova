import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-readiness-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

import type { SessionSummary, WorktreeStatus } from "../shared/protocol";
import type { GitResult } from "./worktrees";
const r = await import("./merge-readiness");
const { createFakeProvider } = await import("./decide-fake");
const { MergeFollowUps } = await import("./merge-followup");

/**
 * Merge readiness (§chat.worktrees/readiness), driven by the shapes of real sessions: the six of the
 * Jev audit (REPORT §6.2) and the confusion cases the reviewer mined (R1–R9). Git is faked; no
 * model is ever called.
 */

const idle = { running: false, openQuestions: 0, asks: false };
const tree = (over: Partial<Parameters<typeof r.treeReadiness>[0]> = {}) => ({ path: "/wt/x", branch: "feat/x", tracked: "active" as const, readable: true, merged: false, dirty: false, ahead: 1, ...over });

// Real reply tails (trimmed), as the sessions ended.
const EDCD_REPLY = `**Not covered:** the sidebar's rename still has the same overwrite problem. I'd fix it separately.

Both describe the new behaviour. Shall I record the spec update and merge the branch into master? The merge doesn't restart the live server.

Also changes: §app.subagents-pane/tabs — the Agents board's team chips and \`#/agents/{teamKey}\` links open the pane on Agents; §app.insights/usage-page-and-agents-page — board rows no longer fold in workers and teams`;
const E82A_REPLY = `**To make it live:**
- Your terminal sessions pick it up at their next \`/reload\`.
- The web server needs a \`sova-runtime\` restart. It last started at 22:26:59, before this merge.

This is a real improvement over the old setup, but not a clean pass. On the scenario nobody tuned the fixes for, all 3 test runs still failed on at least one point. The open gaps are listed in \`~/.cache/spec-ab/FINAL-FIX.md\`:
- claim text fixed by hand in merge conflicts is flagged but not blocked;
- \`team-smoke.mjs\` fails on master too.

al_1 is marked done. Nothing was pushed.

Also changes: §chat.worktrees/merge-card — a merge into the default branch asks for a promotion`;
const EB99_REPLY = `- **Weak spot, groups:** on the prompt that invites a group, every model used one, but only 10 of 18 drew on the first try, against 14 of 18 on master. A small follow-up could make the parser accept a node that sits in two groups, or add "groups don't nest" to the guide.

**Not live yet:** it needs a frontend rebuild, and the \`sova-runtime\` restart for the retry check to use the new parser.`;
const ECD7_REPLY = `The change is frontend-only, so there's a simpler way to put it live. Want me to set up option 1?`;

test("01a0edcd: 1 ahead, clean, 0 of 3 open, checks run, the reply asks to merge → waiting for your OK", () => {
  const asks = r.asksToMerge(EDCD_REPLY);
  assert.equal(asks, true, "the ask sits above the Also changes line and still counts");
  const t = r.treeReadiness(tree({ branch: "feat/agents-row-dropdown" }), { ...idle, asks, lastCheck: { at: 1, ok: true } });
  assert.deepEqual(t, { state: "waiting-approval", why: "checks passed" });
  const s = r.sessionReadinessOf([{ path: "/wt/a", branch: "feat/agents-row-dropdown", ...t }], {}, 5);
  assert.equal(s?.badge, "waiting");
  assert.equal(s?.branch, "feat/agents-row-dropdown");
});

test("01a0ecd7: 2 ahead, clean, 1 of 3 open and a TEMP commit → blocked; answered, the TEMP commit still keeps it off ready", () => {
  const temp = r.tempCommitOf(["fix viewport on resume", "TEMP(viewport-test): floating Reload tab"]);
  assert.equal(temp, "TEMP(viewport-test): floating Reload tab");
  const facts = tree({ branch: "feat/viewport-height", ahead: 2, tempCommit: temp });
  assert.equal(r.treeReadiness(facts, { ...idle, openQuestions: 1, asks: r.asksToMerge(ECD7_REPLY) }).state, "blocked");
  assert.deepEqual(r.treeReadiness(facts, idle), { state: "in-progress", why: `temporary commit: ${temp}` });
  assert.equal(r.asksToMerge(ECD7_REPLY), false, "asking about a test setup is not asking to merge");
  for (const s of ["WIP: half", "fixup! earlier", "squash! x", "amend! y", "temp: probe"]) assert.ok(r.tempCommitOf([s]), s);
  assert.equal(r.tempCommitOf(["Temperature units", "attempt 2"]), undefined);
});

test("01a0eef8: ahead 0 with 10 dirty files is never merged, running or not", () => {
  // treeFacts says merged only after a commit of the branch's own; here HEAD is still the base.
  const t = tree({ branch: "feat/align-chip-whole-branch", merged: false, ahead: 0, dirty: true });
  assert.equal(r.treeReadiness(t, { ...idle, running: true }).state, "in-progress");
  assert.deepEqual(r.treeReadiness(t, idle), { state: "in-progress", why: "uncommitted changes" });
  // And merged with uncommitted work left behind is stale, never merged.
  assert.deepEqual(r.treeReadiness(tree({ merged: true, dirty: true, tracked: "merged" }), idle), { state: "stale", why: "merged, with uncommitted changes" });
  assert.equal(r.treeReadiness(tree({ merged: true, dirty: true }), { ...idle, running: true }).state, "in-progress");
});

test("01a0ebbf: merged and clean, the server started before the merge → restart pending", () => {
  const t = r.treeReadiness(tree({ tracked: "merged", merged: true }), idle);
  assert.deepEqual(t, { state: "merged" });
  const s = r.sessionReadinessOf([{ path: "/wt/rm", branch: "feat/resource-monitor", ...t }], { lastMerge: { at: 50, branch: "feat/resource-monitor" }, restartPending: true, pushPending: true }, 60);
  assert.equal(s?.badge, "restart");
  assert.equal(s?.since, 50, "dated by the merge");
  assert.equal(s?.pushPending, true);
});

test("01a0eb99 (R2, R9): two merged, two still tracked active that git finds merged → merged with cleanup follow-ups", () => {
  const trees = [
    { path: "/wt/1", branch: "feat/vis-reliability", ...r.treeReadiness(tree({ merged: true }), idle) },
    { path: "/wt/2", branch: "feat/vis-wireframe", ...r.treeReadiness(tree({ merged: true }), idle) },
    { path: "/wt/3", branch: "feat/vis-wireframe-numbers", ...r.treeReadiness(tree({ tracked: "merged", merged: true }), idle) },
    { path: "/wt/4", branch: "feat/vis-round4", ...r.treeReadiness(tree({ tracked: "merged", merged: true }), idle) },
  ];
  assert.deepEqual(trees.map((t) => t.state), ["merged", "merged", "merged", "merged"]);
  const s = r.sessionReadinessOf(trees, { lastMerge: { at: 9, branch: "feat/vis-round4" }, followUp: { weight: "small", cue: "x" } }, 10);
  assert.equal(s?.badge, "merged");
  assert.equal(s?.cleanup, 2);
  assert.equal(s?.followUps, 3);
  assert.equal(s?.branch, "feat/vis-round4");
  // R9: one merged, one still in progress: no one-word badge hides the unmerged one.
  const mixed = r.sessionReadinessOf([trees[3]!, { path: "/wt/5", branch: "feat/next", state: "in-progress", why: "uncommitted changes" }], { lastMerge: { at: 9, branch: "feat/vis-round4" } }, 10);
  assert.equal(mixed?.badge, undefined);
  assert.equal(mixed?.trees.length, 2, "both trees stay listed for the title and the Session tab");
});

test("01a0e82a: merged with a significant follow-up → a decide item quoting the reply's own line", async () => {
  const { cueOf, followUpOf } = await import("./merge-followup");
  const cue = cueOf(E82A_REPLY, "feat/spec-enforce");
  assert.match(cue, /^This is a real improvement over the old setup, but not a clean pass\. .*…$/);
  assert.ok(cue.length <= 120);
  const followUp = followUpOf({ at: 1, replyId: "ad987178", cue, provider: "jev", model: "m", answers: { follow_up: { type: "boolean", p: 0.93 }, follow_up_weight: { type: "score", score: 1.8, probabilities: [0.05, 0.1, 0.85], confidence: 0.7 } } });
  assert.deepEqual(followUp, { weight: "significant", cue });
  const readiness = r.sessionReadinessOf([{ path: "/wt/se", branch: "feat/spec-enforce", state: "merged" }], { lastMerge: { at: 7, branch: "feat/spec-enforce" }, followUp }, 8);
  const row = { id: "s1", path: "/s/1.jsonl", busy: false, archived: false, readiness } as unknown as SessionSummary;
  assert.deepEqual(r.readinessItems(row), [{ tier: "decide", kind: "merged-open-work", since: 7, detail: `Merged with open work: ${cue}` }]);
  // The groups regression in 01a0eb99 is the cue there; the restart line is routine, never one.
  assert.match(cueOf(EB99_REPLY, "feat/vis-round4"), /^Weak spot, groups/);
  assert.equal(cueOf("Merged.\n\nNot live yet: needs a restart.\n\nDeferred: §x — later", "feat/x"), "Deferred: §x — later");
  // No line names the work (01a0e348's shape): point at the reply, never a bare branch name.
  assert.equal(cueOf("Merged. Nothing else.", "feat/image-size"), "see the reply after merging feat/image-size");
});

test("the follow-up answer: small below 1.5 or unsure, none under the P and score floors", async () => {
  const { followUpOf } = await import("./merge-followup");
  const rec = (p: number, score: number, confidence = 0.9) => ({ at: 1, replyId: "r", cue: "c", provider: "jev", model: "m", answers: { follow_up: { type: "boolean" as const, p }, follow_up_weight: { type: "score" as const, score, probabilities: [], confidence } } });
  assert.equal(followUpOf(rec(0.4, 1.9)), undefined);
  assert.equal(followUpOf(rec(0.9, 0.3)), undefined);
  assert.equal(followUpOf(rec(0.9, 1.0))?.weight, "small");
  assert.equal(followUpOf(rec(0.9, 1.7, 0.3))?.weight, "small", "significant needs confidence");
  assert.equal(followUpOf(rec(0.9, 1.7))?.weight, "significant");
  assert.equal(followUpOf(undefined), undefined);
});

test("R4: ready and asking 'Shall I merge it into master?' → an act item 'Ready to merge: <branch>', not while running or archived", () => {
  assert.equal(r.asksToMerge("1 ahead, tests pass.\n\nShall I merge it into master?"), true);
  for (const s of ["Want me to merge this now?", "It's ready to merge.", "Say merge and I'll land it.", "Should I go ahead and merge it?", "OK to merge?"]) assert.ok(r.asksToMerge(s), s);
  for (const s of ["Merged into master at abc1234.", "Want me to take it on?", "I merged the fix."]) assert.equal(r.asksToMerge(s), false, s);
  const readiness = r.sessionReadinessOf([{ path: "/wt/a", branch: "feat/a", state: "waiting-approval", why: "checks passed" }], {}, 42);
  const row = (over: Partial<SessionSummary>) => ({ id: "s", path: "/s/a.jsonl", busy: false, archived: false, readiness, ...over }) as unknown as SessionSummary;
  assert.deepEqual(r.readinessItems(row({})), [{ tier: "act", kind: "ready-to-merge", since: 42, detail: "Ready to merge: feat/a" }]);
  assert.deepEqual(r.readinessItems(row({ busy: true })), []);
  assert.deepEqual(r.readinessItems(row({ archived: true })), []);
});

test("a failed or missing check: failed keeps it off ready, none is still ready and says so", () => {
  assert.deepEqual(r.treeReadiness(tree(), { ...idle, lastCheck: { at: 1, ok: false } }), { state: "in-progress", why: "the last check failed" });
  assert.deepEqual(r.treeReadiness(tree(), idle), { state: "ready", why: "no check run seen" });
  assert.equal(r.checkFailed(false, "ℹ tests 12\nℹ pass 12\nℹ fail 0\n"), false);
  assert.equal(r.checkFailed(false, "ℹ tests 12\nℹ pass 11\nℹ fail 1\n"), true);
  assert.equal(r.checkFailed(false, "src/x.ts(3,1): error TS2304: Cannot find name"), true);
  assert.equal(r.checkFailed(true, "anything"), true);
  assert.ok(r.CHECK_RE.test("cd /wt && pnpm run typecheck 2>&1 | tail"));
  assert.ok(r.CHECK_RE.test("pnpm test"));
  assert.ok(r.CHECK_RE.test("node --import tsx --test server/a.test.ts"));
  assert.equal(r.CHECK_RE.test("git status"), false);
});

test("R5: only server-side files ask for a restart; src/, docs and tests never do", () => {
  for (const f of ["server/index.ts", "shared/protocol.ts", "pi-config/extensions/mode/align.ts", "package.json", "pnpm-lock.yaml"]) assert.ok(r.needsRestart(f), f);
  for (const f of ["src/components/Sidebar.tsx", "server/README.md", "server/attention.test.ts", ".sova/spec/manifest.json", "e2e/x.mjs"]) assert.equal(r.needsRestart(f), false, f);
});

test("R8: one restart item for the whole server, however many sessions ask", () => {
  const s = (id: string, branch: string, since: number) => ({ id, path: `/s/${id}.jsonl`, title: id, readiness: { trees: [], badge: "restart", branch, since, restartPending: true } }) as unknown as SessionSummary;
  const items = r.restartItems([s("a", "feat/a", 5), s("b", "feat/b", 9), { id: "c", path: "/s/c.jsonl" } as SessionSummary]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "restart-pending");
  assert.equal(items[0]!.tier, "decide");
  assert.equal(items[0]!.path, "");
  assert.equal(items[0]!.detail, "Restart pending: 2 merges changed the server since it started (feat/a, feat/b).");
  assert.equal(items[0]!.href, "#/s/%2Fs%2Fb.jsonl", "links the newest");
  assert.deepEqual(r.restartItems([]), []);
});

// --- the file and git, together -------------------------------------------------------------

const SID = "01a0edcd-e385-72b1-a202-737eb23ceb52";
let n = 0;
const id = () => `e${String(++n).padStart(7, "0")}`;
function sessionFile(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sova-readiness-s-"));
  const path = join(dir, `2026-09-29T15-34-48-453Z_${SID}.jsonl`);
  writeFileSync(path, `${[{ type: "session", version: 3, id: SID, timestamp: "2026-09-29T15:34:48.453Z", cwd: "/home/u/webapps/sova" }, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}
/** A chain of entries, each the child of the one before. */
function chain(items: object[]): object[] {
  let parent: string | null = null;
  return items.map((it) => {
    const e = { ...it, id: id(), parentId: parent };
    parent = e.id;
    return e;
  });
}
const worktrees = (trees: object[], at: string) => ({ type: "custom", customType: "worktrees", data: { version: 1, trees }, timestamp: at });
const tracked = (over: object = {}) => ({ path: "/wt/agents-row-dropdown", branch: "feat/agents-row-dropdown", base: "b0", baseBranch: "master", status: "active", session: SID, how: "created", at: 1, ...over });
const assistant = (content: object[], stopReason: string, at: string) => ({ type: "message", timestamp: at, message: { role: "assistant", content, stopReason } });
const toolResult = (toolCallId: string, text: string, isError: boolean, at: string) => ({ type: "message", timestamp: at, message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError } });
const user = (text: string, at: string) => ({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });

function fakeGit(map: Record<string, Partial<GitResult>>): (args: readonly string[]) => Promise<GitResult> {
  return async (args) => {
    const key = args.join(" ");
    const hit = Object.entries(map).find(([k]) => key.startsWith(k));
    return { code: 0, stdout: "", stderr: "", ...(hit?.[1] ?? { code: 1 }) };
  };
}

function summary(path: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: SID, path, cwd: "/home/u/webapps/sova", title: "t", createdAt: "", lastActiveAt: "2026-09-29T19:44:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false, ...over };
}

test("the file's facts: tracked trees, a check's result, the last reply; a later prompt clears the reply", async () => {
  const lines = chain([
    user("add the dropdown", "2026-09-29T15:35:00.000Z"),
    worktrees([tracked()], "2026-09-29T15:36:00.000Z"),
    assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cd /wt && pnpm test 2>&1 | tail -5" } }], "toolUse", "2026-09-29T19:40:00.000Z"),
    toolResult("c1", "ℹ tests 900\nℹ pass 900\nℹ fail 0", false, "2026-09-29T19:41:00.000Z"),
    assistant([{ type: "text", text: EDCD_REPLY }], "stop", "2026-09-29T19:44:00.000Z"),
  ]);
  const path = sessionFile(lines);
  const { size } = await import("node:fs").then((fs) => fs.statSync(path));
  const { scan, facts } = await r.readReadinessScan(path, size, null);
  assert.equal(scan.found, true);
  assert.equal(facts?.trees[0]?.branch, "feat/agents-row-dropdown");
  assert.deepEqual(facts?.lastCheck, { at: Date.parse("2026-09-29T19:41:00.000Z"), ok: true });
  assert.equal(facts?.lastReply?.text.includes("Shall I record the spec update"), true);
  // Appended: the user answers. Read incrementally from where the last read stopped.
  const more = chain([user("yes, merge", "2026-09-29T19:50:00.000Z")]);
  (more[0] as { parentId: string | null }).parentId = (lines.at(-1) as { id: string }).id;
  writeFileSync(path, `${JSON.stringify(more[0])}\n`, { flag: "a" });
  const again = await r.readReadinessScan(path, (await import("node:fs")).statSync(path).size, scan);
  assert.equal(again.facts?.lastReply, undefined, "the user spoke after the reply: it no longer asks");
  // A file that never tracked a worktree is only searched.
  const plain = sessionFile(chain([user("hi", "2026-09-29T15:35:00.000Z")]));
  const none = await r.readReadinessScan(plain, (await import("node:fs")).statSync(plain).size, null);
  assert.deepEqual([none.scan.found, none.facts], [false, null]);
});

test("computeReadiness end to end with git faked: waiting for the OK, then merged by someone else (R1), then content-merged (R3)", async () => {
  const lines = chain([
    worktrees([tracked()], "2026-09-29T15:36:00.000Z"),
    assistant([{ type: "text", text: EDCD_REPLY }], "stop", "2026-09-29T19:44:00.000Z"),
  ]);
  const path = sessionFile(lines);
  const fs = await import("node:fs");
  const { facts } = await r.readReadinessScan(path, fs.statSync(path).size, null);
  let status: WorktreeStatus & { head?: string; subjects?: string[] } = { path: "/wt/agents-row-dropdown", source: "session", exists: true, branch: "feat/agents-row-dropdown", base: "master", merged: "no", ahead: 1, behind: 0, dirty: false, head: "h1", subjects: ["agents board: row dropdown"] };
  r.configureReadiness({ insights: { treeStatus: async () => status }, git: fakeGit({}), asksUser: () => undefined, now: () => 0, processStart: 0 });
  const waiting = await r.computeReadiness(summary(path), facts!);
  assert.equal(waiting?.badge, "waiting");
  assert.deepEqual(waiting?.trees, [{ path: "/wt/agents-row-dropdown", branch: "feat/agents-row-dropdown", state: "waiting-approval", why: "no check run seen" }]);
  // The attention signal's answer for this very reply wins over the fallback.
  r.configureReadiness({ asksUser: () => ({ turnId: (lines.at(-1) as { id: string }).id, asks: false }) });
  assert.equal((await r.computeReadiness(summary(path), facts!))?.badge, "ready");
  // R1: someone else merged it (ancestor), the row still says active: merged, with a cleanup follow-up.
  status = { ...status, merged: "ancestor", ahead: 0 };
  const merged = await r.computeReadiness(summary(path), facts!);
  assert.deepEqual([merged?.badge, merged?.cleanup, merged?.followUps], ["merged", 1, 1]);
  // R3: a rebased merge train changed the shas: merged by content.
  status = { ...status, merged: "content", ahead: 3 };
  assert.equal((await r.computeReadiness(summary(path), facts!))?.badge, "merged");
  // HEAD still at its base: never merged, whatever ancestry says (the 01a0eef8 shape).
  status = { ...status, merged: "ancestor", ahead: 0, head: "b0", dirty: true };
  assert.equal((await r.computeReadiness(summary(path), facts!))?.trees[0]?.state, "in-progress");
  // An inherited tree (a fork's) is not this session's to judge.
  const forked = await r.computeReadiness(summary(path, { id: "other-session" }), facts!);
  assert.equal(forked, undefined);
  r.resetReadiness();
});

test("restart pending: a merge into the branch this server runs, touching server files, after it started; src-only never", async () => {
  const card = (sha: string, at: string) => ({ type: "custom_message", customType: "worktree-merge", content: "Merged", display: true, timestamp: at, details: { version: 1, path: "/wt/rm", branch: "feat/resource-monitor", target: "master", sha, commits: 18, added: 10, removed: 2, fastForward: true, how: "tool" } });
  const lines = chain([
    worktrees([tracked({ path: "/wt/rm", branch: "feat/resource-monitor", status: "merged", merge: { target: "master", sha: "s1", at: 1, how: "tool" } })], "2026-09-29T09:58:19.140Z"),
    card("s1", "2026-09-29T09:58:19.141Z"),
    assistant([{ type: "text", text: "Merged. It needs a restart of sova-runtime.service." }], "stop", "2026-09-29T09:59:00.000Z"),
  ]);
  const path = sessionFile(lines);
  const fs = await import("node:fs");
  const { facts } = await r.readReadinessScan(path, fs.statSync(path).size, null);
  assert.equal(facts?.merges[0]?.reply?.text.startsWith("Merged."), true, "the first reply that ends a turn after the card");
  const st = { path: "/wt/rm", source: "session" as const, exists: true, branch: "feat/resource-monitor", base: "master", merged: "ancestor" as const, ahead: 0, dirty: false, head: "s1" };
  const git = (files: string) =>
    fakeGit({
      "rev-parse --show-toplevel": { stdout: "/home/u/webapps/sova\n" },
      "symbolic-ref --short -q HEAD": { stdout: "master\n" },
      "merge-base --is-ancestor s1 HEAD": { code: 0 },
      "diff --name-only --no-renames s1~18 s1": { stdout: files },
      "rev-parse --verify -q refs/remotes/origin/master": { stdout: "o1\n" },
      "merge-base --is-ancestor s1 o1": { code: 1 },
    });
  const started = Date.parse("2026-09-29T06:00:00.000Z");
  r.configureReadiness({ insights: { treeStatus: async () => st }, git: git("server/resource-monitor.ts\nsrc/app.css\n"), processStart: started, asksUser: () => undefined });
  const pending = await r.computeReadiness(summary(path), facts!);
  assert.deepEqual([pending?.badge, pending?.restartPending, pending?.pushPending], ["restart", true, true]);
  r.resetReadiness();
  r.configureReadiness({ insights: { treeStatus: async () => st }, git: git("src/app.css\nsrc/components/Sidebar.tsx\n"), processStart: started, asksUser: () => undefined });
  assert.equal((await r.computeReadiness(summary(path), facts!))?.badge, "merged", "a src-only merge needs no restart");
  r.resetReadiness();
  r.configureReadiness({ insights: { treeStatus: async () => st }, git: git("server/x.ts\n"), processStart: Date.parse("2026-09-29T12:00:00.000Z"), asksUser: () => undefined });
  assert.equal((await r.computeReadiness(summary(path), facts!))?.restartPending, undefined, "the server started after the merge");
  r.resetReadiness();
});

test("the follow-up check: once per card, only with attention on and a fresh reply, never a real provider", async () => {
  const settings = { jev: { enabled: true }, fallback: null, features: { attention: true, tags: false }, exclusions: [], neverSendTui: false } as never;
  const fake = createFakeProvider({ reply: { follow_up: { p: 0.9 }, follow_up_weight: { probabilities: [0.05, 0.15, 0.8] } } });
  let on = true;
  const now = Date.parse("2026-09-29T19:30:00.000Z");
  const f = new MergeFollowUps({ provider: () => fake, settings: () => (on ? settings : { ...(settings as object), features: { attention: false, tags: false } }) as never, now: () => now });
  const input = { sessionId: "01a0e82a", cardId: "card1", cwd: "/home/u/webapps/sova", terminal: false, card: { branch: "feat/spec-enforce", target: "master", commits: 60, added: 1, removed: 1 }, reply: { id: "ad987178", at: now - 60_000, text: E82A_REPLY }, routine: { restart_pending: true, push_pending: true, cleanup: 0 } };
  on = false;
  assert.equal(await f.check(input), false);
  assert.equal(fake.calls.length, 0, "attention off: nothing is sent");
  on = true;
  assert.equal(await f.check({ ...input, reply: { ...input.reply, at: now - 25 * 3600_000 } }), false, "an old merge is never checked");
  assert.equal(await f.check(input), true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.purpose, "merge-followup");
  assert.deepEqual(Object.keys(fake.calls[0]!.questions).sort(), ["follow_up", "follow_up_weight"]);
  const state = fake.calls[0]!.state as { reply: string; routine: object };
  assert.ok(state.reply.length <= 1500);
  assert.deepEqual(state.routine, { restart_pending: true, push_pending: true, cleanup: 0 });
  assert.equal(await f.check(input), false, "stored: never asked again");
  assert.equal(fake.calls.length, 1);
  const { followUpFor } = await import("./merge-followup");
  assert.equal(followUpFor("01a0e82a", "card1")?.weight, "significant");
  f.prune(new Set(["another"]));
  assert.equal(followUpFor("01a0e82a", "card1"), undefined, "a session no longer listed loses its answers");
});

test("a file that shrank since its size was read ends the search, never spins", async () => {
  const path = sessionFile(chain([user("hi", "2026-09-29T15:35:00.000Z")]));
  const size = (await import("node:fs")).statSync(path).size;
  // The listing saw a larger file; a rewrite shrank it before the read. Before the fix, a read
  // returning exactly the marker's overlap made no progress, forever.
  const out = await Promise.race([r.readReadinessScan(path, size + 5000, { size, found: false }), new Promise((done) => setTimeout(() => done("hung"), 2000))]);
  assert.notEqual(out, "hung");
});
