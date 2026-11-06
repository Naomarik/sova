// The recorded cases (harness.fixture.ts says what a recording holds). Each case is one chat (or a parent and its
// workers) driven from a fresh session through the routes Sova itself uses: the mode menu's switch
// (`ChatSession.switchMode`), typed commands in the composer (`ChatSession.prompt`), a reopen, an
// extension-started turn. The scripted model answers "ok" unless a step names its replies.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piSession } from "../../harness/pi/testing/handle";
import { agentDir, assertOnce, ownerNow, withExtensions, REPO, cm, normalize, type Owner, Recorded, sessionFile, modeEntry, workspace, type Where } from "./harness.fixture";

export interface Case {
  name: string;
  /** What it covers, one line. */
  covers: string;
  // Run it after harness.beginCase(<run>): the same case runs once per owner, each run in folders of its own.
  /**
   * Where the switch on is meant to differ from off (a review check of al_1): instead of the byte
   * comparison, this checks the on run's record, given the off run's.
   */
  onDiffers?: (on: unknown, off: unknown) => void;
  /**
   * Not recorded at master (it needs a1's `spec` tool): no recording file; this checks its record instead,
   * and with the switch on the byte comparison with the off run still holds.
   */
  unrecorded?: (record: unknown) => void;
  /** It runs programs (the spec census and drift check run the spec tools; a project tool is a program):
      the integration tier's (`*.golden.integration.test.ts`); the rest are unit-tier. */
  proc?: true;
  run(owner: Owner): Promise<unknown>;
}

const PLAN = "The plan is ready.\n\n**Open questions, with my suggested answers:**\n1. **Cap:** 400\n2. **Group:** by worker\n\nShould I go ahead with those answers?";
const ALIGN_CREATE = {
  ops: [
    { op: "change_request" },
    { op: "create", title: "Export", summary: "Download a session.", questions: [{ topic: "Format", ask: "JSONL or markdown?", recommendation: { choice: "JSONL", why: "lossless" } }] },
  ],
};

/** One chat from a fresh session in `w`, driven by `drive`, its steps the record. */
async function chatCase(w: Where, drive: (r: Recorded) => Promise<void>, entries: unknown[] = []): Promise<unknown> {
  const r = await Recorded.open(sessionFile(w, entries));
  try {
    await r.step("open", () => undefined);
    await drive(r);
  } finally {
    await r.dispose();
  }
  return r.steps;
}

const plainWs = () => workspace("plain");

/** A checkout with project modes: `checks` (no tools, workers: yes) and `rel` (one tool, workers: yes). */
function projectWs(): Where {
  return workspace("project", {
    git: true,
    files: {
      ".sova/minor-modes/checks/MODE.md": "---\ndescription: Check the release list\nworkers: yes\n---\nBefore you tag a release, read checklist.md and go through it item by item.\n",
      ".sova/minor-modes/checks/checklist.md": "- tests pass\n",
      ".sova/minor-modes/rel/MODE.md":
        '---\ndescription: Release status\nworkers: yes\ntools: [{"name": "status", "description": "Print the release status.", "params": {"type": "object", "properties": {"verbose": {"type": "boolean"}}}, "command": ["node", "./status.mjs"]}]\n---\nUse rel__status before tagging.\n',
      ".sova/minor-modes/rel/status.mjs": 'let s = "";\nprocess.stdin.on("data", (d) => (s += d)).on("end", () => console.log("release ok " + s));\n',
    },
  });
}
/** Approve `rel`'s tools for the project checkout, as the user's page would. */
async function approveRel(): Promise<void> {
  const { discoverProjectModes } = await import("../../../pi-config/extensions/mode/project-discovery.ts");
  const { recordApproval } = await import("../../project-mode-approvals");
  const listing = discoverProjectModes(projectWs().cwd);
  const rel = listing.modes.find((m) => m.id === "rel");
  assert.ok(rel && listing.root, `the rel mode is listed (${JSON.stringify(listing.problems)})`);
  recordApproval(listing.root, "rel", rel.toolsHash, "user");
}

