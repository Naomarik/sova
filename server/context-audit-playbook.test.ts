import { dropScratchAgentDir, scratchAgentDir } from "./testing/scratch-agent-dir"; // first: the state root is a throwaway one
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { readPlaybookSpec } from "./playbooks";
// @ts-expect-error: a plain .mjs script, no types
import * as ca from "../playbooks/context-audit/scripts/context-audit.mjs";

/**
 * The Context audit playbook's driver (playbooks/context-audit/scripts/context-audit.mjs), called in-process through its
 * `main` (the command line's own entry) and its exports, on throwaway git projects: one finding type per fixture. Its
 * state goes under the scratch agent dir; nothing here reads ~/.pi or the user's projects.
 */

const tmp = mkdtempSync(join(tmpdir(), "context-audit-"));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  dropScratchAgentDir();
});
const BUNDLE = fileURLToPath(new URL("../playbooks/context-audit", import.meta.url));
const stateDir = join(scratchAgentDir, "sova", "playbooks", "context-audit");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

let n = 0;
/** A committed scratch project with these files (a path → its text). */
function project(files: Record<string, string>): string {
  const r = join(tmp, `p${++n}`);
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q");
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), t);
  }
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  return r;
}
const skill = (name: string, body: string, extra = "") => `---\nname: ${name}\ndescription: Use for ${name} work.\n${extra}---\n\n${body}`;
/** Runs the command line in-process: its exit code and what it printed. */
function run(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = ca.main(argv, (s: string) => out.push(s), (s: string) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const lines = (k: number, word = "line") => Array.from({ length: k }, (_, i) => `${word} ${i + 1}`).join("\n") + "\n";
const LONG = "Run every test through the project's runner and never call the test tool bare, because a bare run skips the throwaway home and writes into real state, which is hard to undo later.";

test("instruction files: the top's in every message, a subfolder's when the agent works there; the first name wins; hidden folders and node_modules are never walked", () => {
  const r = project({
    "AGENTS.override.md": "# Override\n",
    "AGENTS.md": "# Ignored: the override wins\n",
    "server/CLAUDE.md": "# Server\n",
    "node_modules/x/AGENTS.md": "# never\n",
    ".hidden/AGENTS.md": "# never\n",
    ".pi/APPEND_SYSTEM.md": "Added.\n",
  });
  const inv = ca.inventory(r);
  const byPath = Object.fromEntries(inv.items.map((i: { path: string }) => [i.path, i]));
  assert.equal(byPath["AGENTS.override.md"].loads, "every message");
  assert.equal(byPath["AGENTS.md"], undefined, "a folder loads one instruction file, the first by name");
  assert.equal(byPath["server/CLAUDE.md"].loads, "when the agent works in server/");
  assert.equal(byPath["node_modules/x/AGENTS.md"], undefined);
  assert.equal(byPath[".hidden/AGENTS.md"], undefined);
  assert.match(byPath[".pi/APPEND_SYSTEM.md"].loads, /^every message/);
  assert.equal(inv.alwaysLoaded.tokens, ca.tokensOf("# Override\n") + ca.tokensOf("Added.\n"), "≈ tokens: characters / 4, rounded up");
  assert.equal(inv.head, git(r, "rev-parse", "HEAD").trim());
  assert.deepEqual(inv.dirty, []);
});

test("bands for a skill's entry page: fine up to 150 lines, worth a look up to 400, heavy above; never a failure", () => {
  assert.deepEqual([1, 150, 151, 400, 401].map(ca.bandOf), ["fine", "fine", "worth a look", "worth a look", "heavy"]);
});

test("skills: listing in every message, entry when used; manual-only never offered; no description, deliberate and generated are said", () => {
  const r = project({
    ".agents/skills/big/SKILL.md": skill("big", "Read all of this file first.\n\n## Part\n" + lines(420)),
    ".agents/skills/big/.build/build.mjs": "// generates reference/\n",
    ".agents/skills/big/reference/a.md": "# A\n",
    ".claude/skills/hand/SKILL.md": skill("hand", "Body\n", "disable-model-invocation: true\n"),
    ".pi/skills/loose.md": "---\nname: loose\n---\nNo description.\n",
  });
  const inv = ca.inventory(r);
  const big = inv.skills.find((s: { name: string }) => s.name === "big");
  assert.equal(big.band, "heavy");
  assert.equal(big.deliberate, true);
  assert.deepEqual(big.generated, { source: ".build/build.mjs", how: "node .build/build.mjs" });
  assert.ok(big.listingTokens > 0 && big.sections.some((s: { heading: string }) => s.heading === "Part"));
  const hand = inv.skills.find((s: { name: string }) => s.name === "hand");
  assert.equal(hand.manualOnly, true);
  assert.equal(hand.listingTokens, 0, "a manual-only skill is never offered");
  const loose = inv.skills.find((s: { name: string }) => s.name === "loose");
  assert.deepEqual(loose.problems, ["no description: pi doesn't load it"]);
  assert.deepEqual(inv.alwaysLoaded.top.map((p: { path: string }) => p.path), ["skill listings (1)"], "only the offered skill's listing is always loaded");
});

test("references: a broken link, a stale mention, a missing package script and an orphan are found; ignored output, short mentions of real files and placeholders are not", () => {
  const r = project({
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    ".gitignore": "dist/\n",
    "src/real.ts": "export {};\n",
    "AGENTS.md": [
      "See [the guide](docs/guide.md) and [gone](docs/gone.md).",
      "Code in `src/missing.ts`, built into `dist/app.js`, tested by `pnpm run test` and `pnpm run nope`.",
      "Short: `real.ts`. A draft lives in `drafts/NAME/`.",
      "",
    ].join("\n"),
    "docs/guide.md": "# Guide\n",
    "docs/lonely.md": "# Nothing points here\n",
  });
  const inv = ca.inventory(r);
  assert.deepEqual(inv.broken.map((b: { target: string }) => b.target), ["docs/gone.md"]);
  assert.deepEqual(inv.stale.map((s: { target: string }) => s.target).sort(), ["nope (package script)", "src/missing.ts"]);
  assert.deepEqual(inv.orphans.map((o: { path: string }) => o.path), ["docs/lonely.md"]);
  const guide = inv.items.find((i: { path: string }) => i.path === "docs/guide.md");
  assert.equal(guide.kind, "guide");
  assert.equal(guide.loads, "when AGENTS.md sends the agent there");
});

test("guides are followed one hop from an entry by default; --depth follows further", () => {
  const r = project({ "AGENTS.md": "[a](a.md)\n", "a.md": "[b](b.md)\n", "b.md": "end\n" });
  assert.equal(ca.inventory(r).items.some((i: { path: string }) => i.path === "b.md"), false);
  assert.equal(ca.inventory(r).beyond, 1);
  assert.equal(ca.inventory(r, { depth: 2 }).items.some((i: { path: string }) => i.path === "b.md"), true);
});

test("a link out of the project: a skill whose real place is outside never loads, and a link that climbs out is said", () => {
  const outsideSkill = join(tmp, "elsewhere-skill");
  mkdirSync(outsideSkill, { recursive: true });
  writeFileSync(join(outsideSkill, "SKILL.md"), skill("far", "x\n"));
  const r = project({ "AGENTS.md": "[up](../../somewhere.md)\n" });
  mkdirSync(join(r, ".agents", "skills"), { recursive: true });
  symlinkSync(outsideSkill, join(r, ".agents", "skills", "far"));
  const inv = ca.inventory(r);
  assert.equal(inv.skills.length, 0);
  assert.deepEqual(inv.outside.map((o: { why: string }) => o.why).sort(), ["link leads out of the project", "skill links out of the project: never loads"]);
});

test("repeats: a long passage in two files is one group with both places; short ones are boilerplate and skipped", () => {
  const r = project({
    "AGENTS.md": `# Rules\n\n${LONG}\n\nShort line.\n\n[t](testing.md)\n`,
    "testing.md": `# Testing\n\nShort line.\n\n- ${LONG}\n`,
  });
  const inv = ca.inventory(r);
  assert.equal(inv.repeats.length, 1);
  assert.deepEqual(inv.repeats[0].at, [{ path: "AGENTS.md", line: 3 }, { path: "testing.md", line: 5 }]);
});

test("a switched-off item is listed off and not counted; the user's own files only with --personal, marked as theirs", () => {
  const r = project({ "AGENTS.md": "# Top\n", ".agents/skills/s/SKILL.md": skill("s", "x\n") });
  const sw = { files: [{ path: join(r, "AGENTS.md"), state: "disallowed" }], skills: [{ path: join(r, ".agents/skills/s/SKILL.md"), state: "waiting" }], asking: true };
  const inv = ca.inventory(r, { switches: sw });
  assert.equal(inv.items.find((i: { path: string }) => i.path === "AGENTS.md").on, false);
  assert.equal(inv.skills[0].on, false, "waiting while new items start off is off");
  assert.equal(inv.totals.items, 0);
  assert.equal(inv.totals.off, 2);
  assert.equal(inv.alwaysLoaded.tokens, 0);
  assert.equal(ca.inventory(r, { switches: { ...sw, asking: false } }).skills[0].on, true, "waiting is on when nothing asks first");

  const agentDir = join(tmp, "agent");
  mkdirSync(join(agentDir, "skills", "mine"), { recursive: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "# Mine\n");
  writeFileSync(join(agentDir, "skills", "mine", "SKILL.md"), skill("mine", "x\n"));
  const home = join(tmp, "home");
  assert.equal(ca.inventory(r, { agentDir, home }).items.some((i: { personal: boolean }) => i.personal), false, "off by default");
  const withMine = ca.inventory(r, { agentDir, home, claudeDir: join(home, ".claude"), personal: true });
  assert.ok(withMine.items.find((i: { path: string }) => i.path === join(agentDir, "AGENTS.md")).personal);
  assert.ok(withMine.skills.find((s: { name: string }) => s.name === "mine").personal);
});

test("scope narrows what is counted and says how much was left out", () => {
  const r = project({ "AGENTS.md": "[g](docs/g.md)\n", "docs/g.md": "# G\n", ".agents/skills/s/SKILL.md": skill("s", "x\n") });
  const inv = ca.inventory(r, { scope: ["s"] });
  assert.deepEqual(inv.items.filter((i: { inScope: boolean }) => i.inScope).map((i: { path: string }) => i.path), [".agents/skills/s/SKILL.md"]);
  assert.equal(inv.totals.leftOut, 2);
});

test("the command line: exit 0 nothing to act on, 1 something found, 2 couldn't check; the digest names the detail file under the state root", () => {
  const clean = project({ "AGENTS.md": "# Fine\n" });
  const ok = run("inventory", "--root", clean, "--run", "t-clean");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /always loaded ≈2: AGENTS\.md ≈2/);
  const detail = join(stateDir, "t-clean", "inventory.json");
  assert.match(ok.out, new RegExp(`detail: ${detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  assert.equal(JSON.parse(readFileSync(detail, "utf8")).root, clean);

  const found = project({ "AGENTS.md": "[x](missing.md)\n" });
  assert.equal(run("inventory", "--root", found, "--run", "t-found").code, 1);
  assert.equal(run("links", "--root", found).code, 1);
  assert.match(run("links", "--root", found).out, /^broken {2}AGENTS\.md:1 → missing\.md$/m);
  assert.equal(run("repeats", "--root", found).code, 0);

  assert.equal(run("inventory", "--root", join(tmp, "absent")).code, 2);
  assert.equal(run("inventory", "--root", clean, "--switches", join(tmp, "absent.json")).code, 2);
  assert.equal(run("inventory", "--bogus").code, 2);
  assert.equal(run("nope").code, 2);
  assert.equal(run("check", "--root", clean).code, 2, "check needs --before or --moved");
});

test("the moved-text check: every old paragraph on exactly one new page, else exit 1 naming it; --clean deletes the run's folder only when nothing failed", () => {
  const old = `# Skill\n\n${LONG}\n\nSecond rule about naming branches after the task.\n\nThird rule about commits.\n`;
  const r = project({ ".agents/skills/s/SKILL.md": skill("s", old) });
  const before = run("inventory", "--root", r, "--run", "t-moved");
  assert.equal(before.code, 0, before.out);
  const inv = join(stateDir, "t-moved", "inventory.json");
  const entry = ".agents/skills/s/SKILL.md";
  // A good split: the index keeps one rule, the rest moves word for word.
  writeFileSync(join(r, entry), skill("s", `# Skill\n\nThird rule about commits.\n\n- naming: \`naming.md\`\n`));
  writeFileSync(join(r, ".agents/skills/s/naming.md"), `${LONG}\n\nSecond rule about naming branches after the task.\n`);
  const good = run("check", "--root", r, "--before", inv, "--moved", `${entry}=${entry},.agents/skills/s/naming.md`);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /every paragraph on exactly one new page/);
  assert.match(good.out, /^skill s: \d+ lines ≈\d+ \(fine\) → \d+ lines ≈\d+ \(fine\)$/m);
  // A lost paragraph and a doubled one.
  writeFileSync(join(r, ".agents/skills/s/naming.md"), `${LONG}\n\nThird rule about commits.\n`);
  const bad = run("check", "--root", r, "--before", inv, "--moved", `${entry}=${entry},.agents/skills/s/naming.md`, "--clean");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /missing \(old line \d+\): "Second rule about naming/);
  assert.match(bad.out, /on \.agents\/skills\/s\/SKILL\.md, \.agents\/skills\/s\/naming\.md .*"Third rule/);
  assert.ok(existsSync(inv), "a failed check keeps the working folder");
  const done = run("check", "--root", r, "--before", inv, "--clean");
  assert.equal(done.code, 0);
  assert.equal(existsSync(dirname(inv)), false, "nothing is kept between runs");
});

test("the playbook itself: a valid playbook.json, an index-sized entry page, and every page reached by its own inventory", async () => {
  const read = await readPlaybookSpec(BUNDLE);
  assert.ok(read && "spec" in read, JSON.stringify(read));
  const entryLines = ca.linesOf(readFileSync(join(BUNDLE, "PLAYBOOK.md"), "utf8"));
  assert.equal(ca.bandOf(entryLines), "fine", `PLAYBOOK.md is ${entryLines} lines: the index the playbook recommends`);
  const r = project({ "AGENTS.md": "# P\n" });
  cpSync(BUNDLE, join(r, ".sova", "playbooks", "context-audit"), { recursive: true });
  const inv = ca.inventory(r);
  assert.deepEqual(inv.orphans, [], "every page is named by the index or playbook.json");
  assert.deepEqual(inv.broken, []);
});
