// The Claude skill folders on pi's loader, rescue and what didn't load (§chat/skill-sources). Real pi loader,
// throwaway folders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { folderResources, resourcesOf } from "./resources";
import { piCanExpand, piSkillsIn, rescuedSkill, skillArgumentNames, withSkillSources } from "./skill-sources";
import { loadoutOverrides } from "../../session-loadout";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const skill = (name: string, description = `${name} does things`, extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody.\n`;
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-skills-")));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}
/** pi's loader in `cwd`, under a home and agent dir of `root`'s own (so nothing of the host's counts). */
async function loaded(root: string, cwd: string, options: Record<string, unknown> = {}) {
  const was = { HOME: process.env.HOME, CLAUDE: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "home/.claude");
  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(root, "agent"), noExtensions: true, ...withSkillSources(cwd, options) } as never);
    await loader.reload();
    return loader;
  } finally {
    process.env.HOME = was.HOME;
    if (was.CLAUDE === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was.CLAUDE;
  }
}
const namesOf = (l: { getSkills(): { skills: { name: string }[] } }) => l.getSkills().skills.map((s) => s.name).sort();

test("TRAP: a chat that loads no skills gets no Claude folder: pi would load additional paths even then", async () => {
  const root = tree({ "p/.git/HEAD": "", "p/.claude/skills/a/SKILL.md": skill("a"), "home/.claude/skills/h/SKILL.md": skill("h") });
  const off = await loaded(root, join(root, "p"), { noSkills: true });
  assert.deepEqual(namesOf(off), []);
  const options = { noSkills: true } as const;
  assert.equal(withSkillSources(join(root, "p"), options), options, "untouched");
  const on = await loaded(root, join(root, "p"));
  assert.deepEqual(namesOf(on), ["a", "h"], "the control: they load without it, so the absence above means something");
});

test("what Claude syncs below synced/ and a hidden child aren't offered, wherever the chat's folder sits", async () => {
  const root = tree({ "home/.claude/skills/synced/id/pdf/SKILL.md": skill("pdf"), "home/.claude/skills/.system/SKILL.md": skill("system"), "home/.claude/skills/mine/SKILL.md": skill("mine"), "home/work/x": "" });
  assert.deepEqual(namesOf(await loaded(root, join(root, "home/work"))), ["mine"], "a folder below home, no repository: the walk reaches the config folder and leaves it");
  assert.deepEqual(namesOf(await loaded(root, join(root, "home"))), ["mine"], "the home folder itself");
});

test("precedence: .agents beats the Claude folder of one name, the loser is named, and the same file twice names nothing", async () => {
  const root = tree({ "p/.git/HEAD": "", "p/.agents/skills/same/SKILL.md": skill("same", "agents"), "p/.claude/skills/same/SKILL.md": skill("same", "claude"), "p/.claude/skills/other/SKILL.md": skill("other") });
  const cwd = join(root, "p");
  const res = resourcesOf(await loaded(root, cwd, { additionalSkillPaths: [join(cwd, ".claude/skills")] }));
  assert.deepEqual(res.skills.map((s) => [s.name, s.description]).sort(), [["other", "other does things"], ["same", "agents"]]);
  assert.deepEqual(res.skillProblems, [{ name: "same", path: join(cwd, ".claude/skills/same/SKILL.md"), reason: "same-name", winnerPath: join(cwd, ".agents/skills/same/SKILL.md") }]);
});

test("rescue: an unquoted colon loads; no description and a broken file are named; a chat with neither has no problems", async () => {
  const root = tree({
    "p/.git/HEAD": "",
    "p/.claude/skills/colon/SKILL.md": skill("colon", "Dates: parse and format"),
    "p/.claude/skills/bare/SKILL.md": "---\nname: bare\n---\nbody\n",
    "p/.claude/skills/broken/SKILL.md": "---\nname: broken\n  bad: [indent\ndescription: x\n---\nbody\n",
    "q/.git/HEAD": "",
    "q/.claude/skills/fine/SKILL.md": skill("fine"),
  });
  const res = resourcesOf(await loaded(root, join(root, "p")));
  assert.deepEqual(res.skills.map((s) => [s.name, s.description]), [["colon", "Dates: parse and format"]]);
  assert.deepEqual(res.skillProblems?.map((p) => [p.name, p.reason]).sort(), [["bare", "no-description"], ["broken", "front-matter"]]);
  assert.equal(resourcesOf(await loaded(root, join(root, "q"))).skillProblems, undefined);
});

test("a rescued skill loses to one of its name, named as such; a warning about one that still loaded names nothing", async () => {
  const root = tree({ "p/.git/HEAD": "", "p/.agents/skills/dup/SKILL.md": skill("dup"), "p/.claude/skills/dup/SKILL.md": skill("dup", "Bad: value"), "p/.claude/skills/Upper/SKILL.md": skill("Upper") });
  const res = resourcesOf(await loaded(root, join(root, "p")));
  assert.deepEqual(res.skills.map((s) => s.name).sort(), ["Upper", "dup"]);
  assert.deepEqual(res.skillProblems?.map((p) => [p.name, p.reason]), [["dup", "same-name"]]);
});

test("rescue composes with a loadout's override: its base list holds the rescued skill, and its off set applies", async () => {
  const root = tree({ "p/.git/HEAD": "", "p/.claude/skills/colon/SKILL.md": skill("colon", "A: b"), "p/.claude/skills/other/SKILL.md": skill("other"), "p/.claude/skills/m/SKILL.md": skill("m", "manual", "disable-model-invocation: true\n") });
  const state = { data: { v: 1 as const, offContext: [], offSkills: ["colon"] } };
  const overrides = loadoutOverrides(state as never)!;
  const l = await loaded(root, join(root, "p"), overrides);
  assert.deepEqual(namesOf(l), ["m", "other"]);
  assert.deepEqual((state as unknown as { baseSkills: { name: string; manualOnly?: boolean }[] }).baseSkills.map((s) => [s.name, s.manualOnly]).sort(), [["colon", undefined], ["m", true], ["other", undefined]]);
});

test("manual-only is said; a skill that isn't says nothing", async () => {
  const root = tree({ "p/.git/HEAD": "", "p/.claude/skills/m/SKILL.md": skill("m", "manual", "disable-model-invocation: true\n"), "p/.claude/skills/o/SKILL.md": skill("o") });
  const res = resourcesOf(await loaded(root, join(root, "p")));
  assert.deepEqual(res.skills.find((s) => s.name === "m")?.manualOnly, true);
  assert.equal("manualOnly" in res.skills.find((s) => s.name === "o")!, false);
});

test("the card's list for a folder no chat holds comes from the same locations", async () => {
  const root = tree({ "p/.git/HEAD": "", "p/.claude/skills/a/SKILL.md": skill("a"), "agent/x": "" });
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "nothing");
  try {
    const res = await folderResources(join(root, "p"), join(root, "agent"));
    assert.ok(res.skills.some((s) => s.name === "a"));
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
  }
});

test("one skills folder by pi's rules, rescue included", () => {
  const root = tree({ "s/a/SKILL.md": skill("a"), "s/colon/SKILL.md": skill("colon", "X: y"), "s/m/SKILL.md": skill("m", "manual", "disable-model-invocation: true\n"), "s/bare/SKILL.md": "---\nname: bare\n---\nb\n" });
  assert.deepEqual(piSkillsIn(join(root, "s")).map((s) => [s.name, s.description, s.manualOnly]).sort(), [["a", "a does things", false], ["colon", "X: y", false], ["m", "manual", true]]);
});

test("a rescued skill keeps its name, folder and manual-only; rescue is only for what YAML refused", () => {
  const root = tree({ "a/SKILL.md": "---\ndescription: Bad: yaml\ndisable-model-invocation: true\n---\nb\n", "b/SKILL.md": skill("b") });
  const s = rescuedSkill(join(root, "a/SKILL.md"))!;
  assert.deepEqual([s.name, s.description, s.baseDir, s.disableModelInvocation, s.sourceInfo.path], ["a", "Bad: yaml", join(root, "a"), true, join(root, "a/SKILL.md")]);
  assert.equal(rescuedSkill(join(root, "b/SKILL.md")), null);
  assert.equal(rescuedSkill(join(root, "gone/SKILL.md")), null);
});

test("declared argument names, as a list or as words, rescue included; none otherwise", () => {
  assert.deepEqual(skillArgumentNames("---\narguments: [issue, branch]\n---\n"), ["issue", "branch"]);
  assert.deepEqual(skillArgumentNames("---\narguments: issue branch\n---\n"), ["issue", "branch"]);
  assert.deepEqual(skillArgumentNames("---\ndescription: bad: yaml\narguments: [x]\n---\n"), ["x"]);
  assert.deepEqual(skillArgumentNames("---\ndescription: ok\n---\n"), []);
  assert.equal(piCanExpand("---\ndescription: ok\n---\n"), true);
  assert.equal(piCanExpand("---\ndescription: bad: yaml\n---\n"), false);
});
