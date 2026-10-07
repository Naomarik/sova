// The one case that runs the real spec assessment tool: merge-readiness.integration.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-readiness-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

import type { ReadinessState, SessionSummary, WorktreeStatus } from "../shared/protocol";
import type { FileFacts } from "./merge-readiness";
import type { GitResult } from "./worktrees";
const r = await import("./merge-readiness");
const { DIRTY_TTL_MS } = await import("./worktrees");
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
  assert.deepEqual(t, { state: "waiting-approval", why: "checks passed", reason: "Waiting for your OK · checks passed · 1 commit ahead" });
  const s = r.sessionReadinessOf([{ path: "/wt/a", branch: "feat/agents-row-dropdown", ...t }], {}, 5);
  assert.equal(s?.badge, "waiting");
  assert.equal(s?.branch, "feat/agents-row-dropdown");
});

test("01a0ecd7: 2 ahead, clean, 1 of 3 open and a TEMP commit → blocked; answered, the TEMP commit still keeps it off ready", () => {
  const temp = r.tempCommitOf(["fix viewport on resume", "TEMP(viewport-test): floating Reload tab"]);
  assert.equal(temp, "TEMP(viewport-test): floating Reload tab");
  const facts = tree({ branch: "feat/viewport-height", ahead: 2, tempCommit: temp });
  assert.equal(r.treeReadiness(facts, { ...idle, openQuestions: 1, asks: r.asksToMerge(ECD7_REPLY) }).state, "blocked");
  assert.deepEqual(r.treeReadiness(facts, idle), { state: "in-progress", why: `temporary commit: ${temp}`, reason: `In progress · temporary commit: ${temp}` });
  assert.equal(r.asksToMerge(ECD7_REPLY), false, "asking about a test setup is not asking to merge");
  for (const s of ["WIP: half", "fixup! earlier", "squash! x", "amend! y", "temp: probe"]) assert.ok(r.tempCommitOf([s]), s);
  assert.equal(r.tempCommitOf(["Temperature units", "attempt 2"]), undefined);
});

test("01a0eef8: ahead 0 with 10 dirty files is never merged, running or not", () => {
  // treeFacts says merged only after a commit of the branch's own; here HEAD is still the base.
  const t = tree({ branch: "feat/align-chip-whole-branch", merged: false, ahead: 0, dirty: true });
  assert.equal(r.treeReadiness(t, { ...idle, running: true }).state, "in-progress");
  assert.deepEqual(r.treeReadiness(t, idle), { state: "in-progress", why: "uncommitted changes", reason: "In progress · uncommitted changes" });
  const named = r.treeReadiness({ ...t, dirtyCount: 10, dirtyFiles: ["src/lib/align.ts", "src/app.css", "x"] }, idle);
  assert.deepEqual(named, { state: "in-progress", why: "10 uncommitted files: align.ts and 9 more", reason: "In progress · 10 uncommitted files: align.ts and 9 more" });
  // And merged with uncommitted work left behind is stale, never merged.
  assert.deepEqual(r.treeReadiness(tree({ merged: true, dirty: true, tracked: "merged" }), idle), { state: "stale", why: "merged, with uncommitted changes", reason: "Stale · merged, with uncommitted changes" });
  assert.equal(r.treeReadiness(tree({ merged: true, dirty: true }), { ...idle, running: true }).state, "in-progress");
});

test("01a0ebbf: merged and clean, the server started before the merge → restart pending", () => {
  const t = r.treeReadiness(tree({ tracked: "merged", merged: true }), idle);
  assert.deepEqual(t, { state: "merged", reason: "Merged" });
  const s = r.sessionReadinessOf([{ path: "/wt/rm", branch: "feat/resource-monitor", ...t }], { lastMerge: { at: 50, branch: "feat/resource-monitor" }, restartPending: true, pushPending: true }, 60);
  assert.equal(s?.badge, "restart");
  assert.equal(s?.since, 50, "dated by the merge");
  assert.equal(s?.pushPending, true);
});

