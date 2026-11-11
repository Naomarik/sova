import assert from "node:assert/strict";
import { test } from "node:test";
import { narrowScope, writeOnlyScope } from "../pi-config/extensions/sandbox/policy.ts";
import { historyOf } from "./harness/pi/reader";
import { lastNoteDigest, noteDigest, sandboxedOf } from "./project-services/note";
import { stateView } from "./harness/state-view";
import { currentSandboxNote, registerSandboxNote, SANDBOX_NOTE_MESSAGE, sandboxNote } from "./sandbox-note";

/**
 * The sandbox note: only an agent whose tools are confined gets it (a write-only worktree worker, or a
 * chat or worker with the sandbox On), hidden at a turn's start, again only when its text changes or
 * after a compaction. Also the instance note's ports line, which a write-only worker must not get.
 */

const SHARED = "/home/u/.local/state/sova/shared/s1";
const TREE = "/home/u/webapps/.worktrees/sova-x";
const sandboxEntry = (on: boolean, level = "workspace-write") => ({ type: "custom", customType: "sandbox", data: { version: 1, on, level, backend: on ? "linux-bwrap" : "none", enforcement: on ? "full" : "none" } });
const worktreesEntry = (paths: string[], status = "active") => ({
  type: "custom",
  customType: "worktrees",
  data: { version: 1, trees: paths.map((path) => ({ path, branch: "feat/x", base: "abc", status, session: "s1", how: "created", at: 1_762_819_200_000 })) },
});
const ctxOf = (branch: unknown[], cwd = "/home/u/proj") => ({
  cwd,
  sessionManager: { getBranch: () => branch, getSessionId: () => "s1", getLeafId: () => null, getSessionFile: () => undefined, getSessionName: () => undefined },
});
const hookCtx = (branch: unknown[], cwd?: string) => ({ sessionId: "s1", cwd: cwd ?? "/home/u/proj", leafId: () => null, branch: () => historyOf(branch), state: () => stateView(historyOf(branch)), key: null, title: () => undefined, native: {} }) as never;
// A scope that also lists the shared folder and a member's note folder as roots: the note names them once, as the shared folder.
const writeOnlyFlags = (shared?: string) =>
  ({ sandbox: "on" as const, "sandbox-parent": JSON.stringify({ ...writeOnlyScope(TREE, shared ? { shared } : {}), ...(shared ? { writable: [TREE, shared, `${shared}/teams/s1/team_01/note`] } : {}) }) });
const onWorkerFlags = (level: "workspace-write" | "read-only" = "workspace-write") =>
  ({ sandbox: "on" as const, "sandbox-parent": JSON.stringify(narrowScope({ version: 1, level, workspaceRoot: "/home/u/proj", writable: ["/home/u/proj"] }, TREE)) });
const deps = (verbs = true) => ({ verbsOffered: async () => verbs, shared: () => SHARED, platform: "linux" });

test("the note's template stays within its size, and its parts follow the platform, project_verbs and the shared folder", () => {
  const template = sandboxNote({ folders: ["{folders}"], shared: "{shared}", verbs: true, platform: "linux" });
  assert.equal(template, "Sandbox: you can write only in {folders} and $TMPDIR. /tmp and ~/.cache are private to you: leave files for other chats in {shared}. Set up, serve and test through project_verbs.");
  assert.ok(template.length <= 180, `${template.length} characters`);
  assert.doesNotMatch(sandboxNote({ folders: [TREE], shared: SHARED, verbs: false, platform: "linux" }), /project_verbs/);
  assert.match(sandboxNote({ folders: [TREE], shared: SHARED, verbs: true, platform: "darwin" }), / \/tmp is read-only and ~\/\.cache is private to you: leave files/);
  assert.match(sandboxNote({ folders: [], shared: SHARED, verbs: false, platform: "linux" }), /^Sandbox: you can write only in \$TMPDIR\. /);
  assert.match(sandboxNote({ folders: [TREE], shared: null, verbs: false, platform: "linux" }), /private to you\.$/);
});

