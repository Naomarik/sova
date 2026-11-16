// Run: pnpm test -- server/modes/engine-hooks.test.ts. Sova's mode engine as a chat loads it, on a fake pi host
// (tests/engine-host.fixture.ts): its hooks and commands driven directly, no model and no chat. Rules the pi mode
// extension's own tests held before that extension was deleted, now on the engine: Create (strict, restore, the
// last normal-or-Delegate choice, the hook that permits a switch), the align settle nudge under each Eagerness, and
// project minor modes (the kept copy, the mid-chat note, removed and broken modes, the worker hand-off). Project
// tools that run a program are engine-project-tools.integration.test.ts's; the other rules, engine-rules.test.ts's.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const { agentDir, scratch, fakePi, inSova } = await import("./tests/engine-host.fixture");
type Entry = import("./tests/engine-host.fixture").Entry;
const { CREATE_INSTRUCTIONS } = await import("../../pi-config/extensions/mode/create/guide.ts");
const { ALIGN_NUDGE_MESSAGE } = await import("../../pi-config/extensions/mode/align.ts");
const { MODE_NOTE_TYPE } = await import("../../pi-config/extensions/mode/state.ts");
const { PROJECT_SNAPSHOT_TYPE } = await import("../../pi-config/extensions/mode/project-format.ts");

const lastActive = (entries: Entry[]) => (entries.filter((e) => e.customType === "mode").at(-1)?.data as { active?: { mode: string; lastMode?: string } }).active;

// ── Create (§chat/create-mode) ──────────────────────────────────────────────────────────────────

test("Create: a strict Create chat has lost edit and write; they stay gone into Delegate and come back in normal", async () => {
  await inSova(async () => {
    const p = fakePi([]);
    await p.start();
    await p.mode("strict on");
    assert.ok(p.activeTools().includes("edit"), "strict does nothing in normal");
    await p.mode("align on");
    await p.mode("create");
    const tools = p.activeTools();
    assert.ok(!tools.includes("edit") && !tools.includes("write"), `lost: ${tools}`);
    assert.ok(tools.includes("create_guide"), `the lookup: ${tools}`);
    const prompt = await p.prompt();
    assert.ok(prompt?.includes("# Mode: delegate"), "Delegate's block");
    assert.ok(prompt?.includes("takes precedence over delegation"), "the align bridge");
    assert.ok(prompt?.includes(CREATE_INSTRUCTIONS), "Create's block");

    await p.mode("delegate");
    assert.ok(!p.activeTools().includes("edit"), "moving to Delegate keeps them away");
    assert.ok(!p.activeTools().includes("create_guide"), "only Create has the lookup");
    await p.mode("create");
    assert.ok(!p.activeTools().includes("write"), "and back");
    assert.ok(p.activeTools().includes("create_guide"));
    await p.mode("normal");
    assert.ok(p.activeTools().includes("edit") && p.activeTools().includes("write"), "leaving both brings them back");
    assert.ok(!p.activeTools().includes("create_guide"), "leaving Create takes the lookup, strict snapshot included");
  });
});

test("Create: a strict chat restored in Create applies strict on open", async () => {
  await inSova(async () => {
    const entries: Entry[] = [];
    const a = fakePi(entries);
    await a.start();
    await a.mode("strict on");
    await a.mode("create");
    const b = fakePi(entries);
    await b.start("resume");
    assert.ok(!b.activeTools().includes("edit"));
    assert.ok(b.activeTools().includes("create_guide"));
  });
});

test("Create: the chat's entry keeps its last normal or Delegate choice (what Save as Default saves), never Create", async () => {
  await inSova(async () => {
    const entries: Entry[] = [];
    const p = fakePi(entries);
    await p.start();
    await p.mode("delegate");
    await p.mode("create");
    assert.equal(lastActive(entries)?.lastMode, "delegate");
    // Out of Create the field goes; a later entry into Create takes the newer choice.
    await p.mode("normal");
    assert.equal(lastActive(entries)?.lastMode, undefined);
    await p.mode("create");
    assert.equal(lastActive(entries)?.lastMode, "normal");
  });
});