test("01a0eb99 (R2, R9): two merged, two still tracked active that git finds merged → merged; cleanup is title-only, the count is the follow-up check's", () => {
  const trees = [
    { path: "/wt/1", branch: "feat/vis-reliability", ...r.treeReadiness(tree({ merged: true }), idle) },
    { path: "/wt/2", branch: "feat/vis-wireframe", ...r.treeReadiness(tree({ merged: true }), idle) },
    { path: "/wt/3", branch: "feat/vis-wireframe-numbers", ...r.treeReadiness(tree({ tracked: "merged", merged: true }), idle) },
    { path: "/wt/4", branch: "feat/vis-round4", ...r.treeReadiness(tree({ tracked: "merged", merged: true }), idle) },
  ];
  assert.deepEqual(trees.map((t) => t.state), ["merged", "merged", "merged", "merged"]);
  const s = r.sessionReadinessOf(trees, { lastMerge: { at: 9, branch: "feat/vis-round4" }, followUp: { weight: "small", cue: "x" } }, 10);
  assert.equal(s?.badge, "merged");
  assert.equal(s?.cleanup, 2, "said in the title");
  assert.equal(s?.followUps, 1, "only the follow-up check's named work counts (a6)");
  assert.equal(r.sessionReadinessOf(trees, { lastMerge: { at: 9, branch: "feat/vis-round4" } }, 10)?.followUps, undefined, "cleanup alone: no count");
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

test("R4: ready, or asking 'Shall I merge it into master?' → a decide item (never Needs you), not while running or archived", () => {
  assert.equal(r.asksToMerge("1 ahead, tests pass.\n\nShall I merge it into master?"), true);
  for (const s of ["Want me to merge this now?", "It's ready to merge.", "Say merge and I'll land it.", "Should I go ahead and merge it?", "OK to merge?"]) assert.ok(r.asksToMerge(s), s);
  for (const s of ["Merged into master at abc1234.", "Want me to take it on?", "I merged the fix."]) assert.equal(r.asksToMerge(s), false, s);
  const readiness = r.sessionReadinessOf([{ path: "/wt/a", branch: "feat/a", state: "waiting-approval", why: "checks passed" }], {}, 42);
  const row = (over: Partial<SessionSummary>) => ({ id: "s", path: "/s/a.jsonl", busy: false, archived: false, readiness, ...over }) as unknown as SessionSummary;
  assert.deepEqual(r.readinessItems(row({})), [{ tier: "decide", kind: "ready-to-merge", since: 42, detail: "Waiting for your OK: feat/a" }]);
  const ready = r.sessionReadinessOf([{ path: "/wt/a", branch: "feat/a", state: "ready", why: "checks passed" }], {}, 43);
  assert.deepEqual(r.readinessItems({ ...row({}), readiness: ready } as SessionSummary), [{ tier: "decide", kind: "ready-to-merge", since: 43, detail: "Ready to merge: feat/a" }]);
  assert.deepEqual(r.readinessItems(row({ busy: true })), []);
  assert.deepEqual(r.readinessItems(row({ archived: true })), []);
});

test("a failed or missing check: failed keeps it off ready, none is still ready and says so", () => {
  assert.deepEqual(r.treeReadiness(tree(), { ...idle, lastCheck: { at: 1, ok: false } }), { state: "in-progress", why: "the last check failed", reason: "In progress · the last check failed" });
  assert.deepEqual(r.treeReadiness(tree(), idle), { state: "ready", why: "no check run seen", reason: "Ready to merge · no check run seen · 1 commit ahead" });
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
  assert.deepEqual(waiting?.trees, [{ path: "/wt/agents-row-dropdown", branch: "feat/agents-row-dropdown", state: "waiting-approval", why: "no check run seen", reason: "Waiting for your OK · no check run seen · 1 commit ahead" }]);
  // The attention signal's answer for this very reply wins over the fallback.
  r.configureReadiness({ asksUser: () => ({ turnId: (lines.at(-1) as { id: string }).id, asks: false }) });
  assert.equal((await r.computeReadiness(summary(path), facts!))?.badge, "ready");
  // R1: someone else merged it (ancestor), the row still says active: merged, with a cleanup follow-up.
  status = { ...status, merged: "ancestor", ahead: 0 };
  const merged = await r.computeReadiness(summary(path), facts!);
  assert.deepEqual([merged?.badge, merged?.cleanup, merged?.followUps], ["merged", 1, undefined]);
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

test("a merged tree with only untracked files: its state is in progress (running) or stale (idle), and it is still merged for the row's count", async () => {
  const lines = chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]);
  const path = sessionFile(lines);
  const fs = await import("node:fs");
  const { facts } = await r.readReadinessScan(path, fs.statSync(path).size, null);
  const status: WorktreeStatus & { head?: string } = { path: "/wt/agents-row-dropdown", source: "session", exists: true, branch: "feat/agents-row-dropdown", base: "master", merged: "ancestor", ahead: 0, behind: 0, dirty: true, dirtyCount: 1, dirtyFiles: ["NOTES.txt"], head: "h1" };
  r.configureReadiness({ insights: { treeStatus: async () => status }, git: fakeGit({}), asksUser: () => undefined, now: () => 0, processStart: 0 });
  const running = (await r.computeReadiness(summary(path, { busy: true }), facts!))?.trees[0];
  assert.deepEqual([running?.state, running?.merged], ["in-progress", true]);
  const idleTree = (await r.computeReadiness(summary(path), facts!))?.trees[0];
  assert.deepEqual([idleTree?.state, idleTree?.merged], ["stale", true]);
  // Not merged: no flag at all.
  status.merged = "no";
  status.ahead = 1;
  assert.equal((await r.computeReadiness(summary(path), facts!))?.trees[0]?.merged, undefined);
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

// --- al_2's accuracy fixes, from the live cases (DECISIONS a5, a6) ---------------------------

test("01a0e4d1 feat/site-marketing: 17 conflicts with master → not ready, 'Conflicts with master · 17 files'", async () => {
  const t = r.treeReadiness(tree({ branch: "feat/site-marketing", ahead: 12, base: "master", conflicts: 17 }), idle);
  assert.deepEqual(t, { state: "in-progress", why: "conflicts with master: 17 files", reason: "Conflicts with master · 17 files" });
  assert.equal(r.sessionReadinessOf([{ path: "/wt/sm", branch: "feat/site-marketing", ...t }], {}, 1)?.badge, undefined, "no ready chip");
  // merge-tree's exit-1 answer is kept: its conflicted-file lines, one file per distinct path.
  const { conflictedFiles } = await import("./worktrees");
  assert.equal(conflictedFiles("a79ab\n100644 7898 1\tsite/a.md\n100644 f2ad 2\tsite/a.md\n100644 6178 3\tsite/a.md\n100644 587b 2\tsite/b.md\n"), 2);
});

test("01a0def5 feat/cc-sandbox: only NAIVE-RUN.txt dirty → ready, the file named; 3 or more → in progress", () => {
  const facts = tree({ branch: "feat/cc-sandbox", ahead: 19, dirty: true, dirtyCount: 1, dirtyFiles: ["pi-config/extensions/sandbox/tests/NAIVE-RUN.txt"] });
  assert.deepEqual(r.treeReadiness(facts, { ...idle, lastCheck: { at: 1, ok: true } }), {
    state: "ready",
    why: "checks passed · 1 uncommitted file: NAIVE-RUN.txt",
    reason: "Ready to merge · checks passed · 19 commits ahead · 1 uncommitted file: NAIVE-RUN.txt",
  });
  assert.equal(r.treeReadiness({ ...facts, dirtyCount: 2, dirtyFiles: ["a/x.txt", "b.txt"] }, idle).why, "no check run seen · 2 uncommitted files: x.txt and 1 more");
  assert.deepEqual(r.treeReadiness({ ...facts, dirtyCount: 3, dirtyFiles: ["a/x.ts", "b.ts", "c.ts"] }, idle), { state: "in-progress", why: "3 uncommitted files: x.ts and 2 more", reason: "In progress · 3 uncommitted files: x.ts and 2 more" });
  assert.equal(r.treeReadiness({ ...facts, dirtyCount: 1, ahead: 0 }, idle).state, "in-progress", "a dirty file on no commits is still in progress");
});

test("git status names the files: first ones repo-relative, a rename's new name", async () => {
  const { porcelainFiles } = await import("./worktrees");
  assert.deepEqual(porcelainFiles(" M pi-config/extensions/sandbox/tests/NAIVE-RUN.txt\n"), { count: 1, first: ["pi-config/extensions/sandbox/tests/NAIVE-RUN.txt"] });
  assert.deepEqual(porcelainFiles("R  old.ts -> new.ts\n?? \"a b.txt\"\n M c\n M d\n"), { count: 4, first: ["new.ts", "a b.txt", "c"] });
});

test("01a0def5's 6572-char reply: the spec lines go BEFORE the 1500-char tail, so the body's ask is kept; a Deferred: line rides along for the follow-up check", async () => {
  const body = `${"The red-team runner rewrote NAIVE-RUN.txt again; only dates and timings changed. ".repeat(20)}\n\nAll checks pass. Shall I merge feat/cc-sandbox into master?`;
  const spec = `Deferred: §chat.sandbox/claude-workers — the TUI half lands separately\nAlso changes: ${"§chat.sandbox/x — a long description of what changed; ".repeat(80)}`;
  const text = `${body}\n\n${spec}`;
  assert.ok(text.length > 6000);
  const e = r.scanLine(JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "2026-09-30T09:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }), new Set());
  const kept = e!.reply!.text;
  assert.ok(kept.includes("Shall I merge feat/cc-sandbox into master?"), "the body's end is kept");
  assert.ok(!kept.includes("Also changes:"), "no spec line crowds it out");
  assert.ok(kept.endsWith("Deferred: §chat.sandbox/claude-workers — the TUI half lands separately"));
  assert.equal(r.asksToMerge(kept), true);
  const { followUpState } = await import("./merge-followup");
  const state = followUpState({ sessionId: "s", cardId: "c", cwd: "/", terminal: false, card: { branch: "feat/cc-sandbox", target: "master", commits: 19, added: 1, removed: 1 }, reply: { id: "a1", at: 1, text: kept }, routine: { restart_pending: false, push_pending: false, cleanup: 0 } });
  assert.ok(String(state.reply).endsWith("Shall I merge feat/cc-sandbox into master?"), "the follow-up check reads the body");
  assert.equal(state.deferred, "Deferred: §chat.sandbox/claude-workers — the TUI half lands separately");
});

test("01a0e63c: an empty leftover worktree (clean, no commits, idle) does not hide the merged badge of three merged trees", () => {
  const merged = (b: string) => ({ path: `/wt/${b}`, branch: b, ...r.treeReadiness(tree({ tracked: "merged", merged: true }), idle) });
  const empty = { path: "/wt/e", branch: "feat/bw-e2e-motorsaif", ...r.treeReadiness(tree({ ahead: 0 }), idle) };
  assert.equal(empty.why, "no commits yet");
  const s = r.sessionReadinessOf([merged("feat/a"), merged("feat/b"), merged("feat/c"), empty], { lastMerge: { at: 3, branch: "feat/c" } }, 4);
  assert.equal(s?.badge, "merged");
  assert.equal(s?.branch, "feat/c");
  // A dirty tree with no commits is work, not a leftover: it still hides the badge.
  const dirty = { ...empty, dirtyCount: 1 };
  assert.equal(r.sessionReadinessOf([merged("feat/a"), dirty], {}, 4)?.badge, undefined);
  // Only an empty tree: nothing merged, no badge.
  assert.equal(r.sessionReadinessOf([empty], {}, 4)?.badge, undefined);
});

test("routine readiness never invokes assessment status and retains ordinary checks and attention", async () => {
  let statusCalls = 0;
  // Deliberately supply the retired hook as an extra property: restoring its old call is a failure,
  // even if readiness catches the error and still returns the correct ordinary state.
  const retiredHook = { asksUser: () => undefined, specObservations: async () => {
    statusCalls++;
    throw new Error("routine readiness must not spawn assessment status");
  } };
  const cases: { label: string; expected: ReadinessState; status?: Partial<WorktreeStatus & { head?: string; headAt?: number }>; check?: { at: number; ok: boolean }; asks?: boolean; row?: Partial<SessionSummary>; restart?: boolean }[] = [
    { label: "checks passed", expected: "ready", check: { at: 3, ok: true } },
    { label: "no check seen", expected: "ready" },
    { label: "waiting for OK", expected: "waiting-approval", check: { at: 3, ok: true }, asks: true },
    { label: "last check failed", expected: "in-progress", check: { at: 3, ok: false } },
    { label: "three dirty files", expected: "in-progress", status: { dirty: true, dirtyCount: 3, dirtyFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] } },
    { label: "open alignment", expected: "blocked", row: { align: { openDocs: 1, openQuestions: 1, questionDocs: 1 } } },
    { label: "stale merged branch", expected: "stale", status: { merged: "ancestor", dirty: true } },
    { label: "merged branch", expected: "merged", status: { merged: "ancestor" } },
    { label: "working turn", expected: "in-progress", row: { busy: true } },
    { label: "server merge restart", expected: "merged", status: { merged: "ancestor" }, restart: true },
  ];
  try {
    for (const c of cases) {
      r.resetReadiness();
      const path = sessionFile([]), row = summary(path, c.row);
      const facts: FileFacts = {
        trees: [tracked() as FileFacts["trees"][number]],
        merges: c.restart ? [{ id: "merge-fixture", at: 2, path: "/wt/agents-row-dropdown", branch: "feat/agents-row-dropdown", target: "master", sha: "fixture-merge", commits: 1, added: 1, removed: 0, fastForward: false }] : [],
        ...(c.check ? { lastCheck: c.check } : {}),
        ...(c.asks ? { lastReply: { id: "reply-fixture", at: 4, text: "Shall I merge it into master?" } } : {}),
      };
      const inputs = structuredClone({ row, facts });
      const status = { path: "/wt/agents-row-dropdown", source: "session" as const, exists: true, branch: "feat/agents-row-dropdown", base: "master", merged: "no" as const, ahead: 1, behind: 0, dirty: false, head: "fixture-head", headAt: 5, ...c.status };
      r.configureReadiness({ insights: { treeStatus: async () => status }, git: fakeGit({
        "rev-parse --show-toplevel": { stdout: "/fixture/server\n" }, "symbolic-ref": { stdout: "master\n" },
        "merge-base --is-ancestor": { code: 0 }, "diff --name-only": { stdout: "server/index.ts\n" },
      }), ...retiredHook, now: () => 0, processStart: 0 });
      const old = await r.computeReadiness(row, facts);
      assert.ok(old, c.label); assert.equal(old.trees[0]?.state, c.expected, c.label);
      const checks = structuredClone(r.readinessChecksOf(path));
      assert.deepEqual(checks, { ...(c.check ? { lastCheck: c.check } : {}), heads: { "/wt/agents-row-dropdown": 5 } });
      const oldRow = { ...row, readiness: old }, attention = r.readinessItems(oldRow), restarts = r.restartItems([oldRow]);
      if (c.expected === "ready" || c.expected === "waiting-approval") assert.equal(attention.length, 1, "the attention comparison has a positive baseline");
      if (c.restart) assert.equal(restarts.length, 1, "the restart comparison has a positive baseline");
      for (let refresh = 0; refresh < 3; refresh++) {
        const refreshed = await r.computeReadiness(row, facts);
        assert.deepEqual(refreshed, old, `${c.label}: ordinary readiness survives repeated refreshes`);
        assert.equal(statusCalls, 0, `${c.label}: no assessment status invocation`);
        assert.ok(!Object.hasOwn(refreshed!, "specObservations"));
        assert.deepEqual(r.readinessChecksOf(path), checks);
        const refreshedRow = { ...row, readiness: refreshed };
        assert.deepEqual(r.readinessItems(refreshedRow), attention);
        assert.deepEqual(r.restartItems([refreshedRow]), restarts);
        assert.deepEqual({ row, facts }, inputs);
      }
    }
  } finally { r.resetReadiness(); }
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const readyStatus = () => ({ path: "/wt/agents-row-dropdown", source: "session" as const, exists: true, branch: "feat/agents-row-dropdown", base: "master", merged: "no" as const, ahead: 1, dirty: false, head: "own", headAt: 5 });

test("unchanged overlays join an active refresh even across TTL, newer row states coalesce once", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const row = summary(path), entered = barrier(), blocked = barrier();
  let now = 0, reads = 0;
  r.configureReadiness({ now: () => now, insights: { treeStatus: async () => {
    reads++;
    if (reads === 1) { entered.release(); await blocked.promise; }
    return readyStatus();
  } }, asksUser: () => undefined });
  try {
    assert.equal(r.readinessOverlay(row), undefined, "listing does not await Git");
    await entered.promise;
    now = 100_000;
    for (let i = 0; i < 20; i++) r.readinessOverlay({ ...row });
    blocked.release(); await r.readinessIdle();
    assert.equal(reads, 1, "unchanged active input must never requeue");
    assert.equal(r.readinessOverlay(row)?.trees[0]?.state, "ready");
    now += r.READINESS_TTL_MS;
    const enteredAgain = barrier(), blockedAgain = barrier();
    r.configureReadiness({ insights: { treeStatus: async () => {
      reads++;
      if (reads === 2) { enteredAgain.release(); await blockedAgain.promise; }
      return readyStatus();
    } } });
    r.readinessOverlay(row); await enteredAgain.promise;
    r.readinessOverlay({ ...row, busy: true });
    const latest = { ...row, align: { openDocs: 1, openQuestions: 2, questionDocs: 1 } };
    for (let i = 0; i < 20; i++) r.readinessOverlay(latest);
    blockedAgain.release(); await r.readinessIdle();
    assert.equal(reads, 3, "one trailing refresh uses the newest row");
    assert.equal(r.readinessOverlay(latest)?.trees[0]?.state, "blocked");
    assert.match(r.readinessOverlay(latest)!.trees[0]!.reason!, /2 open questions/);
  } finally { blocked.release(); await r.readinessIdle(); r.resetReadiness(); }
});

test("a session-file rewrite during Git cannot publish stale readiness or checks", async () => {
  r.resetReadiness();
  const entries = chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]);
  const path = sessionFile(entries), row = summary(path), entered = barrier(), blocked = barrier();
  let reads = 0;
  r.configureReadiness({ insights: { treeStatus: async () => {
    reads++; entered.release(); await blocked.promise; return readyStatus();
  } }, asksUser: () => undefined });
  try {
    r.readinessOverlay(row); await entered.promise;
    // Same-sized replacement: row.lastActiveAt and file size need not change.
    const fs = await import("node:fs");
    const old = fs.readFileSync(path, "utf8");
    writeFileSync(path, old.replace(`"session":"${SID}"`, `"session":"${"x".repeat(SID.length)}"`));
    assert.equal(fs.statSync(path).size, Buffer.byteLength(old));
    blocked.release(); await r.readinessIdle();
    assert.equal(reads, 1, "rewritten inherited ownership needs no Git");
    assert.equal(r.readinessOverlay(row), undefined, "old-generation ready must not survive replacement");
    assert.equal(r.readinessChecksOf(path), undefined, "old-generation commit times must not publish");
  } finally { blocked.release(); await r.readinessIdle(); r.resetReadiness(); }
});

test("changed files without a row change rescan, and untracked files never run Git", async () => {
  r.resetReadiness();
  const path = sessionFile([]), row = summary(path);
  let reads = 0;
  r.configureReadiness({ insights: { treeStatus: async () => { reads++; return readyStatus(); } }, asksUser: () => undefined });
  try {
    r.readinessOverlay(row); await r.readinessIdle();
    assert.equal(reads, 0);
    writeFileSync(path, `${JSON.stringify(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")])[0])}\n`, { flag: "a" });
    r.readinessOverlay(row); await r.readinessIdle();
    assert.equal(reads, 1);
    assert.equal(r.readinessOverlay(row)?.trees[0]?.state, "ready");
  } finally { await r.readinessIdle(); r.resetReadiness(); }
});

test("pruning an active session prevents late publication and releases the flight", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const row = summary(path), entered = barrier(), blocked = barrier();
  let reads = 0;
  r.configureReadiness({ insights: { treeStatus: async () => {
    reads++; if (reads === 1) { entered.release(); await blocked.promise; } return readyStatus();
  } }, asksUser: () => undefined });
  try {
    r.readinessOverlay(row); await entered.promise;
    r.pruneReadiness([]); blocked.release(); await r.readinessIdle();
    assert.equal(r.treeReadinessOf(path, tracked().path), undefined);
    assert.equal(r.readinessChecksOf(path), undefined);
    r.readinessOverlay(row); await r.readinessIdle();
    assert.equal(reads, 2, "a later listing can read again");
  } finally { blocked.release(); await r.readinessIdle(); r.resetReadiness(); }
});

test("merge push observations use the shared cache API, preserving unknown and moved refs", async () => {
  r.resetReadiness();
  const path = sessionFile([]), row = summary(path);
  const facts: FileFacts = { trees: [tracked() as FileFacts["trees"][number]], merges: [{ id: "card", at: 1, path: tracked().path, branch: "feat/x", target: "master", sha: "merge", commits: 1, added: 1, removed: 0, fastForward: true }] };
  let pushed: boolean | undefined = false;
  const calls: unknown[][] = [];
  r.configureReadiness({ processStart: 2, insights: { treeStatus: async () => readyStatus(), pushed: async (...args) => { calls.push(args); return pushed; } }, git: async () => { throw new Error("push observation bypassed shared runner"); } });
  try {
    assert.equal((await r.computeReadiness(row, facts))?.pushPending, true);
    pushed = true;
    assert.equal((await r.computeReadiness(row, facts))?.pushPending, undefined);
    pushed = undefined;
    assert.equal((await r.computeReadiness(row, facts))?.pushPending, undefined, "missing origin is unknown, not unpushed");
    assert.deepEqual(calls, Array.from({ length: 3 }, () => [tracked().path, "master", "merge"]));
  } finally { r.resetReadiness(); }
});

test("an archived idle session keeps its answer past the TTL; file and row changes still re-read", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const archived = summary(path, { archived: true });
  let now = 0, reads = 0;
  r.configureReadiness({ now: () => now, insights: { treeStatus: async () => { reads++; return readyStatus(); } }, asksUser: () => undefined });
  try {
    r.readinessOverlay(archived); await r.readinessIdle();
    assert.equal(reads, 1, "first sight reads");
    assert.equal(r.readinessOverlay(archived)?.trees[0]?.state, "ready");
    for (let i = 0; i < 5; i++) { now += r.READINESS_TTL_MS + 1; r.readinessOverlay({ ...archived }); await r.readinessIdle(); }
    assert.equal(reads, 1, "no TTL refresh while archived, idle and not live");
    assert.equal(r.readinessOverlay(archived)?.trees[0]?.state, "ready", "the last answer stands");
    writeFileSync(path, `${JSON.stringify({ type: "custom", customType: "note", data: {}, timestamp: "2026-09-29T15:37:00.000Z" })}\n`, { flag: "a" });
    r.readinessOverlay(archived); await r.readinessIdle();
    assert.equal(reads, 2, "a file change re-reads");
    r.readinessOverlay({ ...archived, archived: false }); await r.readinessIdle();
    assert.equal(reads, 3, "unarchiving re-reads at once");
    now += r.READINESS_TTL_MS;
    r.readinessOverlay({ ...archived, archived: false }); await r.readinessIdle();
    assert.equal(reads, 4, "unarchived, the ordinary cadence is back");
    r.readinessOverlay(archived); await r.readinessIdle();
    assert.equal(reads, 5, "archiving re-reads once");
    now += r.READINESS_TTL_MS;
    r.readinessOverlay(archived); await r.readinessIdle();
    assert.equal(reads, 5);
  } finally { await r.readinessIdle(); r.resetReadiness(); }
});

test("an archived session that is live or running keeps the ordinary cadence", async () => {
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const rows: [string, SessionSummary][] = [
    ["live", summary(path, { archived: true, live: { pid: 1 } as unknown as SessionSummary["live"] })],
    ["busy", summary(path, { archived: true, busy: true })],
    ["working", summary(path, { archived: true, activity: { state: "working" } as SessionSummary["activity"] })],
    ["workers", summary(path, { archived: true, workers: { working: 1 } as SessionSummary["workers"] })],
  ];
  for (const [why, row] of rows) {
    r.resetReadiness();
    let now = 0, reads = 0;
    r.configureReadiness({ now: () => now, insights: { treeStatus: async () => { reads++; return readyStatus(); } }, asksUser: () => undefined });
    try {
      r.readinessOverlay(row); await r.readinessIdle();
      now += r.READINESS_TTL_MS;
      r.readinessOverlay(row); await r.readinessIdle();
      assert.equal(reads, 2, `${why}: archived alone never suppresses the TTL read`);
    } finally { await r.readinessIdle(); r.resetReadiness(); }
  }
});

test("inspecting a parked session returns the cached answer first and queues one coalesced read once aged", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const archived = summary(path, { archived: true });
  let now = 0, reads = 0, dirty = false;
  const entered = barrier(), blocked = barrier();
  r.configureReadiness({ now: () => now, insights: { treeStatus: async () => {
    reads++;
    if (reads === 2) { entered.release(); await blocked.promise; }
    return { ...readyStatus(), ...(dirty ? { dirty: true, dirtyFiles: ["a.ts", "b.ts", "c.ts"], dirtyCount: 3 } : {}) };
  } }, asksUser: () => undefined });
  try {
    r.readinessOverlay(archived); await r.readinessIdle();
    assert.equal(reads, 1);
    assert.equal(r.treeReadinessOf(path, tracked().path)?.state, "ready");
    assert.ok(r.readinessChecksOf(path));
    await r.readinessIdle();
    assert.equal(reads, 1, "an inspection of a fresh answer reads nothing");
    now += r.READINESS_TTL_MS;
    dirty = true;
    assert.equal(r.treeReadinessOf(path, tracked().path)?.state, "ready", "cached first: the older answer for this call");
    await Promise.race([entered.promise, new Promise((_, no) => setTimeout(() => no(new Error("the inspection queued no read")), 2_000))]);
    for (let i = 0; i < 10; i++) { r.readinessOverlay(archived); r.treeReadinessOf(path, tracked().path); r.readinessChecksOf(path); }
    blocked.release(); await r.readinessIdle();
    assert.equal(reads, 2, "repeated inspections and listings join the one read");
    assert.equal(r.treeReadinessOf(path, tracked().path)?.state, "in-progress", "a later inspection shows the completed refresh");
    await r.readinessIdle();
    assert.equal(reads, 2);
    now += r.READINESS_TTL_MS;
    r.readinessChecksOf(path); await r.readinessIdle();
    assert.equal(reads, 3, "sova_session's checks read is an inspection too");
    r.pruneReadiness([]);
    now += r.READINESS_TTL_MS;
    assert.equal(r.treeReadinessOf(path, tracked().path), undefined);
    await r.readinessIdle();
    assert.equal(reads, 3, "a pruned session is never inspected back");
  } finally { blocked.release(); await r.readinessIdle(); r.resetReadiness(); }
});

