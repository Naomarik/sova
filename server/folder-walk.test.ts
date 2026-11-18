// Run: pnpm test server/folder-walk.test.ts. The approval list's subfolder walk (server/folder-walk.ts): the same
// answer as the sync walks it replaces, read without holding the thread, and kept per checkout by its freshness rule.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { listSubfolderInstructions } from "./deeper-context";
import { folderWalksIdle, forgetFolderWalksForTest, keptRead, subfolderWalk, walkIo, walkSubfolders, WALK_TTL_MS } from "./folder-walk";
import { piSkillsIn } from "./harness/pi/skill-sources";
import { listSubfolderSkills } from "./subfolder-skills";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => forgetFolderWalksForTest());

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} does things\n---\n\n# ${name}\n`;
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-walk-")));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    if (p.endsWith("/")) mkdirSync(join(root, p), { recursive: true });
    else {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
  }
  return root;
}

/** The sync walks' answer, in the walk's shape. */
function syncAnswer(root: string, cap?: number) {
  const opts = cap !== undefined ? { cap } : {};
  const files = listSubfolderInstructions(root, [], opts);
  const skills = listSubfolderSkills(root, piSkillsIn, opts);
  return { files: files.files.map((f) => ({ abs: f.abs, dir: f.dir })), skills: skills.skills, incomplete: files.incomplete || skills.incomplete };
}

const big = () =>
  tree({
    ".gitignore": "ignored/\n",
    "AGENTS.md": "# root: never a subfolder's\n",
    ".agents/skills/rootskill/SKILL.md": skill("rootskill"),
    "api/AGENTS.md": "# api\n",
    "api/CLAUDE.md": "# api, second\n",
    "api/v1/AGENTS.override.md": "# v1 override\n",
    "api/v1/AGENTS.md": "# v1\n",
    "web/CLAUDE.md": "# web\n",
    "web/src/deep/AGENTS.md": "# deep\n",
    "web/.agents/skills/build/SKILL.md": skill("build"),
    "web/.claude/skills/build/SKILL.md": skill("build"),
    "web/.claude/skills/lint/SKILL.md": skill("lint"),
    "svc/a/.claude/skills/deploy/SKILL.md": skill("deploy"),
    "ignored/.agents/skills/hidden/SKILL.md": skill("hidden"),
    "ignored/AGENTS.md": "# ignored folders still have instructions\n",
    "node_modules/x/AGENTS.md": "# never\n",
    ".hidden/AGENTS.md": "# never\n",
    "lower/agents.md": "# a name only a case-insensitive disk takes\n",
    "notes/AGENTS.md/": "",
    "a1/x/": "",
    "a2/x/": "",
    "a3/x/": "",
    "a4/x/": "",
    "a5/x/": "",
    "a6/x/": "",
    "a7/x/": "",
  });

test("one async pass gives what the two sync walks give, in their order, at every cap", async () => {
  const root = big();
  execFileSync("git", ["init", "-q"], { cwd: root });
  // A linked instruction file counts as the file it points at; a dangling one doesn't.
  symlinkSync(join(root, "api", "AGENTS.md"), join(root, "a1", "AGENTS.md"));
  symlinkSync(join(root, "nowhere.md"), join(root, "a2", "AGENTS.md"));
  const want = syncAnswer(root);
  assert.ok(want.files.some((f) => f.dir === "api/v1" && f.abs.endsWith("AGENTS.override.md")), "the tree is what the test means");
  assert.ok(want.skills.some((s) => s.name === "deploy"));
  assert.ok(!want.skills.some((s) => s.name === "hidden"), "git's answer is taken");
  assert.deepEqual(await walkSubfolders(root, { read: piSkillsIn }), want);
  // The cap falls inside a batch of folders read together: the folders after it in the queue are dropped, as the sync walks drop them.
  for (const cap of [0, 1, 2, 5, 7, 9, 12, 20]) assert.deepEqual(await walkSubfolders(root, { read: piSkillsIn, cap }), syncAnswer(root, cap), `cap ${cap}`);
});

test("a folder it can't list is still checked by path, as the sync walks check it", { skip: process.getuid?.() === 0 }, async () => {
  const root = tree({ "locked/AGENTS.md": "# locked\n", "locked/.agents/skills/s/SKILL.md": skill("s") });
  chmodSync(join(root, "locked"), 0o100);
  try {
    const want = syncAnswer(root);
    assert.deepEqual(want.files.map((f) => f.dir), ["locked"]);
    assert.deepEqual(await walkSubfolders(root, { read: piSkillsIn, ignores: async () => false }), want);
  } finally {
    chmodSync(join(root, "locked"), 0o755);
  }
});

