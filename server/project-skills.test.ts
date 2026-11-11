// Run: pnpm test -- server/project-skills.test.ts. A throwaway agent dir in the OS temp dir.
//
// A project's skill defaults: the host-local store, the one off reading (isSkillOff), how a new chat's
// entry lays over its project's defaults, the stamp its first message writes, and the worker stamp.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const agent = mkdtempSync(join(tmpdir(), "sova-project-skills-test-"));
const prevAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
after(() => {
  if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgent;
  rmSync(agent, { recursive: true, force: true });
});

const store = await import("./project-skills-store");
const L = await import("./session-loadout");
const { skillsStamped } = await import("./chat-manager");
const { parseSkillChanges, skillsRowState, skillsView, sourceOf } = await import("./projects/skills");

beforeEach(() => rmSync(store.projectSkillsPath(), { force: true }));

// ---- the store ----------------------------------------------------------------------------------

test("the store: decisions saved at once, waiting clears one, a project with none left drops out of the file", () => {
  assert.deepEqual(store.readProjectSkillsStore(), { version: 1, projects: {} });
  store.setSkillDecisions("p1", { pdf: "disallowed", docx: "approved" });
  assert.deepEqual(store.projectSkillDecisions("p1"), { pdf: "disallowed", docx: "approved" });
  assert.deepEqual(store.disallowedSkills("p1"), ["pdf"]);
  assert.deepEqual(JSON.parse(readFileSync(store.projectSkillsPath(), "utf8")).projects.p1.skills, { pdf: "disallowed", docx: "approved" });
  store.setSkillDecisions("p1", { pdf: "waiting", docx: "waiting" });
  assert.deepEqual(store.readProjectSkillsStore().projects, {});
  assert.ok(existsSync(store.projectSkillsPath()));
});

test("the store reads strictly: a bad project key, a bad state or a non-object is never a decision", () => {
  mkdirSync(join(agent, "sova"), { recursive: true });
  writeFileSync(store.projectSkillsPath(), JSON.stringify({ version: 1, projects: { "bad key!": { skills: { a: "disallowed" } }, p2: { skills: { a: "off", b: "disallowed", "": "approved" } }, p3: 7 } }));
  assert.deepEqual(store.readProjectSkillsStore().projects, { p2: { skills: { b: "disallowed" } } });
  writeFileSync(store.projectSkillsPath(), "not json");
  assert.deepEqual(store.readProjectSkillsStore().projects, {});
});

test("a decided name no longer found drops off by itself; one still found stays", () => {
  store.setSkillDecisions("p1", { gone: "disallowed", kept: "approved" });
  assert.deepEqual(store.pruneSkillDecisions("p1", new Set(["kept", "new"])), ["gone"]);
  assert.deepEqual(store.projectSkillDecisions("p1"), { kept: "approved" });
  assert.deepEqual(store.pruneSkillDecisions("p1", new Set(["kept"])), []);
});

// ---- the view -----------------------------------------------------------------------------------

test("the view: every found skill with its state, Waiting with no decision, counted", () => {
  const found = [
    { name: "a", path: "/r/.agents/skills/a/SKILL.md", source: { kind: "project" as const } },
    { name: "b", path: "/r/x/.agents/skills/b/SKILL.md", source: { kind: "subfolder" as const, folder: "x" } },
    { name: "c", path: "/home/u/.pi/agent/skills/c/SKILL.md", source: { kind: "user" as const } },
  ];
  const v = skillsView(found, { a: "disallowed", c: "approved" });
  assert.deepEqual(v.skills.map((s) => [s.name, s.state]), [["a", "disallowed"], ["b", "waiting"], ["c", "approved"]]);
  assert.deepEqual(v.counts, { approved: 1, disallowed: 1, waiting: 1 });
});

test("the All settings row: No preference with nothing decided, else disallowed and waiting, else approved", () => {
  assert.equal(skillsRowState({ approved: 0, disallowed: 0, waiting: 4 }), "No preference");
  assert.equal(skillsRowState({ approved: 1, disallowed: 2, waiting: 1 }), "2 disallowed · 1 waiting");
  assert.equal(skillsRowState({ approved: 3, disallowed: 0, waiting: 0 }), "3 approved");
});

test("a PUT body is strict: one or more names, each approved, disallowed or waiting", () => {
  assert.deepEqual(parseSkillChanges({ skills: { a: "approved", b: "waiting" } }), { a: "approved", b: "waiting" });
  for (const bad of [null, {}, { skills: {} }, { skills: [] }, { skills: { a: "off" } }, { skills: { "": "approved" } }]) assert.throws(() => parseSkillChanges(bad), /Expected/);
});

test("a skill's source: the Claude folders, the project's own, else the user's", () => {
  assert.deepEqual(sourceOf("/r", "/r/.agents/skills/a/SKILL.md", "/c"), { kind: "project" });
  assert.deepEqual(sourceOf("/r", "/r/.claude/skills/a/SKILL.md", "/c"), { kind: "claude" });
  assert.deepEqual(sourceOf("/r", "/c/skills/a/SKILL.md", "/c"), { kind: "claude" });
  assert.deepEqual(sourceOf("/r", "/elsewhere/skills/a/SKILL.md", "/c"), { kind: "user" });
});

// ---- a chat's entry against its project ---------------------------------------------------------

const entry = (offSkills: string[], onSkills?: string[]): import("./session-loadout").LoadoutEntryData => ({ v: 1, offContext: [], offSkills, ...(onSkills ? { onSkills } : {}) });

