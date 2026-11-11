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

beforeEach(() => rmSync(store.projectSkillsPath(), { force: true }));

// The store, the scan, the views and the routes: server/approvals.test.ts.

// ---- a chat's entry against its folder's decisions --------------------------------------------

type Entry = import("./session-loadout").LoadoutEntryData;
type Rule = import("../shared/folder-rule").FolderRule;
const entry = (offSkills: string[], onSkills?: string[], more: Partial<Entry> = {}): Entry => ({ v: 1, offContext: [], offSkills, ...(onSkills ? { onSkills } : {}), ...more });
const rule = (asking: boolean, r: { ctx?: [string[], string[]]; sk?: [string[], string[]] } = {}): Rule => ({
  asking,
  context: { approved: r.ctx?.[0] ?? [], disallowed: r.ctx?.[1] ?? [] },
  skills: { approved: r.sk?.[0] ?? [], disallowed: r.sk?.[1] ?? [] },
});
const sk = (name: string) => ({ name, filePath: `/p/.agents/skills/${name}/SKILL.md` });
const ctx = (n: string) => `/p/${n}/AGENTS.md`;

test("isSkillOff and isContextOff: no entry is every item on", () => {
  assert.equal(L.isSkillOff(null, sk("a")), false);
  assert.equal(L.isContextOff(null, ctx("a")), false);
});

/**
 * The rule a pristine chat builds by, over every state an item can be in for its folder (approved,
 * disallowed, waiting) × the chat's own flip (none, on, off) × the mode: a flip of the chat's own wins;
 * else default mode loads all but disallowed, asking loads only approved.
 */
test("before the first message: every folder state × chat flip × mode, for skills and context files alike", () => {
  const states = ["approved", "disallowed", "waiting"] as const;
  const flips = ["none", "on", "off"] as const;
  for (const asking of [false, true]) {
    for (const st of states) {
      for (const flip of flips) {
        const s = sk("x");
        const c = ctx("x");
        const r = rule(asking, { ctx: [st === "approved" ? [c] : [], st === "disallowed" ? [c] : []], sk: [st === "approved" ? [s.filePath] : [], st === "disallowed" ? [s.filePath] : []] });
        const own = flip === "none" ? null : flip === "on" ? entry([], [s.filePath], { onContext: [c] }) : entry([s.filePath], undefined, { offContext: [c] });
        const want = flip === "on" ? false : flip === "off" ? true : asking ? st !== "approved" : st === "disallowed";
        const built = L.pristineLoadout(own, r);
        const at = `asking=${asking} state=${st} flip=${flip}`;
        assert.equal(L.isSkillOff(built, s), want, `skill ${at}`);
        assert.equal(L.isContextOff(built, c), want, `context ${at}`);
        // The stamp at the first message reads the same (the item exists), and is a well-formed entry.
        const stamp = L.loadoutStamp(built, [s], () => true);
        assert.equal(L.isSkillOff(stamp, s), want, `stamped skill ${at}`);
        assert.equal(L.isContextOff(stamp, c), want, `stamped context ${at}`);
        assert.ok(L.normalizeLoadout(stamp), `well-formed ${at}`);
        assert.deepEqual(L.normalizeLoadout(JSON.parse(JSON.stringify(stamp))), L.normalizeLoadout(stamp));
      }
    }
  }
});

test("default mode with nothing decided and no flips builds exactly as before this feature (no entry, no overrides)", () => {
  assert.equal(L.pristineLoadout(null, rule(false)), null);
  assert.equal(L.loadoutOverrides({ data: L.pristineLoadout(null, rule(false)) }), undefined);
  assert.equal(L.pristineLoadout(null, null), null);
});