test("an unarchived session's inspection never queues reads of its own", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  let now = 0, reads = 0;
  r.configureReadiness({ now: () => now, insights: { treeStatus: async () => { reads++; return readyStatus(); } }, asksUser: () => undefined });
  try {
    r.readinessOverlay(summary(path)); await r.readinessIdle();
    now += r.READINESS_TTL_MS;
    r.treeReadinessOf(path, tracked().path); r.readinessChecksOf(path); await r.readinessIdle();
    assert.equal(reads, 1, "the listing's cadence covers it, as before");
  } finally { await r.readinessIdle(); r.resetReadiness(); }
});

test("a gone folder says what its work came to: merged and cleaned up, or removed and why; never in progress", async () => {
  r.resetReadiness();
  const gonePath = "/wt/gone-merged-branch-does-not-exist";
  assert.equal(existsSync(gonePath), false);
  const facts = (status: "active" | "merged"): FileFacts => ({ trees: [tracked({ path: gonePath, branch: "feat/gone", status })], merges: [] }) as unknown as FileFacts;
  const asked: { dirs: readonly string[] }[] = [];
  let answer: "merged" | "empty" | "unmerged" | null = "merged";
  r.configureReadiness({ insights: { treeStatus: async () => null }, git: fakeGit({}), asksUser: () => undefined, now: () => 0, processStart: 0, gone: async (_t, dirs) => (asked.push({ dirs }), answer) });
  try {
    const s = summary("/sessions/x.jsonl", { cwd: "/home/u/webapps/sova" });
    const reason = async (status: "active" | "merged" = "active") => (await r.computeReadiness(s, facts(status)))?.trees[0];
    const merged = await r.computeReadiness(s, facts("active"));
    assert.deepEqual(merged?.trees, [{ path: gonePath, branch: "feat/gone", state: "merged", merged: true, why: "cleaned up", reason: "Merged · cleaned up" }]);
    assert.equal(merged?.badge, "merged");
    assert.equal(merged?.cleanup, undefined, "a removed tree is no leftover to clean up");
    assert.deepEqual(asked[0]?.dirs, ["/home/u/webapps/sova"], "git is read from the session's folder");
    answer = "unmerged";
    const unmerged = await r.computeReadiness(s, facts("active"));
    assert.deepEqual([unmerged?.trees[0]?.state, unmerged?.trees[0]?.reason, unmerged?.trees[0]?.merged], ["removed", "Removed · not merged", undefined]);
    assert.equal(unmerged?.badge, undefined, "unmerged work removed is never a merged badge");
    assert.equal((await reason("merged"))?.reason, "Removed · not merged", "a branch git finds decides over the record");
    answer = null;
    assert.equal((await reason())?.reason, "Removed · no record of a merge");
    assert.equal((await reason("merged"))?.reason, "Merged · cleaned up", "recorded merged, nothing else known: merged");
    answer = "empty";
    const empty = await r.computeReadiness(s, facts("active"));
    assert.equal(empty?.trees[0]?.reason, "Removed · no commits");
    // Every gone answer is one of these: none reads in progress.
    for (const a of ["merged", "unmerged", "empty", null] as const) {
      answer = a;
      assert.notEqual((await reason())?.state, "in-progress");
    }
    // A folder that is there but unreadable is not "removed": the record still decides, as before.
    r.configureReadiness({ insights: { treeStatus: async () => ({ path: gonePath, source: "session", exists: true, error: "git status: boom" }) } });
    answer = "merged";
    assert.equal((await reason())?.reason, "In progress · worktree folder gone");
  } finally {
    r.resetReadiness();
  }
});