/** A checkout with a spec: one claim over src/, a draft-free .gitignore. */
function specWs(name = "spec"): Where {
  return workspace(name, {
    git: true,
    files: {
      ".sova/spec/manifest.json": JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/", directoryKinds: ["section"] }, boundary: { include: ["src"], exclude: [] }, claims: { "§app/shell": { kind: "surface", code: ["src/App.tsx"] } } }),
      ".sova/spec/claims/app/shell.md": "# §app/shell\n\nShell.\n",
      ".sova/spec/.gitignore": "/drafts/\n",
      "src/App.tsx": "1\n",
    },
  });
}

function withFile<T>(path: string, text: string, fn: () => Promise<T>): Promise<T> {
  writeFileSync(path, text);
  return fn().finally(() => rmSync(path, { force: true }));
}

// ── Workers ───────────────────────────────────────────────────────────────────────────────────────

interface Start {
  key: string;
  spec: { extensions: string[]; env: Record<string, string>; appendSystemPrompt: string | null; [k: string]: unknown };
  session: { new?: { dir: string } };
  task: string | null;
}
const starts: Start[] = [];
cm.setWorkerHostSource(
  () =>
    ({
      async start(req: Start) {
        starts.push(req);
        const n = starts.length;
        return { chatId: `w${n}`, sessionId: `w${n}`, sessionFile: "", workerId: `ag_0${n}`, kind: "worker", pid: null, state: "open" };
      },
      async send() {
        return { queued: false };
      },
      async abort() {},
      async stop() {},
      watch() {
        return () => {};
      },
      async list() {
        return [];
      },
    }) as never,
);

/** A start as recorded: its key's random part and the per-process landed file names dropped. */
function startRecord(s: Start): unknown {
  // The owner the parent stamped (cutover: WorkerSpec.modes): "sova" with the switch on, none with it off.
  // Asserted here and left out, so the record is the same either way.
  const { modes, ...rest } = s.spec as Start["spec"] & { modes?: unknown };
  if (ownerNow() === "sova") assert.equal(modes, "sova", "a worker of a parent on Sova's engine is stamped modes: \"sova\"");
  else assert.equal(modes, undefined, "a worker of a parent on the mode extension carries no modes stamp");
  s = { ...s, spec: rest as Start["spec"] };
  const spec = normalize({ ...s.spec, env: Object.fromEntries(Object.entries(s.spec.env).map(([k, v]) => [k, k === "SOVA_SPEC_LANDED_FILE" || k.endsWith("_FILE") ? "<file>" : v])) });
  return { spec, session: normalize(s.session), task: s.task };
}

