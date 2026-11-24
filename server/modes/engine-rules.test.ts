// Run: pnpm test -- server/modes/engine-rules.test.ts. Sova's mode engine on a fake pi host (tests/engine-host.fixture.ts):
// one test per rule the pi mode extension's wiring smoke held before that extension was deleted, now on the engine
// (its terminal surfaces, the status line, palette, shortcuts, widgets and viewer, went with it). What a session
// restores and adopts (snapshot, default, launch flags, /tree), memory's web-only rule, typed commands, how the block
// reaches the prompt, and what is re-read at each turn boundary: Delegate routing, the subagent policy, the spec
// writer and the chat's subagent profile; a turn during the entry probe joins it.
import assert from "node:assert/strict";
import { renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const { agentDir, fakePi, flush, inSova } = await import("./tests/engine-host.fixture");
const { REPLY_SHAPE_INSTRUCTIONS } = await import("../../pi-config/extensions/mode/prompt.ts");
type Entry = import("./tests/engine-host.fixture").Entry;
const { MODE_STATE_EVENT } = await import("../../pi-config/extensions/mode/state.ts");
const { legacyProfile } = await import("../../pi-config/extensions/subagents/subagent-profiles.ts");

/**
 * The library an older build seeded from the legacy files ("My setup", the default), as on a computer set up
 * before built-in profiles: these tests are about how the engine reads routing, so each starts from one. A
 * computer with no library at all gets the built-in profiles (pi-config's subagent-profiles tests).
 */
function olderStarter(): void {
  writeFileSync(join(agentDir, "subagent-profiles.json"), JSON.stringify({ version: 1, profiles: [legacyProfile(agentDir)] }));
  writeFileSync(join(agentDir, "subagent-profiles-default.json"), JSON.stringify({ version: 1, default: "my-setup" }));
}

const FILES = ["mode.json", "mode-delegate.json", "mode-spec.json", "model-policy.json", "subagent-profiles.json", "subagent-profiles-default.json", "mode-align.json"];
beforeEach(() => olderStarter());
afterEach(() => {
  for (const f of FILES) rmSync(join(agentDir, f), { force: true });
  delete (globalThis as Record<symbol, unknown>)[WEB_MINOR];
});

const WEB_MINOR = Symbol.for("sova:web-minor");
let writes = 0;
/** Atomic replace, the way Sova writes a settings file (a new inode, so the per-turn stat sees it). */
function writeSetting(name: string, value: unknown): void {
  const file = join(agentDir, name);
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
  // A distinct mtime for each write: the policy reader re-reads on an mtime move, and a test writes within a millisecond.
  const at = new Date(Date.UTC(2026, 0, 1) + ++writes * 1000);
  utimesSync(file, at, at);
  // The legacy routing files reach a session through subagent-profiles.json, as an older build seeded it from them.
  if (name !== "model-policy.json" && name !== "mode.json") {
    olderStarter();
    const at2 = new Date(Date.UTC(2026, 0, 1) + ++writes * 1000);
    for (const f of ["subagent-profiles.json", "subagent-profiles-default.json"]) utimesSync(join(agentDir, f), at2, at2);
  }
}
const writeDefault = (mode: string, minorModes: string[], strict = false) => writeSetting("mode.json", { version: 1, mode, strict, minorModes });

type State = { mode: string; strict: boolean; minorModes: string[] };
/** A host whose published state (`mode:state`) is kept as it changes. */
function watched(entries: Entry[], opts: Parameters<typeof fakePi>[1] = {}) {
  const p = fakePi(entries, opts);
  let state: State | undefined;
  p.on(MODE_STATE_EVENT, (data) => (state = data as State));
  return { ...p, state: () => state };
}
const modeEntries = (entries: Entry[]) => entries.filter((e) => e.customType === "mode");

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const claude = (models: { id: string; efforts?: string[] }[]) => async () => models.map((m) => ({ id: m.id, efforts: m.efforts ?? [] }));
const ROUTING = {
  version: 1,
  profiles: {
    planning: { primary: { backend: "claude-code", model: "claude-fable-5-2", effort: "medium" }, fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "high" } },
    investigation: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "low" }, fallback: null },
    routine: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "low" }, fallback: null },
    complex: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: null },
  },
};