test("a gone folder whose branch the Merge Captain deleted reads merged from the captain's own record of its merge", async () => {
  r.resetReadiness();
  const gonePath = "/wt/captain-landed-does-not-exist";
  const captain = sessionFile(chain([worktrees([tracked({ path: gonePath, branch: "feat/landed", session: "captain", how: "attached", status: "merged", merge: { target: "master", sha: "m1", at: 2, how: "tool" } })], "2026-09-29T15:36:00.000Z")]));
  r.configureReadiness({ insights: { treeStatus: async () => null }, git: fakeGit({}), asksUser: () => undefined, now: () => 0, processStart: 0, gone: async () => null });
  try {
    const owner = { trees: [tracked({ path: gonePath, branch: "feat/landed" })], merges: [] } as unknown as FileFacts;
    const s = summary("/sessions/owner.jsonl");
    assert.equal((await r.computeReadiness(s, owner))?.trees[0]?.reason, "Removed · no record of a merge", "nothing has read the captain yet");
    r.readinessOverlay(summary(captain, { id: "captain" }));
    await r.readinessIdle();
    const after = await r.computeReadiness(s, owner);
    assert.deepEqual([after?.trees[0]?.state, after?.trees[0]?.merged, after?.trees[0]?.reason], ["merged", true, "Merged · cleaned up"]);
    const other = { trees: [tracked({ path: gonePath, branch: "feat/other-branch" })], merges: [] } as unknown as FileFacts;
    assert.equal((await r.computeReadiness(s, other))?.trees[0]?.reason, "Removed · no record of a merge", "only the same path and branch count");
  } finally {
    r.resetReadiness();
  }
});

