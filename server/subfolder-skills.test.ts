// A subfolder's skills: which offer themselves, the block, the branch's record, the walk (§chat/subfolder-skills).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { HEntry } from "../shared/harness";
import { loadedInstructions, markerBlock, markersIn } from "./deeper-context";
import { gitIgnores, isSubfolderSkillFile, listSubfolderSkills, nestedSkillFile, offeredDirs, offeredSkills, skillBlocksToAttach, skillsBlock, skillsOfFolder } from "./subfolder-skills";
import { piSkillsIn } from "./harness/pi/skill-sources";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const skill = (name: string, description = `${name} does things`, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-subskills-")));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}
const attach = (cwd: string, path: string, more: Partial<Parameters<typeof skillBlocksToAttach>[1]> = {}) =>
  skillBlocksToAttach(cwd, { path, read: piSkillsIn, offered: () => new Set(), inFlight: new Set(), ignored: new Map(), ...more });
let n = 0;
const result = (blocks: string[]): HEntry => ({ kind: "tool-result", id: `e${++n}`, parentId: null, tool: "read", blocks: blocks.map((text) => ({ type: "text", text })) }) as HEntry;

test("a touch offers each folder's skills on the way down, outermost first, Claude's and .agents' alike, with absolute locations", () => {
  const cwd = project({ "svc/.claude/skills/a/SKILL.md": skill("a"), "svc/deep/.agents/skills/b/SKILL.md": skill("b"), "svc/deep/x.ts": "" });
  const blocks = attach(cwd, "svc/deep/x.ts");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], skillsBlock("svc", [{ name: "a", description: "a does things", filePath: join(cwd, "svc/.claude/skills/a/SKILL.md") }]));
  assert.ok(blocks[1]!.startsWith(`<sova-skills dir="svc/deep">`));
  assert.ok(blocks[1]!.includes(`<location>${join(cwd, "svc/deep/.agents/skills/b/SKILL.md")}</location>`));
});

test("the chat's own folder, a file outside it, a hidden folder and a dependency folder offer nothing", () => {
  const cwd = project({ ".claude/skills/root/SKILL.md": skill("root"), "x.ts": "", ".hidden/.claude/skills/h/SKILL.md": skill("h"), ".hidden/y.ts": "", "node_modules/m/.claude/skills/d/SKILL.md": skill("d"), "node_modules/m/z.ts": "" });
  assert.deepEqual(attach(cwd, "x.ts"), [], "its own folder's skills were in the prompt from the start");
  assert.deepEqual(attach(cwd, "/somewhere/else.ts"), []);
  assert.deepEqual(attach(cwd, ".hidden/y.ts"), []);
  assert.deepEqual(attach(cwd, "node_modules/m/z.ts"), []);
});

test("a skills folder git ignores offers nothing; one git can't answer for counts", () => {
  const cwd = project({ ".gitignore": "ignored/\nsvc/.claude/\n", "ignored/.claude/skills/i/SKILL.md": skill("i"), "ignored/x.ts": "", "svc/.claude/skills/s/SKILL.md": skill("s"), "svc/x.ts": "", "ok/.claude/skills/o/SKILL.md": skill("o"), "ok/x.ts": "" });
  execFileSync("git", ["init", "-q"], { cwd });
  assert.deepEqual(attach(cwd, "ignored/x.ts"), []);
  assert.deepEqual(attach(cwd, "svc/x.ts"), [], "the .claude folder itself is ignored");
  assert.equal(attach(cwd, "ok/x.ts").length, 1);
  const noRepo = project({ "a/.claude/skills/n/SKILL.md": skill("n"), "a/x.ts": "" });
  assert.equal(gitIgnores(join(noRepo, "a/.claude/skills")), false);
});

test("a submodule's skills count: git answers from the nearest repository", () => {
  const cwd = project({ "a.txt": "", "sub/.claude/skills/s/SKILL.md": skill("s"), "sub/x.ts": "", "sub/f.txt": "" });
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["init", "-q"], { cwd: join(cwd, "sub") });
  assert.equal(attach(cwd, "sub/x.ts").length, 1);
});

test("git is asked once per skills folder, for a chat", () => {
  const cwd = project({ "svc/.claude/skills/s/SKILL.md": skill("s"), "svc/x.ts": "" });
  const ignored = new Map<string, boolean>();
  attach(cwd, "svc/x.ts", { ignored });
  assert.deepEqual([...ignored.keys()], [join(cwd, "svc/.claude/skills")]);
  ignored.set(join(cwd, "svc/.claude/skills"), true);
  assert.deepEqual(attach(cwd, "svc/x.ts", { ignored }), [], "the kept answer is the one used");
});