// ── What a session starts from ──────────────────────────────────────────────────────────────────

test("restore: the newest usable snapshot on the branch beats the launch flags and the default; strict Delegate retools; nothing is written", async () => {
  writeDefault("normal", []);
  const entries: Entry[] = [
    { type: "custom", customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes: [] } } },
    { type: "custom", customType: "mode", data: { mode: "delegate", active: { version: 1, mode: "delegate", strict: true, minorModes: ["align"] } } },
    { type: "custom", customType: "mode", data: { minor: "align", on: true } }, // legacy marker: never restores
    { type: "custom", customType: "mode", data: { active: { version: 2, mode: "normal", strict: false, minorModes: [] } } }, // newer schema: skipped
    { type: "custom", customType: "mode", data: null }, // malformed: skipped
  ];
  const p = watched(entries, { flags: { major: "normal", minor: "none" } });
  const before = entries.length;
  await p.start("startup");
  assert.deepEqual(p.state(), { ...p.state(), mode: "delegate", strict: true, minorModes: ["align"] });
  assert.ok(!p.activeTools().includes("edit") && !p.activeTools().includes("write"), `strict Delegate: ${p.activeTools()}`);
  assert.ok(p.activeTools().includes("align"), "align, on in the snapshot, brings its tool");
  assert.match((await p.turn()) ?? "", /# Mode: delegate/, "the restored mode shapes the prompt");
  assert.deepEqual(modeEntries(entries.slice(before)), [], "restoring writes no mode entry");
});

test("restore: an empty branch adopts the default as it is now and writes nothing; launch flags apply on a first start only", async () => {
  writeDefault("normal", ["align"]);
  const entries: Entry[] = [];
  const a = watched(entries);
  await a.start("resume");
  assert.deepEqual(a.state()?.minorModes, ["align"], "a never-switched session follows the default");
  assert.equal(modeEntries(entries).length, 0, "adopting the default appends no entry");
  assert.ok(a.activeTools().includes("edit") && a.activeTools().includes("align"), "the default is not strict, and has align on");

  const b = watched([], { flags: { minor: "none" } });
  await b.start("startup");
  assert.deepEqual(b.state()?.minorModes, [], "--minor none clears the default's minor modes");
  const c = watched([], { flags: { minor: "none" } });
  await c.start("resume");
  assert.deepEqual(c.state()?.minorModes, ["align"], "flags are a launch override, not a resume one");
  const d = watched([], { flags: { major: "delegate" } });
  await d.start("startup");
  assert.equal(d.state()?.mode, "delegate", "--major starts that launch in the mode");
  const e = watched([], { flags: { mode: "delegate" } });
  await e.start("startup");
  assert.equal(e.state()?.mode, "normal", "--mode is pi core's output-mode flag, never a mode override");
});

test("restore: --minor applies the names it knows and warns once about the others", async () => {
  const p = watched([], { flags: { minor: "align,bogus" } });
  await p.start("startup");
  assert.deepEqual(p.state()?.minorModes, ["align"]);
  const warnings = p.notes.filter((n) => n.level === "warning");
  assert.equal(warnings.length, 1, JSON.stringify(p.notes));
  assert.match(warnings[0]!.text, /bogus/);
});

test("/tree: a branch with no snapshot falls back to the default; one with strict Delegate retools, and back", async () => {
  writeDefault("normal", ["align"]);
  const entries: Entry[] = [];
  const p = watched(entries);
  await p.start();
  await p.fire("session_tree", { newLeafId: "a", oldLeafId: "b" });
  assert.deepEqual([p.state()?.mode, p.state()?.minorModes], ["normal", ["align"]], "a branch without a snapshot uses the default");
  entries.push({ type: "custom", customType: "mode", data: { strict: true, active: { version: 1, mode: "delegate", strict: true, minorModes: [] } } });
  await p.fire("session_tree", { newLeafId: "c", oldLeafId: "a" });
  await flush();
  assert.deepEqual([p.state()?.mode, p.state()?.strict], ["delegate", true], "the branch's snapshot applies");
  assert.ok(!p.activeTools().includes("edit") && !p.activeTools().includes("write"), "tree onto strict Delegate removes edit/write");
  entries.length = 0;
  await p.fire("session_tree", { newLeafId: "a", oldLeafId: "c" });
  assert.ok(p.activeTools().includes("edit") && p.activeTools().includes("write"), "tree back off strict restores them");
});