test("dirty lifetimes (§chat.worktrees/dirty-freshness): an idle session's merged, clean tree holds 5 minutes; running, unmerged, moved and inspected read sooner", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const row = summary(path);
  let now = 0, merged = true;
  const asked: number[] = [];
  const last = () => asked.at(-1);
  // Unreadable stamps keep the 20 s cadence (settled sessions have their own test below).
  r.configureReadiness({ now: () => now, asksUser: () => undefined, treeStamp: () => null, insights: {
    treeStatus: async () => ({ ...readyStatus(), ...(merged ? { merged: "ancestor" as const, ahead: 0 } : {}) }),
    dirtyLifetime: (dir, ms) => { assert.equal(dir, tracked().path); asked.push(ms); },
  } });
  try {
    r.readinessOverlay(row); await r.readinessIdle();
    assert.equal(r.readinessOverlay(row)?.trees[0]?.state, "merged");
    assert.equal(last(), 0, "first sight reads now");
    now += r.READINESS_TTL_MS;
    r.readinessOverlay(row); await r.readinessIdle();
    assert.equal(last(), r.IDLE_DIRTY_TTL_MS, "idle, merged and clean: the long lifetime");
    assert.equal(r.treeReadinessOf(path, tracked().path)?.state, "merged", "an inspection answers from cache at once");
    await r.readinessIdle();
    assert.equal(last(), 0, "and re-reads the dirty state now");
    r.treeReadinessOf(path, tracked().path); await r.readinessIdle();
    assert.equal(asked.length, 3, "a second look right after reads nothing more");
    now += r.READINESS_TTL_MS;
    r.readinessOverlay({ ...row, busy: true }); await r.readinessIdle();
    assert.equal(last(), 0, "a row change reads now");
    now += r.READINESS_TTL_MS;
    r.readinessOverlay({ ...row, busy: true }); await r.readinessIdle();
    assert.equal(last(), DIRTY_TTL_MS, "running: 10 seconds");
    now += r.READINESS_TTL_MS;
    writeFileSync(path, `${JSON.stringify({ type: "custom", customType: "note", data: {}, timestamp: "2026-09-29T15:37:00.000Z" })}\n`, { flag: "a" });
    r.readinessOverlay({ ...row, busy: true }); await r.readinessIdle();
    assert.equal(last(), 0, "a file change reads now");
    merged = false;
    now += r.READINESS_TTL_MS;
    r.readinessOverlay(row); await r.readinessIdle();
    now += r.READINESS_TTL_MS;
    r.readinessOverlay(row); await r.readinessIdle();
    assert.equal(r.readinessOverlay(row)?.trees[0]?.state, "ready");
    assert.equal(last(), DIRTY_TTL_MS, "an unmerged tree keeps 10 seconds while idle");
    const before = asked.length;
    r.treeReadinessOf(path, tracked().path); await r.readinessIdle();
    assert.equal(asked.length, before, "no long reading, so an inspection queues nothing");
  } finally { await r.readinessIdle(); r.resetReadiness(); }
});