test("asking: the stamp's allowlist is exact: the chat's flips folded in and dropped, and only what exists now stays", () => {
  const a = sk("a");
  const later = sk("later");
  const built = L.pristineLoadout(entry([], [a.filePath], { onContext: [ctx("mine")] }), rule(true, { ctx: [[ctx("gone"), ctx("here")], []], sk: [[later.filePath], []] }))!;
  const stamp = L.loadoutStamp(built, [a], (p) => p !== ctx("gone") && p !== later.filePath);
  assert.equal(stamp.asking, true);
  assert.deepEqual(stamp.onlySkills, [a.filePath]);
  assert.deepEqual([...stamp.onlyContext!].sort(), [ctx("here"), ctx("mine")]);
  assert.equal(stamp.onSkills, undefined);
  assert.equal(stamp.onContext, undefined);
  assert.equal(L.isSkillOff(stamp, later), true, "an approved skill that appears after the first message stays off");
  assert.equal(L.isContextOff(stamp, ctx("gone")), true);
  assert.equal(L.isContextOff(stamp, ctx("new")), true, "anything appearing later stays off");
});

test("a skill matches by its file, so one of the same name from another place is a separate item, a chat's flip included", () => {
  const mine = { name: "pdf", filePath: "/home/u/.pi/agent/skills/pdf/SKILL.md" };
  const theirs = { name: "pdf", filePath: "/p/.agents/skills/pdf/SKILL.md" };
  const later = { name: "pdf", filePath: "/p/sub/.agents/skills/pdf/SKILL.md" };
  for (const asking of [false, true]) {
    // Both are kept off by the folder (waiting while asking, disallowed otherwise); the chat flips the project's on.
    const r = rule(asking, { sk: [[], asking ? [] : [mine.filePath, theirs.filePath, later.filePath]] });
    const built = L.pristineLoadout(entry([], [theirs.filePath]), r);
    assert.equal(L.isSkillOff(built, theirs), false, `asking=${asking}: the one switched on`);
    assert.equal(L.isSkillOff(built, mine), true, `asking=${asking}: the other of that name stays off`);
    const stamp = L.loadoutStamp(built, [mine, theirs]);
    assert.equal(L.isSkillOff(stamp, theirs), false);
    assert.equal(L.isSkillOff(stamp, mine), true, `asking=${asking}: after the first message too`);
    assert.equal(L.isSkillOff(stamp, later), true, `asking=${asking}: and one of that name appearing later`);
  }
});

test("a started chat's stamp never follows its folder: a later decision moves nothing", () => {
  const def = L.loadoutStamp(L.pristineLoadout(null, rule(false, { sk: [[], [sk("d").filePath]] })), []);
  assert.equal(L.isSkillOff(def, sk("later")), false, "default mode: a skill disallowed later stays on in a started chat");
  assert.equal(L.isSkillOff(def, sk("d")), true);
  const ask = L.loadoutStamp(L.pristineLoadout(null, rule(true)), []);
  assert.equal(L.isContextOff(ask, ctx("x")), true, "asking: one approved later stays off in a started chat");
  // A chat from before this feature (no marker) keeps reading its off lists alone.
  assert.equal(L.isContextOff(entry(["a"]), ctx("x")), false);
});

test("a card's whole off set keeps only its flips against the folder, so a later decision still reaches the new chat", () => {
  const [p1, p2, own] = ["p1", "p2", "own"].map((n) => sk(n).filePath);
  const kept = { context: [ctx("w")], skills: [p1!, p2!] };
  const listed = { context: new Set([ctx("w"), ctx("own")]), skills: new Set([p1!, p2!, own!]) };
  // The card shows p1 off (the folder's), p2 switched on, own off; context: w switched on, own off.
  const saved = L.flipsAgainstProject(entry([p1!, own!], undefined, { offContext: [ctx("own")] }), kept, listed);
  assert.deepEqual(saved.offSkills, [own]);
  assert.deepEqual(saved.onSkills, [p2]);
  assert.deepEqual(saved.offContext, [ctx("own")]);
  assert.deepEqual(saved.onContext, [ctx("w")]);
  // A disallowed name the card doesn't list keeps the folder's state whatever the card sends.
  const unlisted = L.flipsAgainstProject(entry([]), { context: [], skills: ["sub-skill"] }, { context: new Set(), skills: new Set() });
  assert.equal(unlisted.onSkills, undefined);
});