test("in one folder .agents comes first and the first of one name is offered", () => {
  const cwd = project({ "svc/.claude/skills/same/SKILL.md": skill("same", "the claude one"), "svc/.agents/skills/same/SKILL.md": skill("same", "the agents one"), "svc/.claude/skills/other/SKILL.md": skill("other"), "svc/x.ts": "" });
  const [block] = attach(cwd, "svc/x.ts");
  assert.ok(block!.includes("the agents one"));
  assert.ok(!block!.includes("the claude one"));
  assert.ok(block!.includes("<name>other</name>"));
});

test("a manual-only skill isn't in the block, and a folder of only those attaches none", () => {
  const cwd = project({ "svc/.claude/skills/m/SKILL.md": skill("m", "manual", "disable-model-invocation: true\n"), "svc/x.ts": "", "mix/.claude/skills/m/SKILL.md": skill("m", "manual", "disable-model-invocation: true\n"), "mix/.claude/skills/o/SKILL.md": skill("o"), "mix/x.ts": "" });
  assert.deepEqual(attach(cwd, "svc/x.ts"), []);
  const [block] = attach(cwd, "mix/x.ts");
  assert.ok(block!.includes("<name>o</name>"));
  assert.ok(!block!.includes("<name>m</name>"));
});

test("a rescued skill is offered; one with no description isn't", () => {
  const cwd = project({ "svc/.claude/skills/colon/SKILL.md": skill("colon", "Dates: parse and format"), "svc/.claude/skills/bare/SKILL.md": "---\nname: bare\n---\nbody\n", "svc/x.ts": "" });
  const [block] = attach(cwd, "svc/x.ts");
  assert.ok(block!.includes("Dates: parse and format"));
  assert.ok(!block!.includes("<name>bare</name>"));
});

test("a file the starting list has, a name switched off and a file the chat may not see aren't offered", () => {
  const cwd = project({ "svc/.claude/skills/a/SKILL.md": skill("a"), "svc/.claude/skills/b/SKILL.md": skill("b"), "svc/.claude/skills/c/SKILL.md": skill("c"), "svc/.claude/skills/d/SKILL.md": skill("d"), "svc/x.ts": "" });
  const [block] = attach(cwd, "svc/x.ts", { startingFile: (f) => f.endsWith("/a/SKILL.md"), off: (s) => s.name === "b", allow: (f) => !f.endsWith("/c/SKILL.md") });
  assert.deepEqual([...block!.matchAll(/<name>(\w+)<\/name>/g)].map((m) => m[1]), ["d"]);
});

test("a folder offered on the branch or earlier this turn attaches once", () => {
  const cwd = project({ "svc/.claude/skills/a/SKILL.md": skill("a"), "svc/x.ts": "" });
  assert.deepEqual(attach(cwd, "svc/x.ts", { offered: () => new Set(["svc"]) }), []);
  const inFlight = new Set<string>();
  assert.equal(attach(cwd, "svc/x.ts", { inFlight }).length, 1);
  assert.deepEqual(attach(cwd, "svc/x.ts", { inFlight }), []);
});

test("a block reads back: names, descriptions and locations survive escaping, and only trailing blocks count", () => {
  const offer = skillsBlock("svc", [{ name: "a", description: `x < y & "z": it's`, filePath: "/p/svc/.claude/skills/a/SKILL.md" }]);
  const branch: HEntry[] = [result([offer, "own output"]), result(["own output", offer])];
  assert.deepEqual(offeredSkills(branch), [{ name: "a", description: `x < y & "z": it's`, filePath: "/p/svc/.claude/skills/a/SKILL.md", dir: "svc" }], "a tool's own output that holds the text can't pass for a block");
  assert.deepEqual([...offeredDirs(branch)], ["svc"]);
});

test("TRAP: an instruction block before a skills block stays counted, and the other way round", () => {
  const ins = markerBlock("svc/AGENTS.md", "rules");
  const off = skillsBlock("svc", [{ name: "a", description: "d", filePath: "/f" }]);
  const out = "output";
  for (const blocks of [[out, ins, off], [out, off, ins]]) {
    const typed = blocks.map((text) => ({ type: "text", text }));
    assert.deepEqual(markersIn(typed), ["svc/AGENTS.md"], `the marker walk stepped over: ${blocks.map((b) => b.slice(0, 12))}`);
    assert.deepEqual([...loadedInstructions([result(blocks)])], ["svc/AGENTS.md"]);
    assert.deepEqual([...offeredDirs([result(blocks)])], ["svc"]);
  }
  assert.deepEqual(markersIn([{ type: "text", text: out }, { type: "text", text: ins }, { type: "text", text: "plain" }]), [], "any other trailing block still ends the walk");
});