test("settled sessions (§app/idle-git-cache): idle with every tree merged and clean, re-read every 5 minutes; a moved tree, a turn or a look re-read at once", async () => {
  r.resetReadiness();
  const path = sessionFile(chain([worktrees([tracked()], "2026-09-29T15:36:00.000Z")]));
  const row = summary(path);
  let now = 0, reads = 0, stamp = "s1", merged = true;
  const asked: number[] = [];
  r.configureReadiness({ now: () => now, asksUser: () => undefined, treeStamp: () => stamp, insights: {
    treeStatus: async () => { reads++; return { ...readyStatus(), ...(merged ? { merged: "ancestor" as const, ahead: 0 } : {}) }; },
    dirtyLifetime: (_dir, ms) => { asked.push(ms); },
  } });
  const tick = async (ms: number, over: Partial<SessionSummary> = {}) => { now += ms; r.readinessOverlay({ ...row, ...over }); await r.readinessIdle(); };
  try {
    await tick(0);
    assert.equal(r.readinessOverlay(row)?.trees[0]?.state, "merged");
    assert.equal(reads, 1);
    for (let i = 0; i < 10; i++) await tick(r.READINESS_TTL_MS);
    assert.equal(reads, 1, "settled: no 20 s re-reads");
    await tick(r.SETTLED_TTL_MS - 10 * r.READINESS_TTL_MS);
    assert.equal(reads, 2, "re-read once 5 minutes passed");
    stamp = "s2"; // a commit, checkout or branch switch in the tree
    await tick(1);
    assert.equal(reads, 3, "a moved tree re-reads at once");
    assert.equal(asked.at(-1), 0, "dirty state included");
    await tick(r.READINESS_TTL_MS);
    assert.equal(reads, 3);
    now += DIRTY_TTL_MS;
    assert.equal(r.treeReadinessOf(path, tracked().path)?.state, "merged", "opening it answers from cache at once");
    await r.readinessIdle();
    assert.equal(reads, 4, "and re-reads it");
    r.treeReadinessOf(path, tracked().path); await r.readinessIdle();
    assert.equal(reads, 4, "a second look within 10 s reads nothing more");
    await tick(1, { busy: true });
    assert.equal(reads, 5, "a turn starting re-reads at once");
    await tick(r.READINESS_TTL_MS, { busy: true });
    assert.equal(reads, 6, "running: the 20 s cadence");
    merged = false;
    await tick(1);
    assert.equal(r.readinessOverlay(row)?.trees[0]?.state, "ready");
    const before = reads;
    await tick(r.READINESS_TTL_MS);
    assert.equal(reads, before + 1, "not merged: the 20 s cadence");
  } finally { await r.readinessIdle(); r.resetReadiness(); }
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
};

// Right after a removal, the first look used to answer from the reading cached before it.
test("a tree the cleanup service removes (§chat.worktrees/cleanup) reads 'Merged · cleaned up' on the first look after the removal", async () => {
  const root = realpathSync(mkdtempSync(join(agentDir, "cleanup-")));
  const main = join(root, "repo");
  mkdirSync(main);
  mkdirSync(join(root, "sessions"));
  git(main, "init", "-q", "-b", "master");
  commit(main, "init.txt", "init");
  const base = git(main, "rev-parse", "HEAD");
  const a = join(root, "wt-a");
  const b = join(root, "wt-b");
  git(main, "worktree", "add", "-q", "-b", "feat/a", a);
  commit(a, "a.txt", "a: 1");
  git(main, "merge", "-q", "--ff-only", "feat/a");
  git(main, "worktree", "add", "-q", "-b", "feat/b", b, base);
  commit(b, "b.txt", "b: 1");

  // The session tracks both active: a merged (a cleanup leftover), b ready. Not settled, so no
  // stamp check re-reads it on its own.
  const SID = "01a103ed-a706-7126-a85b-000000000001";
  const path = join(root, "sessions", `${SID}.jsonl`);
  const tree = (p: string, branch: string) => ({ path: p, branch, base, baseBranch: "master", status: "active", session: SID, how: "created", at: 1 });
  const entries = [{ type: "session", version: 3, id: SID, timestamp: "2026-10-04T10:00:00.000Z", cwd: main }, { type: "custom", customType: "worktrees", id: "e1", parentId: null, timestamp: "2026-10-04T10:00:01.000Z", data: { version: 1, trees: [tree(a, "feat/a"), tree(b, "feat/b")] } }];
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const row: SessionSummary = { id: SID, path, cwd: main, title: "t", createdAt: "", lastActiveAt: "2026-10-04T10:00:01.000Z", model: null, live: null, busy: false, origin: "web", archived: false };

  const c = await import("./worktree-cleanup");
  r.resetReadiness();
  c.resetCleanup();
  r.configureReadiness({ asksUser: () => undefined });
  c.configureCleanup({ summary: async () => row, sessionFiles: async () => [path], readBranch: async () => entries.slice(1), processes: async () => [] });
  try {
    r.readinessOverlay(row);
    await r.readinessIdle();
    assert.equal(r.treeReadinessOf(path, a)?.reason, "Merged · still tracked active", "cached before the removal");
    assert.equal(r.treeReadinessOf(path, b)?.state, "ready");

    const res = await c.cleanupRemove(path, [a]);
    assert.ok(res && res !== "busy");
    assert.deepEqual(res.removed.map((x) => x.path), [a]);

    assert.equal(r.treeReadinessOf(path, a)?.reason, "Merged · cleaned up", "the very first look");
    assert.equal(r.readinessOverlay(row)?.trees.find((t) => t.path === a)?.reason, "Merged · cleaned up", "the session list too");
    assert.equal(r.treeReadinessOf(path, b)?.state, "ready", "the other tree is untouched");
  } finally {
    await r.readinessIdle();
    r.resetReadiness();
    c.resetCleanup();
  }
});