test("normalizeLoadout keeps the new fields strictly: an allowlist only with the asking marker, context paths absolute", () => {
  assert.deepEqual(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], onSkills: ["a", "a"] }), { v: 1, offContext: [], offSkills: [], onSkills: ["a"] });
  assert.equal(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], onSkills: [""] }), null);
  assert.equal(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], onlyContext: ["/a"] }), null, "an allowlist without the marker");
  assert.equal(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], asking: true, onlyContext: ["rel"] }), null);
  assert.equal(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], asking: false }), null);
  assert.deepEqual(L.normalizeLoadout({ v: 1, offContext: [], offSkills: [], asking: true }), { v: 1, offContext: [], offSkills: [], asking: true, onlyContext: [], onlySkills: [] });
  assert.equal(L.sameLoadout(entry(["a", "b"]), entry(["b", "a"])), true);
  assert.equal(L.sameLoadout(entry(["a"], ["x"]), entry(["a"])), false);
  assert.equal(L.sameLoadout(entry([], undefined, { asking: true, onlyContext: [], onlySkills: [] }), entry([])), false);
});

test("a worker's overrides apply exactly its parent's entry, context files included", () => {
  const parent = L.loadoutStamp(L.pristineLoadout(null, rule(true, { ctx: [[ctx("ok")], []], sk: [[sk("on").filePath], []] })), []);
  const o = L.entryOverrides(parent);
  assert.deepEqual(o.skillsOverride({ skills: [sk("off"), sk("on")] as never, diagnostics: [] }).skills.map((k: { name: string }) => k.name), ["on"]);
  assert.deepEqual(o.agentsFilesOverride({ agentsFiles: [{ path: ctx("ok"), content: "" }, { path: ctx("no"), content: "" }] }).agentsFiles.map((f) => f.path), [ctx("ok")]);
  const { skillsOverride } = L.skillsOffOverride(["off"]);
  assert.deepEqual(skillsOverride({ skills: [sk("off"), sk("on")] as never, diagnostics: [] }).skills.map((k: { name: string }) => k.name), ["on"], "an older parent's list by name");
});

// ---- workers ------------------------------------------------------------------------------------

test("a worker takes its parent's fixed entry and mode at its start, never one the request carried", async () => {
  const seen: Array<{ offSkills?: string[]; loadout?: unknown }> = [];
  const host = { start: async (req: { spec: unknown }) => (seen.push(req.spec as never), { chatId: "c" }) } as never;
  let parent: Entry | null = entry(["pdf", "/p/x/SKILL.md"], undefined, { asking: true, onlyContext: ["/p/AGENTS.md"], onlySkills: [] });
  const stamped = skillsStamped(host, () => parent);
  const spec = { kind: "agent", parent: { sessionId: "s", path: "/p" }, offSkills: ["forged"], loadout: { v: 1, offContext: [], offSkills: [] } };
  await stamped.start({ key: "k1", spec, session: { new: { dir: "/d" } }, task: "go" } as never);
  assert.deepEqual(seen[0]!.offSkills, ["pdf"], "the older field: names only");
  assert.deepEqual(seen[0]!.loadout, parent);
  const { workerLoadout } = await import("./chat-manager");
  assert.deepEqual(workerLoadout(seen[0] as never), parent);
  parent = null;
  await stamped.start({ key: "k2", spec, session: { new: { dir: "/d" } }, task: "go" } as never);
  assert.equal(seen[1]!.offSkills, undefined, "nothing off: no list, the forged one dropped");
  assert.equal(seen[1]!.loadout, undefined);
  assert.equal(workerLoadout(seen[1] as never), null);
});