// ── memory is web-only (§chat.memory/where) ─────────────────────────────────────────────────────

test("memory: typed on is refused unless Sova's server applies the switch for this very session; off never is", async () => {
  const g = globalThis as Record<symbol, unknown>;
  const entries: Entry[] = [];
  const p = watched(entries);
  await p.start();
  await p.mode("memory on");
  assert.equal(modeEntries(entries).length, 0, "no hook: nothing written");
  assert.match(p.notes.at(-1)!.text, /memory is turned on from a Sova chat's mode menu/);
  g[WEB_MINOR] = (sid: string, minor: string) => sid === "chat-b" && minor === "memory";
  await p.mode("memory on");
  assert.equal(modeEntries(entries).length, 0, "a hook permitting another session permits nothing here");
  g[WEB_MINOR] = (sid: string, minor: string) => sid === "s1" && minor === "memory";
  await p.mode("memory on");
  assert.deepEqual((modeEntries(entries).at(-1)!.data as { active: State }).active.minorModes, ["memory"], "the server's switch turns it on");
  delete g[WEB_MINOR];
  await p.mode("memory off");
  assert.deepEqual((modeEntries(entries).at(-1)!.data as { active: State }).active.minorModes, [], "off needs no hook");
});

test("memory: a saved default with memory on is dropped by a process that isn't Sova's, kept by a Sova-hosted chat; mode.json stays as saved", async () => {
  writeDefault("normal", ["memory"]);
  const outside = watched([]);
  await outside.start();
  assert.ok(!outside.state()?.minorModes.includes("memory"), "no web-minor hook: no memory from the default");
  (globalThis as Record<symbol, unknown>)[WEB_MINOR] = () => false;
  const inside = watched([]);
  await inside.start();
  assert.ok(inside.state()?.minorModes.includes("memory"), "a Sova-hosted chat adopts memory from the default");
});

// ── Typed commands and the prompt ───────────────────────────────────────────────────────────────

test("typed: /mode completions include the minor modes; /align on|off is the minor toggle, tool included", async () => {
  const p = watched([]);
  await p.start();
  assert.deepEqual(p.completions("al"), ["align", "align on", "align off"]);
  await p.align("on");
  assert.ok(p.state()?.minorModes.includes("align") && p.activeTools().includes("align"));
  await p.align("off");
  assert.ok(!p.state()?.minorModes.includes("align"), "/align off turns the minor off");
  assert.ok(!p.activeTools().includes("align"), "/align off removes the tool");
});

test("prompt: a host with sections gets the block in the mode section and nothing else; normal keeps the reply shape alone; a host with none gets the whole prompt appended", async () => {
  const p = fakePi([]);
  await p.start();
  await p.mode("delegate");
  const sections: Record<string, string> = { preamble: "base" };
  const host = () => ({ prompt: "go", systemPrompt: "base", systemPromptOptions: { sections } });
  assert.equal(await p.fire("before_agent_start", host()), undefined, "a sections host gets no systemPrompt return");
  assert.match(sections.mode ?? "", /# Mode: delegate/);
  assert.deepEqual(Object.keys(sections), ["preamble", "mode"], "no other section is touched");
  assert.ok(sections.mode!.endsWith(`\n\n${REPLY_SHAPE_INSTRUCTIONS}`), "the reply shape last, after the delegate block");
  await p.mode("normal");
  await p.fire("before_agent_start", host());
  assert.deepEqual(sections, { preamble: "base", mode: REPLY_SHAPE_INSTRUCTIONS }, "normal mode with nothing on keeps the reply shape alone");

  const q = fakePi([]);
  await q.start();
  assert.equal(await q.turn(), `base\n\n${REPLY_SHAPE_INSTRUCTIONS}`, "normal mode appends the reply shape alone");
  await q.mode("delegate");
  assert.match((await q.turn()) ?? "", /^base\n\n# Mode: delegate/, "a host with no sections gets the appended prompt");
});

test("reply shape (§chat.mode-menu/reply-shape): a main chat's mode section carries it exactly once in every mode; a worker's never", async () => {
  const count = (text: string | undefined) => (text ?? "").split(REPLY_SHAPE_INSTRUCTIONS).length - 1;
  const p = fakePi([]);
  await p.start();
  for (const mode of ["normal", "delegate", "create"]) {
    await inSova(async () => p.mode(mode));
    for (const minors of [[], ["align"], ["spec"], ["align", "spec"]]) {
      for (const minor of ["align", "spec"]) await inSova(async () => p.mode(`${minor} ${minors.includes(minor) ? "on" : "off"}`));
      await p.compact(); // a new head, so the section holds the minors now on
      const section = await p.prompt();
      assert.equal(count(section), 1, `${mode}+${minors.join(",")}: once`);
      assert.equal(/# Mode: delegate/.test(section!), mode !== "normal", `${mode}: its major block is there`);
      assert.equal(/# Minor mode: align/.test(section!), minors.includes("align"), `${mode}+${minors.join(",")}: align's block follows the toggle`);
      assert.ok(section!.endsWith(REPLY_SHAPE_INSTRUCTIONS), `${mode}+${minors.join(",")}: last`);
    }
  }
  const w = fakePi([], { worker: true });
  await w.start();
  await w.mode("spec on");
  const worker = await w.prompt();
  assert.match(worker ?? "", /# Minor mode: spec/, "the worker's modes reach it");
  assert.equal(count(worker), 0, "a worker never carries the reply shape");
  assert.doesNotMatch(worker ?? "", /# Replies/);
  // The merge queue's own chats: Sova launches them with the flag, and their section is their mode blocks alone.
  const queue = fakePi([], { flags: { "reply-shape-off": true as never } });
  await queue.start();
  assert.equal(await queue.prompt(), undefined, "Normal with nothing on: no section at all");
  await inSova(async () => queue.mode("delegate"));
  const queueSection = await queue.prompt();
  assert.match(queueSection ?? "", /# Mode: delegate/);
  assert.equal(count(queueSection), 0, "its blocks, never the reply shape");
});

// ── Re-read at each turn boundary ───────────────────────────────────────────────────────────────

test("Delegate routing: an edit reaches an already-Delegate session at its next turn; normal mode never reads it", async () => {
  const p = fakePi([], { claudeModels: claude([{ id: "claude-fable-5-2", efforts: EFFORTS }, { id: "claude-opus-5-5", efforts: EFFORTS }]) });
  await p.start();
  await p.mode("delegate");
  assert.match((await p.turn()) ?? "", /- Routine implementation .* → backend "claude-code", model "claude-opus-5-5", effort "low"; no fallback — if it fails, ask the user\./, "defaults without a file");
  writeSetting("mode-delegate.json", { ...ROUTING, profiles: { ...ROUTING.profiles, routine: { primary: { backend: "pi", model: "zai/glm-5.3", effort: "high" }, fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "low" } } } });
  assert.match((await p.turn()) ?? "", /- Routine implementation .* → backend "pi", model "zai\/glm-5.3", effort "high"; fallback backend "claude-code", model "claude-opus-5-5", effort "low"\./, "re-read at the turn boundary");
  await p.mode("normal");
  assert.equal(await p.turn(), `base\n\n${REPLY_SHAPE_INSTRUCTIONS}`, "normal mode is unaffected by the routing: the reply shape alone");
});

test("Delegate routing: the subagent policy is re-read per turn; a denied primary goes to its fallback, disclosed; a denied backend asks", async () => {
  writeSetting("mode-delegate.json", ROUTING);
  const p = fakePi([], { claudeModels: claude([{ id: "claude-fable-5-2", efforts: EFFORTS }, { id: "claude-opus-5-5", efforts: EFFORTS }]) });
  await p.start();
  await p.mode("delegate");
  const policy = (models: string[], providers: string[]) => writeSetting("model-policy.json", { version: 1, disabledProviders: [], disabledModels: [], subagentDisabledProviders: providers, subagentDisabledModels: models });
  policy(["claude-code/claude-fable-5-2"], []);
  assert.match((await p.turn()) ?? "", /- Planning & specs .* → backend "claude-code", model "claude-opus-5-5", effort "high"\. This is the configured FALLBACK: .* is disabled as a subagent model by user settings\./);
  policy([], ["claude-code"]);
  assert.match((await p.turn()) ?? "", /- Complex implementation .* → NO AVAILABLE WORKER \(Backend claude-code is disabled for subagents by user settings\..*; no fallback is set\)/);
});

test("Delegate routing: a turn during the entry probe joins it, and the entry's fallback notice is still delivered", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const p = fakePi([], {
    claudeModels: async () => {
      calls++;
      await gate;
      return [{ id: "claude-fable-5-2", efforts: ["low"] }, { id: "claude-opus-5-5", efforts: [] }]; // planning lands on its fallback
    },
  });
  await p.start();
  const entering = p.mode("delegate"); // awaits its probe, which is gated
  await flush();
  assert.equal(calls, 1, "entering Delegate started one probe");
  await p.turn();
  await p.turn();
  assert.equal(calls, 1, "turns during the probe join it instead of restarting it");
  release();
  await entering;
  await flush();
  assert.ok(p.notes.some((n) => n.level === "warning" && /^Delegate routing:\nPlanning & specs: fallback/.test(n.text)), JSON.stringify(p.notes));
  await p.turn();
  await flush();
  assert.equal(calls, 1, "a fresh discovery is not repeated on the next turn");
});

test("spec writer: re-read at the turn boundary and probed while spec is on, outside Delegate; spec off leaves the head and says so", async () => {
  let calls = 0;
  const p = fakePi([], {
    claudeModels: async () => {
      calls++;
      return [{ id: "claude-fable-5-2", efforts: EFFORTS }, { id: "claude-opus-5-5", efforts: ["low"] }];
    },
  });
  await p.start();
  await p.mode("spec on");
  await p.compact(); // the head is rebuilt with spec in it
  let prompt = (await p.turn()) ?? "";
  assert.match(prompt, /# Minor mode: spec/);
  assert.doesNotMatch(prompt, /Spec writer:/, "no writer set: the session writes the spec itself");
  await flush();
  assert.equal(calls, 0, "no writer, not in Delegate: nothing to probe");

  writeSetting("mode-spec.json", { version: 1, writer: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "medium" }, fallback: { backend: "claude-code", model: "claude-fable-5-2", effort: "high" } } });
  prompt = (await p.turn()) ?? "";
  assert.match(prompt, /Spec writer: .* → backend "claude-code", model "claude-opus-5-5", effort "medium";/, "re-read at the turn boundary");
  assert.doesNotMatch(prompt, /# Mode: delegate/, "the writer needs no Delegate");
  await p.probed();
  assert.equal(calls, 1, "outside Delegate, spec on probes the writer's backend");
  prompt = (await p.turn()) ?? "";
  assert.match(prompt, /Spec writer: .* → backend "claude-code", model "claude-fable-5-2", effort "high"\. This is the configured FALLBACK/, "the probe found opus without medium");
  // A changed writer that lands on its fallback is announced once its probe lands.
  writeSetting("mode-spec.json", { version: 1, writer: { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "max" }, fallback: { backend: "claude-code", model: "claude-fable-5-2", effort: "high" } } });
  prompt = (await p.turn()) ?? "";
  await p.probed();
  assert.ok(p.notes.some((n) => n.level === "warning" && /^Spec writer: fallback claude-code · claude-fable-5-2 · high \(claude-opus-5-5 does not support effort "max"/.test(n.text)), JSON.stringify(p.notes));
  prompt = (await p.turn()) ?? "";

  await p.mode("spec off");
  assert.equal(await p.turn(), prompt, "a minor toggle leaves the prompt alone");
  assert.match(p.sent.at(-1)!.content, /^Mode change: the user turned the spec minor mode off\. Its instructions \(the "# Minor mode: spec" block in your system prompt\) no longer apply/);
});

test("spec writer: a writer-only change after a note-only spec turn-on reaches the model, on a run a worker's report starts too", async () => {
  const entries: Entry[] = [{ type: "custom", customType: "mode", data: { active: { version: 1, mode: "normal", strict: false, minorModes: [] } } }];
  const p = fakePi(entries);
  const writer = (model: string) => writeSetting("mode-spec.json", { version: 1, writer: { primary: { backend: "pi", model, effort: "high" }, fallback: null } });
  await p.start();
  await p.turn();
  writer("fixture/writer-a");
  await p.mode("spec on");
  await p.turn();
  assert.match(p.sent.at(-1)!.content, /fixture\/writer-a/);
  const at = p.sent.length;
  writer("fixture/writer-b");
  await p.fire("agent_start"); // no before_agent_start: a worker's report starts this run
  await p.fire("agent_settled");
  assert.equal(p.sent.length, at + 1, "a writer-only change sends fresh context");
  assert.match(p.sent.at(-1)!.content, /routing now applies instead of any earlier writer routing/);
  assert.match(p.sent.at(-1)!.content, /fixture\/writer-b/);
  assert.doesNotMatch(p.sent.at(-1)!.content, /fixture\/writer-a/);
});

test("subagent profiles: the chat's pick is re-read at each turn; an older Off pick follows the default; /mode subagents writes the pick once and answers \"off\" with the profiles there are", async () => {
  const route = (model: string) => Object.fromEntries(["planning", "investigation", "routine", "complex"].map((k) => [k, { primary: { backend: "claude-code", model, effort: "low" }, fallback: null }]));
  const empty = { teams: null, members: null, specWriter: null };
  writeFileSync(join(agentDir, "subagent-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "a", name: "A", delegate: route("claude-opus-5-5"), ...empty }, { id: "b", name: "B", delegate: route("claude-sonnet-5-5"), ...empty }] }));
  writeFileSync(join(agentDir, "subagent-profiles-default.json"), JSON.stringify({ version: 1, default: "a" }));
  const entries: Entry[] = [{ type: "custom", customType: "mode", data: { active: { version: 1, mode: "delegate", strict: false, minorModes: [] } } }];
  const p = fakePi(entries);
  await p.start();
  assert.match((await p.turn()) ?? "", /Routine implementation .* → backend "claude-code", model "claude-opus-5-5"/, "no pick: the default profile routes");
  entries.push({ type: "custom", customType: "subagent-profile", data: { v: 1, profile: "b" } });
  assert.match((await p.turn()) ?? "", /Routine implementation .* → backend "claude-code", model "claude-sonnet-5-5"/, "a pick written into the branch applies from the next turn");
  entries.push({ type: "custom", customType: "subagent-profile", data: { v: 1, profile: "off" } });
  assert.match((await p.turn()) ?? "", /Routine implementation .* → backend "claude-code", model "claude-opus-5-5"/, "an older Off pick follows the default");
  const before = entries.length;
  await p.mode("subagents B");
  assert.deepEqual(entries.at(-1), { type: "custom", customType: "subagent-profile", data: { v: 1, profile: "b" } }, "/mode subagents takes a name and writes the entry");
  await p.mode("subagents b");
  assert.equal(entries.length, before + 1, "the same pick again writes nothing");
  await p.mode("subagents nope");
  assert.equal(p.notes.at(-1)!.text, `No profile is named "nope"; the profiles here are A, B and Claude.`);
  await p.mode("subagents off");
  assert.equal(p.notes.at(-1)!.text, `No profile is named "off"; the profiles here are A, B and Claude.`);
  assert.equal(entries.length, before + 1, "nothing written for either");
  await p.mode("subagents claude");
  assert.match((await p.turn()) ?? "", /Planning & specs .* → backend "claude-code", model "claude-fable-5-2", effort "high"/, "a built-in profile by its id");
});

test("Sova's own chats (the no-helper-profile flag): with no default chosen, no helper profile, never the built-in one (b3); a default chosen still applies", async () => {
  for (const f of ["subagent-profiles.json", "subagent-profiles-default.json"]) rmSync(join(agentDir, f), { force: true });
  const entries: Entry[] = [{ type: "custom", customType: "mode", data: { active: { version: 1, mode: "delegate", strict: false, minorModes: [] } } }];
  const own = fakePi(entries, { flags: { "no-helper-profile": true } });
  await own.start();
  const none = (await own.turn()) ?? "";
  assert.match(none, /no subagent profile routes them/);
  assert.doesNotMatch(none, /→ backend/, "no worker line: delegate null");
  // A user's chat on the same computer: the built-in profile the accounts give (none connected here: Claude).
  const user = fakePi([...entries]);
  await user.start();
  assert.match((await user.turn()) ?? "", /Planning & specs .* → backend "claude-code", model "claude-fable-5-2", effort "high"/);
  // Nothing was written for either.
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(agentDir, "subagent-profiles.json")), false);
  assert.equal(existsSync(join(agentDir, "subagent-profiles-default.json")), false);
  olderStarter();
  const chosen = fakePi([...entries], { flags: { "no-helper-profile": true } });
  await chosen.start();
  assert.match((await chosen.turn()) ?? "", /→ backend "claude-code"/, "a default this computer has applies to them, as it always did");
});

// ── align's writing style, Eagerness and Visuals (§chat.alignment/style, /eagerness, /visuals) ─────

test("align style: the head carries the style it was built with; a change reaches the model once, as a hidden note, and never rewrites the prompt", async () => {
  const { ALIGN_INSTRUCTIONS, ALIGN_STYLE_PARAGRAPHS } = await import("../../pi-config/extensions/mode/minor.ts");
  const p = fakePi([], { flags: { minor: "align" } });
  await p.start();
  const head = (await p.prompt()) ?? "";
  assert.ok(head.includes(`${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`), "no mode-align.json: Project manager's paragraph follows the align block");
  writeSetting("mode-align.json", { version: 1, style: "simplified", visuals: false });
  assert.equal(await p.prompt(), head, "a style change never rewrites the prompt");
  const told = p.sent.filter((m) => m.content.includes(ALIGN_STYLE_PARAGRAPHS.simplified!));
  assert.equal(told.length, 1, "one hidden note carrying the new style's paragraph");
  assert.deepEqual(told[0]!.details, { v: 1, minorModes: ["align"], guides: [], style: "simplified", headStyle: "pm" });
  await p.prompt();
  assert.equal(p.sent.filter((m) => m.content.includes(ALIGN_STYLE_PARAGRAPHS.simplified!)).length, 1, "told once");
});

test("align Visuals: fixed at session start; on, they bring vis_guide with vis off, and a later change waits for the next session", async () => {
  writeSetting("mode-align.json", { version: 1, style: "pm", visuals: true });
  const on = fakePi([], { flags: { minor: "align" } });
  await on.start();
  await on.prompt();
  assert.ok(on.activeTools().includes("vis_guide"), `Visuals on, vis off: ${on.activeTools()}`);
  writeSetting("mode-align.json", { version: 1, style: "pm", visuals: false });
  await on.prompt();
  assert.ok(on.activeTools().includes("vis_guide"), "the session keeps the Visuals it started with");
  const off = fakePi([], { flags: { minor: "align" } });
  await off.start();
  await off.prompt();
  assert.ok(!off.activeTools().includes("vis_guide"), "Visuals off, vis off: no vis_guide");
});

test("strict (§chat.mode-menu/strict): it takes only edit and write; a tool that arrives while on stays when it ends, one removed while on stays removed", async () => {
  const entries: Entry[] = [];
  const p = fakePi(entries, { tools: ["read", "bash", "edit", "write", "grep"] });
  await p.start();
  await p.mode("delegate");
  await p.mode("strict on");
  assert.deepEqual(p.activeTools(), ["read", "bash", "grep"], "strict removed edit/write");
  assert.deepEqual(modeEntries(entries).at(-1)!.data, { strict: true, active: { version: 1, mode: "delegate", strict: true, minorModes: [] } }, "strict gets its own entry");
  await p.mode("normal");
  assert.deepEqual(p.activeTools(), ["read", "bash", "edit", "write", "grep"], "restored in place on leaving Delegate");
  await p.mode("delegate");
  p.setTools(["read", "bash", "project_verbs", "grep"]);
  await p.mode("strict off");
  assert.deepEqual(p.activeTools(), ["read", "bash", "project_verbs", "edit", "write", "grep"], "strict off: the arrival stays, once");
  await p.mode("strict on");
  assert.deepEqual(p.activeTools(), ["read", "bash", "project_verbs", "grep"], "strict removes only edit/write");
  p.setTools(["read", "bash", "grep"]);
  await p.mode("normal");
  assert.deepEqual(p.activeTools(), ["read", "bash", "edit", "write", "grep"], "removed during strict: it doesn't come back");
});