test("Create: a chat Sova isn't applying a switch for can't type its way in (the hook says no), nor can a process with no hook", async () => {
  for (const run of [<T>(fn: () => Promise<T>) => inSova(fn, false), <T>(fn: () => Promise<T>) => fn()]) {
    await run(async () => {
      const entries: Entry[] = [];
      const p = fakePi(entries);
      await p.start();
      await p.mode("create");
      assert.equal(entries.filter((e) => e.customType === "mode").length, 0, "no entry");
      assert.ok(!p.activeTools().includes("create_guide"));
      assert.ok(p.notes.some((n) => n.level === "warning" && n.text.startsWith("Mode not changed: ")), JSON.stringify(p.notes));
    });
  }
});

test("Create: a chat saved in Create, opened with no hook, runs as Delegate and its entry stays", async () => {
  const entries: Entry[] = [{ type: "custom", customType: "mode", data: { mode: "create", active: { version: 1, mode: "create", strict: true, minorModes: ["align"], lastMode: "normal" } } }];
  const before = JSON.stringify(entries);
  const p = fakePi(entries);
  await p.start("resume");
  assert.equal(JSON.stringify(entries), before, "opening writes nothing");
  assert.ok(!p.activeTools().includes("edit"), "strict still holds");
  assert.ok(!p.activeTools().includes("create_guide"));
  const prompt = await p.prompt();
  assert.ok(prompt?.includes("# Mode: delegate"));
  assert.ok(!prompt?.includes(CREATE_INSTRUCTIONS));
});

// ── The align settle nudge (§chat.alignment/when, §chat.alignment/eagerness) ────────────────────

/** Eagerness in mode-align.json: absent is Eager. The nudge reads the value in effect when the run settles. */
const setEagerness = (to: "careful" | "eager" | undefined) =>
  writeFileSync(join(agentDir, "mode-align.json"), JSON.stringify({ version: 1, style: "pm", visuals: false, ...(to ? { eagerness: to } : {}) }));

/** A chat with align on (the `minor` flag), its runs driven one at a time: prompt, align calls, final reply. */
async function nudgeHost(eagerness?: "careful" | "eager") {
  setEagerness(eagerness);
  const p = fakePi([], { flags: { minor: "align" } });
  await p.start();
  const run = async (prompt: string, alignArgs: unknown[], reply: string) => {
    await p.fire("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "base" });
    for (const [i, args] of alignArgs.entries()) {
      await p.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: `c${i}`, toolName: "align", args });
      // A mark (or a refused call) records nothing: no document, no exemption.
      await p.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: `c${i}`, toolName: "align", isError: false, result: { details: { v: 1, changes: [], line: "" } } });
    }
    await p.fire("turn_end", { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
    const settled = (await p.fire("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" })) as { entries: { customType?: string }[]; continue: boolean } | undefined;
    await p.fire("agent_settled", { type: "agent_settled" });
    return settled;
  };
  return { run };
}

const nudgedBy = (settled: { entries: { customType?: string }[] } | undefined) => settled?.entries.some((e) => e.customType === ALIGN_NUDGE_MESSAGE) === true;
const PLAN = "Plan:\n- add the route\n- add the button\n\nShould I go ahead?";
const ASKS = "Playbooks are recipes a project runs, step by step.\n\nShould I go ahead with that?";

test("settle nudge, Eager (the default): any run whose reply reads like a plan is nudged, marked or not", async () => {
  const host = await nudgeHost();
  const settled = await host.run("add an export", [], PLAN);
  assert.equal(nudgedBy(settled), true, "no mark, no file: Eager judges the run's reply");
  assert.equal(settled?.continue, true);
  assert.equal(nudgedBy(await host.run("explain playbooks", [], "Playbooks are recipes a project runs, step by step.")), false, "a reply that reads like no plan is left alone");
  // The Eagerness in effect when the run settles: Careful now, so the same unmarked run is left alone.
  setEagerness("careful");
  assert.equal(nudgedBy(await host.run("add an export", [], PLAN)), false, "Careful: unmarked, never nudged");
  setEagerness("eager");
  assert.equal(nudgedBy(await host.run("add an export", [], PLAN)), true, "back to Eager: nudged again");
});