/** Build the worker a captured start describes, in this process, and record its first run. */
async function runWorker(s: Start): Promise<unknown> {
  const dir = s.session.new?.dir;
  assert.ok(dir, "a new worker session");
  mkdirSync(dir, { recursive: true });
  const w: Where = { cwd: s.spec.cwd as string, dir };
  const path = sessionFile(w);
  cm.setWorkerSpec(path, s.spec as never);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(s.spec.env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const r = await Recorded.open(path, { worker: true });
    try {
      await r.prompt(s.task ?? "go");
      const first = r.model.calls[0]!.context as { messages: unknown[] };
      assertOnce(first.messages, "worker");
    } finally {
      await r.dispose();
      cm.setWorkerSpec(path, null);
    }
    return r.steps;
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * A parent chat in `w` with `patch` switched on, whose model spawns one worker with `args`; the record is the
 * parent's steps, the start Sova's worker host was handed, and (when `run`) the worker's own first run.
 */
async function workerCase(w: Where, patch: Record<string, unknown>, args: Record<string, unknown>, run = true, before?: () => Promise<void>, entries: unknown[] = []): Promise<unknown> {
  await before?.();
  const from = starts.length;
  const parent = await chatCase(
    w,
    async (r) => {
      await r.switch(patch);
      await r.prompt("spawn", { toolCall: { name: "agent_spawn", arguments: { prompt: "do the task", name: "w", model: "scripted/scripted", ...args } } }, { text: "ok" });
    },
    entries,
  );
  const mine = starts.slice(from);
  if (mine.length === 0) return { parent, start: null, worker: null }; // refused: the parent's tool result says why
  assert.equal(mine.length, 1, "one worker start");
  const start = mine[0]!;
  // The spec block reaches the worker once: in its appended prompt, never also in its own sections.
  const block = (start.spec.appendSystemPrompt ?? "").match(/^# Minor mode: spec$/gm)?.length ?? 0;
  assert.ok(block <= 1, "the worker's appended prompt carries the spec block at most once");
  return { parent, start: startRecord(start), worker: run ? await runWorker(start) : null };
}

/** A worker in a tracked worktree is confined to it by the sandbox extension: the tree cases load it too. */
const WITH_SANDBOX = () => [join(REPO, "pi-config/extensions/sandbox")];

/**
 * A worktree the parent tracks (its `worktrees` entry), with a `.agent` of its own (§chat.worktrees/worktree-config):
 * with the tree's mode extension in it (`withMode`), or without one.
 */
function treeWs(withMode: boolean): { w: Where; entries: unknown[] } {
  const name = withMode ? "tree-mode" : "tree-bare";
  const w = workspace(name, { git: true, files: { ".agent/settings.json": "{}\n" } });
  if (withMode && !existsSync(join(w.cwd, ".agent/extensions/mode"))) {
    mkdirSync(join(w.cwd, ".agent/extensions"), { recursive: true });
    symlinkSync(join(REPO, "pi-config/extensions/mode"), join(w.cwd, ".agent/extensions/mode"));
  }
  const tree = { path: w.cwd, branch: `feat/${name}`, base: "abc", baseBranch: "master", status: "active", session: "s", how: "created", at: 1788256800000 };
  const entries = [{ type: "custom", customType: "worktrees", data: { version: 1, trees: [tree] }, id: "t0", parentId: null, timestamp: "2026-10-06T00:00:00.000Z" }];
  return { w, entries };
}

// ── The cases ─────────────────────────────────────────────────────────────────────────────────────

const minor = (...m: string[]) => ({ minorModes: m });

export const CASES: Case[] = [
  { name: "c01-plain", covers: "normal, no minor: head, tools, no mode block", run: () => chatCase(plainWs(), async (r) => { await r.prompt("one"); await r.prompt("two"); }) },
  {
    name: "c02-strict-typed",
    covers: "typed /mode strict on|off: edit/write leave and return, between runs",
    run: () => chatCase(plainWs(), async (r) => { await r.prompt("/mode strict on"); await r.prompt("one"); await r.prompt("/mode strict off"); await r.prompt("two"); }),
  },
  { name: "c03-strict-entry", covers: "a session pinned strict by its mode entry", run: () => chatCase(plainWs(), async (r) => { await r.prompt("one"); }, [modeEntry({ mode: "normal", strict: true, minorModes: [] })]) },
  { name: "c04-delegate", covers: "Delegate from the menu: its block and tools", run: () => chatCase(plainWs(), async (r) => { await r.switch({ mode: "delegate" }); await r.prompt("one"); }) },
  { name: "c05-delegate-strict", covers: "strict Delegate", run: () => chatCase(plainWs(), async (r) => { await r.switch({ mode: "delegate" }); await r.prompt("one"); }, [modeEntry({ mode: "normal", strict: true, minorModes: [] })]) },
  { name: "c06-create", covers: "Create from the menu: its block and create_guide", run: () => chatCase(plainWs(), async (r) => { await r.switch({ mode: "create" }); await r.prompt("one"); }) },
  { name: "c07-align", covers: "align alone", run: () => chatCase(plainWs(), async (r) => { await r.switch(minor("align")); await r.prompt("one"); }) },
  { name: "c08-spec", proc: true, covers: "spec alone (no spec in the folder)", run: () => chatCase(plainWs(), async (r) => { await r.switch(minor("spec")); await r.prompt("one"); }) },
  { name: "c09-vis", covers: "vis alone: block and vis tools", run: () => chatCase(plainWs(), async (r) => { await r.switch(minor("vis")); await r.prompt("one"); }) },
  { name: "c10-memory", covers: "memory alone (the listing)", run: () => chatCase(plainWs(), async (r) => { await r.switch(minor("memory")); await r.prompt("one"); }) },
  { name: "c11-all-minors", proc: true, covers: "align+spec+vis+memory in normal", run: () => chatCase(plainWs(), async (r) => { await r.switch(minor("align", "spec", "vis", "memory")); await r.prompt("one"); }) },
  { name: "c12-delegate-all", proc: true, covers: "Delegate with every minor", run: () => chatCase(plainWs(), async (r) => { await r.switch({ mode: "delegate", ...minor("align", "spec", "vis", "memory") }); await r.prompt("one"); }) },
  { name: "c13-create-align-spec", proc: true, covers: "Create with align and spec", run: () => chatCase(plainWs(), async (r) => { await r.switch({ mode: "create", ...minor("align", "spec") }); await r.prompt("one"); }) },
  {
    name: "c14-toggles",
    proc: true,
    covers: "the head is kept and each toggle is a hidden mode-note; tool changes at the switch; typed /mode <minor> on",
    run: () =>
      chatCase(plainWs(), async (r) => {
        await r.prompt("one");
        await r.switch(minor("vis"));
        await r.prompt("two");
        await r.switch(minor("spec"));
        await r.prompt("three");
        await r.switch({ mode: "delegate" });
        await r.prompt("four");
        await r.prompt("/mode align on");
        await r.prompt("five");
        await r.prompt("/mode normal");
        await r.prompt("six");
        await r.prompt("/mode strict on");
        await r.prompt("seven");
      }),
  },
  {
    name: "c15-align-flow",
    covers: "align tool: change_request + create, align-state note on the next prompt, the settle nudge on a plan-like reply",
    run: () =>
      chatCase(plainWs(), async (r) => {
        await r.switch(minor("align"));
        await r.prompt("build an export", { toolCall: { name: "align", arguments: ALIGN_CREATE } }, { text: "Recorded." });
        await r.prompt("what next?");
        await r.prompt("and the cap?", { text: PLAN }, { text: "ok" });
      }),
  },
  {
    name: "c16-reopen",
    proc: true,
    covers: "a reopen rebuilds the head from mode-head and the notes; a note before and after",
    run: () =>
      chatCase(plainWs(), async (r) => {
        await r.switch(minor("spec", "align"));
        await r.prompt("one");
        await r.switch(minor("spec", "align", "vis"));
        await r.prompt("two");
        await r.step("reopen", () => r.reopen());
        await r.prompt("three");
        await r.switch(minor("align"));
        await r.prompt("four");
      }),
  },
  {
    name: "c17-style-careful",
    covers: "align's writing style (simplified) and Careful eagerness: mode-head, the style lines",
    run: () =>
      withFile(join(agentDir, "mode-align.json"), JSON.stringify({ version: 1, style: "simplified", visuals: true, eagerness: "careful" }), () =>
        chatCase(plainWs(), async (r) => {
          await r.switch(minor("align"));
          await r.prompt("one");
        }),
      ),
  },
  {
    name: "c18-extension-turn",
    covers: "a toggle between runs reaches a run a worker's report starts (the note steered at agent_start)",
    run: () =>
      chatCase(plainWs(), async (r) => {
        await r.prompt("one");
        await r.switch(minor("vis"));
        await r.step("a report starts a run", async () => {
          await piSession(r.chat).sendCustomMessage({ customType: "subagent-complete", content: "worker done", display: true }, { triggerTurn: true });
        });
      }),
  },
  {
    name: "c22-compaction",
    covers: "a compaction: the head rebuilt from the modes on then, align's state written once after the summary, kept notes dropped",
    run: () =>
      withExtensions(
        [],
        () =>
          chatCase(plainWs(), async (r) => {
            await r.switch(minor("align"));
            await r.prompt("build an export", { toolCall: { name: "align", arguments: ALIGN_CREATE } }, { text: "Recorded." });
            await r.switch(minor("align", "vis"));
            await r.prompt("two");
            await r.compact("Earlier: an export was aligned.");
            await r.prompt("three");
            await r.switch(minor("align"));
            await r.prompt("four");
          }),
        { compaction: { keepRecentTokens: 1 } },
      ),
  },
  {
    name: "c19-project-mode",
    covers: "project mode without tools on and off: snapshot entry, block, notes",
    run: () =>
      chatCase(projectWs(), async (r) => {
        await r.prompt("one");
        await r.switch({ projectModes: ["checks"] });
        await r.prompt("two");
        await r.switch({ projectModes: [] });
        await r.prompt("three");
      }),
  },
  {
    name: "c20-project-tools",
    proc: true,
    covers: "an approved project mode with a tool: the tool's spec, a call, its result",
    run: async () => {
      await approveRel();
      return chatCase(projectWs(), async (r) => {
        await r.switch({ projectModes: ["rel"], ...minor("spec") });
        await r.prompt("status?", { toolCall: { name: "rel__status", arguments: { verbose: true } } }, { text: "ok" });
      });
    },
  },
  {
    name: "c21-spec-census",
    proc: true,
    covers: "spec on in a checkout with a spec: the census note on an edit's result, the writing procedure",
    run: () =>
      chatCase(specWs(), async (r) => {
        await r.switch(minor("spec"));
        const file = join(specWs().cwd, "src/App.tsx");
        await r.prompt("change it", { toolCall: { name: "write", arguments: { path: file, content: "2\n" } } }, { text: "ok" });
        await r.prompt("again", { toolCall: { name: "write", arguments: { path: join(specWs().cwd, "src/New.tsx"), content: "1\n" } } }, { text: "ok" });
      }),
  },
  {
    name: "c23-spec-reads-one-source",
    proc: true,
    covers: "the census counts a spec tool read and a shell read through one function: the same note after either, another after none",
    unrecorded: (record) => {
      const r = record as Record<"tool" | "bash" | "none", { calls: { add: { role?: string; toolName?: string; content?: { text?: string }[] }[] }[] }[]>;
      // The unread line comes on the first tool result after the last edit: the follow-up read's.
      const after = (steps: (typeof r)["tool"]) => {
        const results = steps.flatMap((s) => s.calls.flatMap((c) => c.add)).filter((m) => m.role === "toolResult");
        const last = results.at(-1);
        assert.equal(last?.toolName, "bash", "the follow-up call's result");
        return (last?.content ?? []).map((b) => b.text ?? "").join("").replace(/<ws:spec-[a-z]+>|_ws_spec-[a-z]+_/g, "<ws>").replace(/\b[0-9a-f]{40}\b/g, "<commit>");
      };
      const unread = "[spec census] Unread § your change landed in: ";
      assert.ok(after(r.none).includes(unread), `no read: the census says the landed § is unread (${after(r.none).slice(-400)})`);
      assert.ok(!after(r.tool).includes(unread), "read with the spec tool: counted, so not unread");
      assert.equal(after(r.tool), after(r.bash), "a spec tool read and a shell read leave the same note: one counter");
    },
    run: async () => {
      const once = (name: string, read: { name: string; arguments: Record<string, unknown> } | null) => {
        const w = specWs(name);
        return chatCase(w, async (r) => {
          await r.switch(minor("spec"));
          const file = join(w.cwd, "src/App.tsx");
          const edit = { toolCall: { name: "write", arguments: { path: file, content: "2\n" } } };
          const next = { toolCall: { name: "bash", arguments: { command: "true" } } };
          await r.prompt("change it", ...(read ? [{ toolCall: read }] : []), edit, next, { text: "ok" });
        });
      };
      const core = '"$PI_CODING_AGENT_DIR/extensions/spec/core/sova-spec.mjs"';
      return {
        tool: await once("spec-tool", { name: "spec", arguments: { op: "read", id: "§app/shell" } }),
        bash: await once("spec-bash", { name: "bash", arguments: { command: `node ${core} read '§app/shell' --root "$PWD" --json` } }),
        none: await once("spec-none", null),
      };
    },
  },
  // Workers
  { name: "w01-spec-worker", proc: true, covers: "spec on: a code-writing pi worker's start (brief, census extension) and its first run", run: () => workerCase(plainWs(), minor("spec"), {}) },
  { name: "w02-no-spec-worker", covers: "no minor: a worker gets no mode text", run: () => workerCase(plainWs(), minor(), {}) },
  { name: "w03-readonly-spec-worker", proc: true, covers: "spec on: a read-only worker (no census extension)", run: () => workerCase(plainWs(), minor("spec"), { tools: ["read"] }) },
  { name: "w04-project-worker", proc: true, covers: "project modes with workers: yes and a tool, spec on: the worker's blocks and the project tool", run: () => workerCase(projectWs(), { projectModes: ["checks", "rel"], ...minor("spec") }, {}, true, approveRel) },
  { name: "w05-delegate-align-worker", proc: true, covers: "Delegate + align + spec parent: what reaches its worker", run: () => workerCase(plainWs(), { mode: "delegate", ...minor("align", "spec") }, {}) },
  { name: "w06-claude-worker", proc: true, covers: "a claude-code backend worker of a spec-on parent: its start (not run: it needs the Claude CLI)", run: () => workerCase(plainWs(), minor("spec"), { backend: "claude-code", model: "claude-code-cli/claude-sonnet-4-5" }, false) },
  {
    name: "w07-tree-config-bare",
    proc: true,
    covers: "useWorktreeConfig, the tree's .agent has no mode extension (today: refused; with Sova's modes: starts, with the spec block once)",
    onDiffers: (on, off) => {
      const o = off as { start: unknown };
      assert.equal(o.start, null, "switch off: refused, as at master (no mode extension in the tree)");
      const n = on as { start: { spec: { extensions: string[]; flags: Record<string, unknown> } } | null; worker: { headers?: Record<string, number> }[] | null };
      assert.ok(n.start, "switch on: the worker starts without the tree's mode extension");
      assert.deepEqual(
        { major: n.start.spec.flags.major, minor: n.start.spec.flags.minor },
        { major: "normal", minor: "spec" },
        "in normal mode with spec forced on, as a worktree-config worker is today",
      );
      const ran = n.worker?.find((s) => s.headers);
      assert.deepEqual(ran?.headers, { "# Minor mode: spec": 1 }, "its run's prompt has the spec block exactly once, and no other mode block");
    },
    run: () => {
      const t = treeWs(false);
      return withExtensions(WITH_SANDBOX(), () => workerCase(t.w, minor("spec"), { cwd: t.w.cwd, useWorktreeConfig: true }, true, undefined, t.entries));
    },
  },
  {
    name: "w08-tree-config-mode",
    proc: true,
    covers: "useWorktreeConfig, the tree's .agent has the mode extension: the worker's start, and its run with the spec block once",
    run: () => {
      const t = treeWs(true);
      return withExtensions(WITH_SANDBOX(), () => workerCase(t.w, minor("spec"), { cwd: t.w.cwd, useWorktreeConfig: true }, true, undefined, t.entries));
    },
  },
];

