// Merge readiness against a real merge driver and real files; the readiness rules with git faked are merge-readiness.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// --- al_2's accuracy fixes, from the live cases (DECISIONS a5, a6) ---------------------------

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const readyStatus = () => ({ path: "/wt/agents-row-dropdown", source: "session" as const, exists: true, branch: "feat/agents-row-dropdown", base: "master", merged: "no" as const, ahead: 1, dirty: false, head: "own", headAt: 5 });

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
};

// Right after a removal, the first look used to answer from the reading cached before it.
// The spec manifest driver's shape: `node "<absolute path>" …`, a script that imports its core.
test("a node merge driver run from an absolute path: an edit to a file it imports alone changes an idle session's readiness at the next listing", async () => {
  const root = realpathSync(mkdtempSync(join(agentDir, "node-driver-")));
  const main = join(root, "repo");
  const core = join(root, "live", "core");
  mkdirSync(main);
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "driver.mjs"), 'import { code } from "./decide.mjs";\nprocess.exit(code);\n');
  writeFileSync(join(core, "decide.mjs"), "export const code = 1;\n");
  git(main, "init", "-q", "-b", "master");
  writeFileSync(join(main, ".gitattributes"), "a.txt merge=drv\n");
  git(main, "add", ".gitattributes");
  commit(main, "a.txt", "one");
  git(main, "config", "merge.drv.driver", `node "${join(core, "driver.mjs")}" --base %O --ours %A --theirs %B`);
  const base = git(main, "rev-parse", "HEAD");
  const wt = join(root, "wt");
  git(main, "worktree", "add", "-q", "-b", "feat/node-driver", wt);
  commit(wt, "a.txt", "feature");
  commit(main, "a.txt", "master");

  const sid = "01a103ed-a706-7126-a85b-000000000003";
  const path = join(root, `${sid}.jsonl`);
  const entries = [{ type: "session", version: 3, id: sid, timestamp: "2026-10-04T10:00:00.000Z", cwd: main }, { type: "custom", customType: "worktrees", id: "e1", parentId: null, timestamp: "2026-10-04T10:00:01.000Z", data: { version: 1, trees: [{ path: wt, branch: "feat/node-driver", base, baseBranch: "master", status: "active", session: sid, how: "created", at: 1 }] } }];
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const row = summary(path, { id: sid, cwd: main });

  const { WorktreeInsights, execGit } = await import("./worktrees");
  let now = 1_000_000;
  const calls: string[][] = [];
  const ins = new WorktreeInsights({ now: () => now, run: (args, opts) => { calls.push([...args]); return execGit(args, opts); } });
  r.resetReadiness();
  r.configureReadiness({ now: () => now, insights: ins, treeStamp: (d) => ins.quietStamp(d), asksUser: () => undefined });
  const state = () => r.readinessOverlay(row)?.trees[0];
  const tick = async (ms: number) => { now += ms; r.readinessOverlay(row); await r.readinessIdle(); };
  try {
    await tick(0);
    await tick(r.READINESS_TTL_MS);
    assert.equal(state()?.reason, "Conflicts with master · 1 file");
    calls.length = 0;
    await tick(r.READINESS_TTL_MS);
    assert.deepEqual(calls, [], "unchanged: no Git, so no driver run");
    writeFileSync(join(core, "decide.mjs"), "export const code = 0;\n");
    await tick(1);
    assert.equal(state()?.state, "merged", "the imported file's change alone: the trial merge now lands nothing new");
    assert.ok(calls.some((a) => a[0] === "merge-tree"));
  } finally {
    await r.readinessIdle();
    r.resetReadiness();
    rmSync(root, { recursive: true, force: true });
  }
});