test("who gets it: none, Subagents only and Off get nothing; a write-only worker, an On worker and an On chat get their own roots", async () => {
  // A chat with no sandbox entry (Subagents only), one turned to Subagents only or Off: nothing.
  assert.equal(await currentSandboxNote({}, hookCtx([]), deps()), null);
  assert.equal(await currentSandboxNote({}, hookCtx([sandboxEntry(false)]), deps()), null);
  assert.equal(await currentSandboxNote({ workerFlags: {} }, hookCtx([]), deps()), null, "a worker its parent didn't confine");
  // A write-only worktree worker: its worktree, never the shared folder twice (its scope lists it as a root).
  const wo = await currentSandboxNote({ workerFlags: writeOnlyFlags(SHARED) }, hookCtx([sandboxEntry(true)], TREE), deps());
  assert.equal(wo, `Sandbox: you can write only in ${TREE} and $TMPDIR. /tmp and ~/.cache are private to you: leave files for other chats in ${SHARED}. Set up, serve and test through project_verbs.`);
  // An On worker: its parent scope's roots; at the read-only level, none.
  assert.match((await currentSandboxNote({ workerFlags: onWorkerFlags() }, hookCtx([], TREE), deps(false)))!, new RegExp(`^Sandbox: you can write only in ${TREE} and \\$TMPDIR\\. `));
  assert.match((await currentSandboxNote({ workerFlags: onWorkerFlags("read-only") }, hookCtx([], TREE), deps(false)))!, /^Sandbox: you can write only in \$TMPDIR\. /);
  // An On chat: its folder and its active tracked worktrees; at the read-only level, none.
  const on = await currentSandboxNote({}, hookCtx([sandboxEntry(true), worktreesEntry([TREE])]), deps());
  assert.match(on!, new RegExp(`^Sandbox: you can write only in /home/u/proj, ${TREE} and \\$TMPDIR\\. `));
  const dropped = await currentSandboxNote({}, hookCtx([sandboxEntry(true), worktreesEntry([TREE], "dropped")]), deps());
  assert.match(dropped!, /^Sandbox: you can write only in \/home\/u\/proj and \$TMPDIR\. /, "a dropped worktree isn't a root");
  assert.match((await currentSandboxNote({}, hookCtx([sandboxEntry(true, "read-only")]), deps()))!, /^Sandbox: you can write only in \$TMPDIR\. /);
  // A malformed parent scope fails closed: confined, with no roots named.
  assert.match((await currentSandboxNote({ workerFlags: { sandbox: "on", "sandbox-parent": "{nope" } }, hookCtx([]), deps()))!, /^Sandbox: you can write only in \$TMPDIR\. /);
});

test("delivered hidden at a turn's start, re-sent only when its text changes and after a compaction", async () => {
  const handlers: Record<string, (e: unknown, ctx: unknown) => Promise<unknown>> = {};
  const sent: { content: string }[] = [];
  const pi = { on: (name: string, fn: (e: unknown, ctx: unknown) => Promise<unknown>) => (handlers[name] = fn), sendMessage: (m: { content: string }) => sent.push(m) };
  const branch: unknown[] = [];
  registerSandboxNote(pi as never, {}, deps());
  const ctx = ctxOf(branch);
  assert.equal(await handlers.before_agent_start!({}, ctx), undefined, "Subagents only: nothing");

  branch.push(sandboxEntry(true));
  const first = (await handlers.before_agent_start!({}, ctx)) as { message: { customType: string; content: string; display: boolean; details: { digest: string } } };
  assert.equal(first.message.customType, SANDBOX_NOTE_MESSAGE);
  assert.equal(first.message.display, false, "hidden");
  assert.equal(first.message.details.digest, noteDigest(first.message.content));
  branch.push({ type: "custom_message", ...first.message });
  assert.equal(lastNoteDigest(historyOf(branch), SANDBOX_NOTE_MESSAGE), first.message.details.digest);
  assert.equal(await handlers.before_agent_start!({}, ctx), undefined, "unchanged: nothing sent");

  // A tracked worktree is a new root: a new note.
  branch.push(worktreesEntry([TREE]));
  const second = (await handlers.before_agent_start!({}, ctx)) as { message: { content: string } };
  assert.match(second.message.content, new RegExp(`/home/u/proj, ${TREE} and`));
  branch.push({ type: "custom_message", ...second.message });
  assert.equal(await handlers.before_agent_start!({}, ctx), undefined);

  await handlers.session_compact!({}, ctx);
  assert.equal(sent.length, 1, "re-sent after a compaction");
  assert.equal(sent[0]!.content, second.message.content);

  // Turned off: nothing more, and nothing after a compaction either.
  branch.push(sandboxEntry(false));
  assert.equal(await handlers.before_agent_start!({}, ctx), undefined);
  await handlers.session_compact!({}, ctx);
  assert.equal(sent.length, 1);
});

test("the instance note's ports line: an On chat or worker can't reach its ports; a write-only worker, on the host's network, can", () => {
  const on = stateView(historyOf([sandboxEntry(true)]));
  assert.equal(sandboxedOf(stateView([])), false);
  assert.equal(sandboxedOf(on), true, "an On chat");
  // A write-only worker's own extension writes `on: true`; its launch flags say it is write-only.
  assert.equal(sandboxedOf(on, writeOnlyFlags()), false, "a write-only worker");
  assert.equal(sandboxedOf(stateView([]), onWorkerFlags()), true, "an On worker");
  assert.equal(sandboxedOf(stateView([]), { sandbox: "on", "sandbox-parent": "{nope" }), true, "a malformed scope fails closed");
  assert.equal(sandboxedOf(on, {}), true, "a worker with no sandbox flags: its branch decides");
});