test("settle nudge, Careful: a run nobody marked as a change request is never nudged, whatever its reply asks", async () => {
  const host = await nudgeHost("careful");
  const settled = await host.run("explain playbooks", [], ASKS);
  assert.equal(nudgedBy(settled), false, "no ALIGN_NUDGE_MESSAGE without the mark");
  assert.equal(settled, undefined, "the run settles as it was");
  // A bare get is no mark either.
  assert.equal(nudgedBy(await host.run("explain playbooks", [{ ops: [{ op: "get" }] }], "Plan:\n- a\n- b\n\nShould I go ahead?")), false);
});

test("settle nudge, Careful: with the change-request mark (or any align op but get) the same reply is nudged once", async () => {
  const host = await nudgeHost("careful");
  const settled = await host.run("explain playbooks", [{ ops: [{ op: "change_request" }] }], ASKS);
  assert.equal(nudgedBy(settled), true, "the marked run gets ALIGN_NUDGE_MESSAGE");
  assert.equal(settled?.continue, true);
  // The mark holds for its run only: the next run, unmarked, is left alone.
  assert.equal(nudgedBy(await host.run("explain playbooks", [], ASKS)), false, "the mark ends with its run");
  // A refused create still marks the run (refused or not); it recorded nothing, so the plan is nudged.
  assert.equal(nudgedBy(await host.run("add an export", [{ ops: [{ op: "create" }] }], ASKS)), true);
  // The plan just above its working notes is the reply's end.
  assert.equal(nudgedBy(await host.run("add an export", [{ ops: [{ op: "change_request" }] }], "Plan:\n- a\n- b\n\nShould I go ahead?\n\n### Working notes\nRead the code. Nothing else.")), true);
});

// ── Project minor modes (§chat.mode-menu/project-modes) ─────────────────────────────────────────