test("a compaction forgets what it dropped, and keeps what it kept", () => {
  const off = skillsBlock("svc", [{ name: "a", description: "d", filePath: "/f" }]);
  const entry = result(["o", off]);
  const compaction = (kept?: string): HEntry => ({ kind: "compaction", id: `c${++n}`, parentId: null, summary: "s", ...(kept ? { firstKeptEntryId: kept } : {}) }) as HEntry;
  assert.deepEqual([...offeredDirs([entry, compaction()])], []);
  assert.deepEqual([...offeredDirs([entry, compaction(entry.id!)])], ["svc"]);
});

test("the walk lists every folder's skills outermost first, manual-only too, skipping hidden, dependency and ignored folders", () => {
  const cwd = project({ ".gitignore": "gone/\n", ".claude/skills/root/SKILL.md": skill("root"), "b/deep/.claude/skills/d/SKILL.md": skill("d"), "a/.agents/skills/m/SKILL.md": skill("m", "manual", "disable-model-invocation: true\n"), ".hidden/.claude/skills/h/SKILL.md": skill("h"), "node_modules/x/.claude/skills/n/SKILL.md": skill("n"), "gone/.claude/skills/g/SKILL.md": skill("g") });
  execFileSync("git", ["init", "-q"], { cwd });
  const { skills, incomplete } = listSubfolderSkills(cwd, piSkillsIn);
  assert.deepEqual(skills.map((s) => [s.dir, s.name, s.manualOnly]), [["a", "m", true], ["b/deep", "d", false]]);
  assert.equal(incomplete, false);
});

test("the walk says so when it stops at its cap", () => {
  const cwd = project({ "a/x": "", "b/x": "", "c/x": "" });
  assert.equal(listSubfolderSkills(cwd, piSkillsIn, { cap: 1 }).incomplete, true);
});

test("/skill: for a name with no starting skill finds the one offered earliest, else the outermost", () => {
  const cwd = project({ "a/.claude/skills/same/SKILL.md": skill("same"), "b/.claude/skills/same/SKILL.md": skill("same"), "c/deep/.claude/skills/only/SKILL.md": skill("only") });
  const bFile = join(cwd, "b/.claude/skills/same/SKILL.md");
  assert.equal(nestedSkillFile(cwd, "same", [result(["o", skillsBlock("b", [{ name: "same", description: "d", filePath: bFile }])])], piSkillsIn), bFile);
  assert.equal(nestedSkillFile(cwd, "same", [], piSkillsIn), join(cwd, "a/.claude/skills/same/SKILL.md"));
  assert.equal(nestedSkillFile(cwd, "only", [], piSkillsIn), join(cwd, "c/deep/.claude/skills/only/SKILL.md"));
  assert.equal(nestedSkillFile(cwd, "nope", [], piSkillsIn), null);
});

test("only a skill a folder below the chat's lists may open from the tab", () => {
  const cwd = project({ ".claude/skills/root/SKILL.md": skill("root"), "a/.claude/skills/s/SKILL.md": skill("s"), "a/.claude/skills/s/notes.md": "secret-ish", "a/.claude/other.md": "x", "b/.env.md": "x" });
  assert.equal(isSubfolderSkillFile(cwd, join(cwd, "a/.claude/skills/s/SKILL.md"), piSkillsIn), true);
  for (const p of ["a/.claude/skills/s/notes.md", "a/.claude/other.md", "b/.env.md", ".claude/skills/root/SKILL.md"]) assert.equal(isSubfolderSkillFile(cwd, join(cwd, p), piSkillsIn), false, p);
  assert.equal(isSubfolderSkillFile(cwd, "/etc/.claude/skills/s/SKILL.md", piSkillsIn), false);
});

test("skillsOfFolder takes an answer from git as given", () => {
  const cwd = project({ ".claude/skills/a/SKILL.md": skill("a"), ".agents/skills/b/SKILL.md": skill("b") });
  assert.deepEqual(skillsOfFolder(cwd, piSkillsIn, (p) => p.includes(".agents")).map((s) => s.name), ["a"]);
});
