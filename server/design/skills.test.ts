// Run: pnpm test server/design/skills.test.ts. A Lookbook run's design skills: which folders it uses, and the designers'
// read-only skill reader (realpath containment, no .., no absolute path, text only, a size cap).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const base = mkdtempSync(join(tmpdir(), "sova-design-skills-"));
process.env.PI_CODING_AGENT_DIR ??= join(base, "agent");
const { coordinatorSkillsBlock, designerSkillsBlock, listSkillFiles, readSkillFile, runSkills, SKILL_LIMITS, skillReadTokens, SkillReadRefused } = await import("./skills");
after(() => rmSync(base, { recursive: true, force: true }));

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nUse --brand: #123456.\n`;

// A project with one skill, a secret beside it, and links that try to leave.
const project = join(base, "project");
const brand = join(project, ".agents", "skills", "brand");
mkdirSync(join(brand, "tokens"), { recursive: true });
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(brand, "SKILL.md"), skillMd("brand", "The house look."));
writeFileSync(join(brand, "tokens", "colors.css"), ":root { --brand: #123456; }");
writeFileSync(join(brand, "logo.png"), "not text");
writeFileSync(join(brand, "big.md"), "x".repeat(SKILL_LIMITS.readBytes + 1));
const secret = join(base, "secret.md");
writeFileSync(secret, "TOP SECRET");
symlinkSync(secret, join(brand, "escape.md"));
symlinkSync(base, join(brand, "up"));
symlinkSync(join(brand, "tokens", "colors.css"), join(brand, "alias.css"));
const roots = [{ name: "brand", dir: brand }];

test("the reader opens a text file inside the skill, and one a symlink points to inside it", () => {
  const f = readSkillFile(roots, "brand", "tokens/colors.css");
  assert.equal(f.text, ":root { --brand: #123456; }");
  assert.match(readSkillFile(roots, "brand", "SKILL.md").text, /--brand/);
  assert.equal(readSkillFile(roots, "brand", "alias.css").text, ":root { --brand: #123456; }");
});

test("the reader refuses a symlink that escapes the skill's folder, by its real path", () => {
  assert.throws(() => readSkillFile(roots, "brand", "escape.md"), (e: unknown) => e instanceof SkillReadRefused && /outside/.test(e.message));
  assert.throws(() => readSkillFile(roots, "brand", "up/secret.md"), (e: unknown) => e instanceof SkillReadRefused && /outside/.test(e.message));
});

test("the reader refuses .. and absolute paths, whatever they would reach", () => {
  for (const p of ["../../../secret.md", "tokens/../../../../secret.md", "..\\secret.md"]) assert.throws(() => readSkillFile(roots, "brand", p), (e: unknown) => e instanceof SkillReadRefused && /\.\./.test(e.message), p);
  for (const p of [secret, join(brand, "SKILL.md"), "~/secret.md"]) assert.throws(() => readSkillFile(roots, "brand", p), (e: unknown) => e instanceof SkillReadRefused && /absolute/.test(e.message), p);
});

test("the reader opens text types only, within its size cap, and only the design's own skills", () => {
  assert.throws(() => readSkillFile(roots, "brand", "logo.png"), /isn't a text file/);
  assert.throws(() => readSkillFile(roots, "brand", "big.md"), /over the/);
  assert.throws(() => readSkillFile(roots, "brand", "nope.md"), /has no file/);
  assert.throws(() => readSkillFile(roots, "other", "SKILL.md"), /No skill "other"/);
  assert.throws(() => readSkillFile([], "brand", "SKILL.md"), /No skill/);
});

test("a listing shows the skill's files and leaves out what leads outside it", () => {
  const l = listSkillFiles(roots, "brand");
  const paths = l.files.map((f) => f.path);
  assert.ok(paths.includes("SKILL.md") && paths.includes("tokens/colors.css") && paths.includes("alias.css"));
  assert.ok(!paths.includes("escape.md") && !paths.some((p) => p.startsWith("up")), paths.join(","));
  assert.equal(l.files.find((f) => f.path === "logo.png")?.text, false);
});

test("a run's skills are only the ones named: none by itself, a path, a project skill by its name; one not found is missing, not guessed", async () => {
  const named = join(base, "elsewhere", "house-style");
  mkdirSync(named, { recursive: true });
  writeFileSync(join(named, "SKILL.md"), skillMd("house-style", "Another look."));
  const empty = join(base, "empty");
  mkdirSync(empty, { recursive: true });
  const personal = join(base, "agent", "skills", "personal");
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, "SKILL.md"), skillMd("personal", "Mine."));
  let listed = 0;
  const lister = { all: async () => (listed++, [{ name: "personal", description: "Mine.", filePath: join(personal, "SKILL.md") }, { name: "brand", description: "The house look.", filePath: join(brand, "SKILL.md") }]) };
  // Nothing named: nothing at all, the project's own skill included, and the folder isn't even listed.
  assert.deepEqual(await runSkills(project, [], lister), { skills: [], missing: [] });
  assert.equal(listed, 0);
  // A path by itself needs no listing.
  const byPath = await runSkills(project, [named], lister);
  assert.deepEqual(byPath.skills.map((s) => [s.name, s.from, s.description]), [["house-style", "named", "Another look."]]);
  assert.equal(listed, 0);
  const r = await runSkills(project, ["brand", named, empty, join(base, "nowhere"), "personal", "unknown-skill", `${named}/SKILL.md`], lister);
  assert.deepEqual(r.skills.map((s) => [s.name, s.from]), [["brand", "project"], ["house-style", "named"], ["personal", "named"]]);
  assert.equal(r.skills[0]!.dir, brand);
  assert.deepEqual(r.missing.map((m) => m.asked), [empty, join(base, "nowhere"), "unknown-skill"]);
  assert.match(r.missing[0]!.reason, /no SKILL\.md/);
});

test("the sessions' words name the reader and the skills, and the estimate counts reading them", () => {
  const block = designerSkillsBlock([{ name: "brand", description: "The house look." }]);
  assert.match(block, /design_skill/);
  assert.match(block, /- brand: The house look\./);
  assert.match(block, /sealed/);
  assert.equal(designerSkillsBlock([]), "");
  const c = coordinatorSkillsBlock([{ name: "brand", description: "d", dir: brand, from: "project" }], [{ asked: "~/gone", reason: "There is no such folder." }]);
  assert.ok(c.includes(join(brand, "SKILL.md")));
  assert.match(c, /design_brief's skills/);
  assert.match(c, /exact paths inside the skill that you read/);
  assert.match(c, /~\/gone: There is no such folder\.[\s\S]*question on the brief/);
  assert.equal(skillReadTokens(undefined), 0);
  assert.ok(skillReadTokens([{ dir: brand }]) > 1000);
  assert.ok(skillReadTokens(Array.from({ length: 50 }, () => ({ dir: brand }))) <= SKILL_LIMITS.readTokens);
});
