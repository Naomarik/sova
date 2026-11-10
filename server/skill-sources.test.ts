// Where skills come from and the text work on a skill file (§chat/skill-sources).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { argumentWords, claudeSkillPaths, expandedSkill, fillPlaceholders, homeClaudeSkillDirs, projectClaudeSkillDirs, quotedFrontMatter, skillBody, skillCommand } from "./skill-sources";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function tree(files: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-skill-src-")));
  roots.push(root);
  for (const p of files) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), "");
  }
  return root;
}

test("a project's Claude folders run from the chat's folder up to the repository's top, nearest first, and no further", () => {
  const r = tree(["above/.claude/skills/x/SKILL.md", "above/repo/.git/HEAD", "above/repo/.claude/skills/a/SKILL.md", "above/repo/svc/.claude/skills/b/SKILL.md", "above/repo/svc/deep/.keep"]);
  assert.deepEqual(projectClaudeSkillDirs(join(r, "above/repo/svc/deep"), join(r, "no-config")), [join(r, "above/repo/svc/.claude/skills"), join(r, "above/repo/.claude/skills")]);
});

test("the walk never takes the Claude config folder's own skills folder, even when the chat's folder sits below it", () => {
  const r = tree(["home/.claude/skills/synced/id/pdf/SKILL.md", "home/.claude/skills/mine/SKILL.md", "home/work/.claude/skills/w/SKILL.md", "home/work/sub/.keep"]);
  const claude = join(r, "home/.claude");
  const dirs = projectClaudeSkillDirs(join(r, "home/work/sub"), claude);
  assert.ok(dirs.includes(join(r, "home/work/.claude/skills")));
  assert.ok(!dirs.includes(join(claude, "skills")), `the config folder is a place the walk reached: ${dirs.join()}`);
});

test("the home folder gives each child holding its own SKILL.md: what Claude syncs below synced/, a hidden child and a loose file never count", () => {
  const r = tree([".claude/skills/synced/id/pdf/SKILL.md", ".claude/skills/.system/SKILL.md", ".claude/skills/mine/SKILL.md", ".claude/skills/loose.md", ".claude/skills/empty/notes.md", ".claude/skills/other/SKILL.md"]);
  assert.deepEqual(homeClaudeSkillDirs(join(r, ".claude")), [join(r, ".claude/skills/mine"), join(r, ".claude/skills/other")]);
  assert.deepEqual(homeClaudeSkillDirs(join(r, "nothing")), []);
});

test("the paths a chat adds are the project's, then the home folder's", () => {
  const r = tree([".git/HEAD", ".claude/skills/p/SKILL.md", "cfg/skills/h/SKILL.md"]);
  assert.deepEqual(claudeSkillPaths(r, join(r, "cfg")), [join(r, ".claude/skills"), join(r, "cfg/skills/h")]);
});

test("a risky plain value is quoted by Claude Code's rule; a quoted value, a block marker and a closed list stay", () => {
  const fixed = quotedFrontMatter(`---\nname: date-time\ndescription: Dates: parse and "format"\nargument-hint: [issue]\nother: 'a: b'\nlong: |\n  text: here\nwhen: >-\n  x\n---\nbody\n`);
  assert.equal(fixed, `---\nname: date-time\ndescription: "Dates: parse and \\"format\\""\nargument-hint: [issue]\nother: 'a: b'\nlong: |\n  text: here\nwhen: >-\n  x\n---\nbody\n`);
  assert.equal(quotedFrontMatter(`---\nname: x\ndescription: plain\n---\n`), null, "nothing risky: nothing to do");
  assert.equal(quotedFrontMatter(`no front matter: at all`), null);
});

test("a skill's body is what follows its front matter, even one YAML refuses", () => {
  assert.equal(skillBody(`---\ndescription: bad: colon\n---\n\n# Hello\n`), "# Hello");
  assert.equal(skillBody(`# No front matter\n`), "# No front matter");
  assert.equal(skillBody(`\uFEFF---\nname: x\n---\r\nBody\n`), "Body");
});

test("arguments split on white space with a quoted run as one word", () => {
  assert.deepEqual(argumentWords(`one "two words" 'three more' four`), ["one", "two words", "three more", "four"]);
  assert.deepEqual(argumentWords(""), []);
});

test("placeholders fill in: the whole text, a word from 0, a declared name, the skill's folder", () => {
  const f = fillPlaceholders("all=$ARGUMENTS first=$ARGUMENTS[0] second=$1 who=$issue dir=${CLAUDE_SKILL_DIR}", { args: `12 "b c"`, skillDir: "/s/x", names: ["issue"] });
  assert.equal(f.text, `all=12 "b c" first=12 second=b c who=12 dir=/s/x`);
  assert.equal(f.used, true);
});

test("a word no one typed stays as written: `awk $1` in an example isn't blanked, and an undeclared $word never fills", () => {
  const f = fillPlaceholders("awk '{print $1}' $issue", { args: "", skillDir: "/s" });
  assert.equal(f.text, "awk '{print $1}' $issue");
  assert.equal(f.used, false);
  assert.equal(fillPlaceholders("x$ARGUMENTS.", { args: "", skillDir: "/s" }).text, "x.", "$ARGUMENTS alone is empty with none");
});

test("a skill with no placeholder uses nothing, so the caller keeps the text after it", () => {
  const f = fillPlaceholders("Clojure transact! and $ things", { args: "go", skillDir: "/s" });
  assert.deepEqual(f, { text: "Clojure transact! and $ things", used: false });
});

test("a filled word isn't filled again, whatever it says", () => {
  assert.equal(fillPlaceholders("$0 $1", { args: "$1 two", skillDir: "/s" }).text, "$1 two");
  assert.equal(fillPlaceholders("$ARGUMENTS", { args: "${CLAUDE_SKILL_DIR} $0", skillDir: "/s" }).text, "${CLAUDE_SKILL_DIR} $0");
});

test("/skill: parses its name and text; anything else is no command", () => {
  assert.deepEqual(skillCommand("/skill:x  a b "), { name: "x", args: "a b" });
  assert.deepEqual(skillCommand("/skill:x"), { name: "x", args: "" });
  assert.equal(skillCommand("/skill:"), null);
  assert.equal(skillCommand("hello"), null);
});

test("an expansion is pi's form: a block and the text after it", () => {
  assert.equal(expandedSkill({ name: "x", filePath: "/s/x/SKILL.md", skillDir: "/s/x", body: "Do.", args: "go" }), `<skill name="x" location="/s/x/SKILL.md">\nReferences are relative to /s/x.\n\nDo.\n</skill>\n\ngo`);
});