function project(name: string) {
  const root = join(scratch, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  const dirOf = (id: string) => join(root, ".sova", "minor-modes", id);
  const put = (id: string, rel: string, text: string) => {
    mkdirSync(join(dirOf(id), rel, ".."), { recursive: true });
    writeFileSync(join(dirOf(id), rel), text);
  };
  return { root, dirOf, put };
}

const notesMode = (body: string, workers = "no") => `---\ndescription: Keep notes\nworkers: ${workers}\n---\n${body}\n`;

test("project modes: the copy turned on rebuilds byte-identically after the folder changed, on reopen and after a compaction", async () => {
  const p = project("t13");
  p.put("notes", "MODE.md", notesMode("Write notes in ./NOTES.md."));
  const entries: Entry[] = [];
  const a = fakePi(entries, { cwd: p.root });
  await a.start();
  await a.mode("project:notes on");
  assert.ok(entries.some((e) => e.customType === PROJECT_SNAPSHOT_TYPE), "the copy is saved in the chat");
  const first = await a.prompt();
  assert.ok(first?.includes("# Project minor mode: notes\nFolder: "), first);
  assert.ok(first?.includes("Write notes in ./NOTES.md."));

  p.put("notes", "MODE.md", notesMode("EDITED instructions."));
  const b = fakePi(entries, { cwd: p.root });
  await b.start("resume");
  assert.equal(await b.prompt(), first, "byte-identical mode section on reopen");

  await b.compact();
  const c = fakePi(entries, { cwd: p.root });
  await c.start("resume");
  assert.equal(await c.prompt(), first, "after a compaction the head is rebuilt from the copy, never the folder");

  // Off and on again takes the edit.
  await c.mode("notes off");
  await c.mode("notes on");
  const d = fakePi(entries, { cwd: p.root });
  await d.start("resume");
  await d.compact();
  assert.match((await d.prompt()) ?? "", /EDITED instructions\./);
});

test("project modes: turned on mid-chat, the prompt keeps its head, a hidden note carries the block once, a reopen repeats nothing", async () => {
  const p = project("midchat");
  p.put("notes", "MODE.md", notesMode("Mid-chat body."));
  const entries: Entry[] = [];
  const a = fakePi(entries, { cwd: p.root });
  await a.start();
  const head = await a.prompt();
  await a.mode("notes on");
  assert.equal(await a.prompt(), head, "a toggle never rewrites the cached head");
  const note = a.sent.find((m) => m.customType === MODE_NOTE_TYPE);
  assert.ok(note?.content.includes("turned the project minor mode notes on") && note.content.includes("Mid-chat body."), note?.content);

  const b = fakePi(entries, { cwd: p.root });
  await b.start("resume");
  assert.equal(await b.prompt(), head);
  assert.equal(b.sent.filter((m) => m.customType === MODE_NOTE_TYPE).length, 0, "nothing new to tell after a reopen");
  await b.mode("notes off");
  await b.prompt();
  assert.match(b.sent.at(-1)!.content, /turned the project minor mode notes off/);
});

test("project modes: a deleted mode stays on until turned off; broken folders and clashes are never turned on", async () => {
  const p = project("removed");
  p.put("notes", "MODE.md", notesMode("Body."));
  p.put("spec", "MODE.md", notesMode("Clash."));
  p.put("broken", "MODE.md", "no fence");
  const entries: Entry[] = [];
  const a = fakePi(entries, { cwd: p.root });
  await a.start();
  await a.mode("notes on");
  await a.mode("project:broken on");
  assert.match(a.notes.at(-1)!.text, /not turned on: .*MODE\.md must start/);
  await a.mode("project:spec on");
  assert.match(a.notes.at(-1)!.text, /not turned on: .*built-in minor mode/, "a clash never replaces the built-in");
  rmSync(p.dirOf("notes"), { recursive: true });
  const b = fakePi(entries, { cwd: p.root });
  await b.start("resume");
  assert.match((await b.prompt()) ?? "", /# Project minor mode: notes/, "removed from the folder, still on from its copy");
  await b.mode("notes off");
  await b.compact();
  assert.doesNotMatch((await b.prompt()) ?? "", /# Project minor mode: notes/, "off: gone");
});

test("project modes: a workers: yes mode's copy reaches workers, within the cap", async () => {
  const p = project("workers");
  p.put("crew", "MODE.md", notesMode("Crew rules.", "yes"));
  p.put("solo", "MODE.md", notesMode("Solo rules."));
  const a = fakePi([], { cwd: p.root });
  await a.start();
  await a.mode("crew on");
  await a.mode("solo on");
  const last = a.workerEvents.at(-1) as { minorModes: string[]; prompt?: string; projectModes?: { id: string }[] };
  assert.deepEqual(last.projectModes?.map((m) => m.id), ["crew"]);
  assert.ok(last.prompt?.includes("Crew rules.") && !last.prompt.includes("Solo rules."));
});

// ── The Agree step (§tools.spec/agree-source-relay, §tools.spec/writing-on-demand) ──────────────

test("Agree step: align's go-ahead (an alignment moved to implementing) carries the Agree step and then the writing procedure, once, only with spec on too", async () => {
  const goAhead = async (minors: string[]) => {
    const p = fakePi([]);
    await p.start();
    for (const m of minors) await p.mode(`${m} on`);
    const align = p.tools.get("align")!;
    const run = (ops: unknown[], doc?: string) => align.execute("c", { ...(doc ? { doc } : {}), ops }, undefined, undefined, p.ctx).then((r) => r.content[0]!.text);
    await run([{ op: "create", title: "Export", summary: "Add a CSV export." }]);
    const text = await run([{ op: "status", to: "implementing" }]);
    // A second go-ahead (another alignment's) in the same chat: the procedure was handed over already.
    await run([{ op: "create", title: "Import", summary: "Add a CSV import." }]);
    return { text, again: await run([{ op: "status", to: "implementing" }], "al_2") };
  };
  const both = await goAhead(["align", "spec"]);
  assert.match(both.text, /Spec mode is on too, so this go-ahead is the Agree step\. .*sova-spec-draft\.mjs" agree <draft> --id '<§id>'/);
  const handover = both.text.search(/Writing procedure \(once; also at [^)]*\/pi-config\/extensions\/spec\/WRITING\.md\):/);
  assert.ok(handover > both.text.indexOf("the Agree step"), "this copy's writing procedure follows the Agree step");
  assert.doesNotMatch(both.again, /Writing procedure \(once/, "handed over once");
  const alignOnly = await goAhead(["align"]);
  assert.doesNotMatch(alignOnly.text, /Agree step/, "align alone never asks for the agree step");
  assert.doesNotMatch(alignOnly.text, /Writing procedure/, "nor hands the procedure over");
});