test("isSkillOff is the entry's off list; no entry: every skill on", () => {
  assert.equal(L.isSkillOff(null, "a"), false);
  assert.equal(L.isSkillOff(entry(["a"]), "a"), true);
  assert.equal(L.isSkillOff(entry([], ["a"]), "a"), false);
});

test("before the first message: the project's disallowed ones off unless the chat switched them on; its own offs stay off", () => {
  assert.equal(L.pristineLoadout(null, []), null);
  assert.deepEqual(L.pristineLoadout(null, ["p"])?.offSkills, ["p"]);
  const d = L.pristineLoadout(entry(["own"], ["p2"]), ["p1", "p2"])!;
  assert.deepEqual([...d.offSkills].sort(), ["own", "p1"]);
  assert.equal(d.onSkills, undefined, "the applied list has no on list: isSkillOff reads it as is");
});

test("a card's whole off set keeps only its flips against the project, so a later decision still reaches the new chat", () => {
  const projectOff = ["p1", "p2"];
  // Card shows p1 off (project), p2 switched on, own off.
  const saved = L.flipsAgainstProject(entry(["p1", "own"]), projectOff, new Set(["p1", "p2", "own"]));
  assert.deepEqual(saved.offSkills, ["own"]);
  assert.deepEqual(saved.onSkills, ["p2"]);
  assert.deepEqual([...L.pristineLoadout(saved, projectOff)!.offSkills].sort(), ["own", "p1"], "it reads back as the card showed it");
  // The project then approves p1: the new chat follows; it disallows `own2`: that too.
  assert.deepEqual([...L.pristineLoadout(saved, ["p2", "own2"])!.offSkills].sort(), ["own", "own2"]);
});

test("a disallowed name the card doesn't list keeps the project's state whatever the card sends", () => {
  // The project disallows a subfolder's skill the card never lists; the card flips something else.
  const saved = L.flipsAgainstProject(entry(["own", "listed"]), ["sub-skill", "listed"], new Set(["own", "listed"]));
  assert.equal(saved.onSkills, undefined);
  const built = L.pristineLoadout(saved, ["sub-skill", "listed"])!;
  assert.deepEqual([...built.offSkills].sort(), ["listed", "own", "sub-skill"]);
  assert.ok(L.isSkillOff(L.loadoutStamp(built, ["sub-skill", "listed"]), "sub-skill"), "still off once the chat starts");
});

test("the first message's stamp reads the same before and after the message (every rule over the edges)", () => {
  const cases: Array<{ entry: import("./session-loadout").LoadoutEntryData | null; projectOff: string[] }> = [
    { entry: null, projectOff: [] },
    { entry: null, projectOff: ["p"] },
    { entry: entry(["own"]), projectOff: [] },
    { entry: entry(["own"], ["p"]), projectOff: ["p", "q"] },
    { entry: entry([], ["p", "q"]), projectOff: ["p", "q"] },
  ];
  for (const c of cases) {
    const built = L.pristineLoadout(c.entry, c.projectOff);
    const stamp = L.loadoutStamp(built, c.projectOff);
    const want = [...(built?.offSkills ?? [])].sort();
    assert.deepEqual([...stamp.offSkills].sort(), want, "after the message: its off list as is");
    assert.deepEqual([...(L.pristineLoadout(stamp, c.projectOff)?.offSkills ?? [])].sort(), want, "before: laid over the same project, the same list");
    assert.ok(L.normalizeLoadout(stamp), "a well-formed entry");
  }
});

test("a started chat's stamp never follows its project: a new disallow leaves it on", () => {
  const stamp = L.loadoutStamp(L.pristineLoadout(null, []), []);
  assert.equal(L.isSkillOff(stamp, "later"), false);
});

test("normalizeLoadout keeps onSkills, strictly", () => {
  assert.deepEqual(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], onSkills: ["a", "a"] }), { v: 1, offContext: [], offSkills: [], onSkills: ["a"] });
  assert.equal(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], onSkills: [""] }), null);
  assert.equal(L.sameLoadout(entry(["a", "b"]), entry(["b", "a"])), true);
  assert.equal(L.sameLoadout(entry(["a"], ["x"]), entry(["a"])), false);
});

test("a worker's skills override leaves out exactly its parent's off list", () => {
  const { skillsOverride } = L.skillsOffOverride(["off"]);
  const s = (name: string) => ({ name, filePath: `/s/${name}/SKILL.md` }) as never;
  assert.deepEqual(skillsOverride({ skills: [s("off"), s("on")], diagnostics: [] }).skills.map((k: { name: string }) => k.name), ["on"]);
});

// ---- workers ------------------------------------------------------------------------------------

test("a worker takes its parent's off list at its start, never a list the request carried", async () => {
  const seen: unknown[] = [];
  const host = { start: async (req: { spec: unknown }) => (seen.push(req.spec), { chatId: "c" }) } as never;
  let parentOff: string[] = ["pdf"];
  const stamped = skillsStamped(host, () => parentOff);
  const spec = { kind: "agent", parent: { sessionId: "s", path: "/p" }, offSkills: ["forged"] };
  await stamped.start({ key: "k1", spec, session: { new: { dir: "/d" } }, task: "go" } as never);
  assert.deepEqual((seen[0] as { offSkills?: string[] }).offSkills, ["pdf"]);
  parentOff = [];
  await stamped.start({ key: "k2", spec, session: { new: { dir: "/d" } }, task: "go" } as never);
  assert.equal((seen[1] as { offSkills?: string[] }).offSkills, undefined, "nothing off: no list, the forged one dropped");
});