test("the walk doesn't hold the thread: the event loop turns while it reads", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`d${i}/e/AGENTS.md`] = "# x\n";
  const root = tree(files);
  // One count per turn of the event loop (a 1 ms timer can miss a walk this fast on a warm disk).
  let turns = 0;
  let on = true;
  const spin = () => {
    turns++;
    if (on) setImmediate(spin);
  };
  setImmediate(spin);
  const walk = await walkSubfolders(root, { read: piSkillsIn, ignores: async () => false });
  on = false;
  assert.equal(walk.files.length, 200);
  assert.ok(turns > 1, `the loop turned during the walk (${turns})`);
});

test("the freshness rule: reads answer from the kept walk; an aged one starts one walk in the background; fresh walks now", async () => {
  const root = tree({ "a/AGENTS.md": "# a\n" });
  let t = 5_000_000;
  const o = { read: piSkillsIn, ignores: async () => false, now: () => t };
  const dirs = async (more: { fresh?: boolean } = {}) => (await subfolderWalk(root, { ...o, ...more })).files.map((f) => f.dir);
  const before = walkIo.walks;
  // The first reads wait on one walk, joined.
  const [x, y] = await Promise.all([dirs(), dirs()]);
  assert.deepEqual([x, y], [["a"], ["a"]]);
  assert.equal(walkIo.walks, before + 1, "two reads, one walk");
  // Added and removed files: the kept walk answers until it ages.
  mkdirSync(join(root, "b"));
  writeFileSync(join(root, "b", "CLAUDE.md"), "# b\n");
  rmSync(join(root, "a", "AGENTS.md"));
  t += WALK_TTL_MS - 1;
  assert.deepEqual(await dirs(), ["a"], "younger than WALK_TTL_MS: the kept walk, no new one");
  assert.equal(walkIo.walks, before + 1);
  t += 1;
  assert.deepEqual(await dirs(), ["a"], "aged: answered at once from the kept walk…");
  assert.deepEqual(await dirs(), ["a"]);
  assert.equal(walkIo.walks, before + 2, "…and one walk started behind it, however many read meanwhile");
  await folderWalksIdle();
  assert.deepEqual(await dirs(), ["b"], "the next read sees the change");
  // fresh: walked now and waited for, and kept for the reads after it.
  writeFileSync(join(root, "a", "AGENTS.md"), "# a again\n");
  assert.deepEqual(await dirs({ fresh: true }), ["a", "b"]);
  assert.deepEqual(await dirs(), ["a", "b"]);
});

test("a walk that started earlier never replaces one kept from a later start, nor answers a reader after it", async () => {
  const root = tree({ "a/.agents/skills/s/SKILL.md": skill("s") });
  let release!: () => void;
  const held = new Promise<void>((go) => (release = go));
  let entered!: () => void;
  const inside = new Promise<void>((go) => (entered = go));
  let hold = true;
  const ignores = async () => {
    if (hold) {
      entered();
      await held;
    }
    return false;
  };
  const o = { read: piSkillsIn, ignores, now: () => 1 };
  const slow = subfolderWalk(root, o);
  await inside; // the slow walk has looked at a's files and waits on git
  hold = false;
  writeFileSync(join(root, "a", "AGENTS.md"), "# a\n");
  const quick = await subfolderWalk(root, { ...o, fresh: true });
  assert.deepEqual(quick.files.map((f) => f.dir), ["a"]);
  const quickSeq = (await subfolderWalk(root, o)).seq;
  release();
  assert.deepEqual((await slow).files.map((f) => f.dir), ["a"], "a reader that joined the slow walk gets the newest kept one");
  assert.equal((await slow).seq, quickSeq);
  await folderWalksIdle();
  assert.deepEqual((await subfolderWalk(root, o)).files.map((f) => f.dir), ["a"], "and the later walk stays the one kept");
  assert.equal(await walkSubfolders(root, { read: piSkillsIn, ignores: async () => false }).then((w) => w.files.length), 1);
});

test("serial reads behind kept ones run one per timer turn, never back to back", async () => {
  let t = 7_000_000;
  const order: string[] = [];
  const read = (name: string) => async () => {
    order.push(name);
    return name;
  };
  const o = { serial: true, now: () => t };
  await Promise.all(["a", "b", "c"].map((n) => keptRead(`serial-test\0${n}`, read(n), o)));
  order.length = 0;
  t += WALK_TTL_MS;
  for (const n of ["a", "b", "c"]) await keptRead(`serial-test\0${n}`, read(n), o);
  assert.equal(order.length, 0, "none runs on the asking turn");
  setTimeout(() => order.push("timer"), 0);
  await folderWalksIdle();
  assert.deepEqual(order, ["a", "timer", "b", "c"], "a timer queued meanwhile runs before the second");
  assert.equal((await keptRead("serial-test\0c", read("c"), o)).value, "c");
});
