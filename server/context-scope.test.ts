import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { contextFileKeeper, projectFileKeeper } from "./context-scope";
import { folderResources } from "./harness/pi/resources";
import { scratchRoot } from "./test-scratch";

const base = scratchRoot("sova-context-scope-");
after(() => rmSync(base, { recursive: true, force: true }));
const dir = (p: string) => (mkdirSync(join(base, p), { recursive: true }), join(base, p));

// Two homes: `u`, whose folder is no repository, and `dots`, whose folder is one (dotfiles).
const home = dir("home/u");
const dots = dir("home/dots");
mkdirSync(join(dots, ".git"));
dir("home/dots/plain");
const agentDir = dir("home/u/.pi/agent");
dir("home/u/repo/.git");
dir("home/u/repo/a/b");
// A submodule (its .git a file) and a nested worktree inside the repository.
dir("home/u/repo/mod/s");
writeFileSync(join(home, "repo/mod/.git"), "gitdir: ../.git/modules/mod\n");
dir("home/u/repo/.worktrees/n/s");
writeFileSync(join(home, "repo/.worktrees/n/.git"), "gitdir: ../../.git/worktrees/n\n");
// A worktree beside its project, in a folder of worktrees below home.
dir("home/u/wt/p-x/sub");
writeFileSync(join(home, "wt/p-x/.git"), "gitdir: /elsewhere/.git/worktrees/p-x\n");
dir("home/u/plain/sub");
dir("srv/repo/.git");
dir("srv/repo/x");
symlinkSync(home, join(base, "home-link"));
symlinkSync(join(home, "repo"), join(home, "plain/repo-link"));
symlinkSync(join(home, "repo/a"), join(base, "sub-link"));

/** What pi lists for a chat in `cwd` (P44): the agent dir's file, then one per folder from the typed cwd up to `/`. */
function piList(cwd: string): string[] {
  const up: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    up.unshift(join(d, "AGENTS.md"));
    if (dirname(d) === d) break;
  }
  return [join(agentDir, "AGENTS.md"), ...up];
}

const kept = (cwd: string, h = home) => piList(cwd).filter(contextFileKeeper(cwd, { home: h, agentDir }));
const files = (...dirs: string[]) => [join(agentDir, "AGENTS.md"), ...dirs.map((d) => join(d, "AGENTS.md"))];

test("a chat starts with the agent folder's file and those from its folder up to its repository's top below home, else its own folder's alone", () => {
  // [the chat's folder, its home, the folders whose file it keeps after the agent folder's, outermost first]
  const cases: [string, string, string[]][] = [
    // The home folder (typed, through a link, named by a link) and above it: its own folder's file only.
    [home, home, [home]],
    [join(base, "home-link"), home, [join(base, "home-link")]],
    [home, join(base, "home-link"), [home]],
    [join(base, "home"), home, [join(base, "home")]],
    ["/", home, ["/"]],
    // A repository below home: its top, a folder inside it.
    [join(home, "repo"), home, [join(home, "repo")]],
    [join(home, "repo/a/b"), home, [join(home, "repo"), join(home, "repo/a"), join(home, "repo/a/b")]],
    // A submodule and a nested worktree stop at their own top.
    [join(home, "repo/mod/s"), home, [join(home, "repo/mod"), join(home, "repo/mod/s")]],
    [join(home, "repo/.worktrees/n/s"), home, [join(home, "repo/.worktrees/n"), join(home, "repo/.worktrees/n/s")]],
    // A worktree beside its project: never the folder of worktrees nor the home folder above it.
    [join(home, "wt/p-x/sub"), home, [join(home, "wt/p-x"), join(home, "wt/p-x/sub")]],
    // A plain folder below home: its own file only.
    [join(home, "plain/sub"), home, [join(home, "plain/sub")]],
    // A repository outside home keeps its top.
    [join(base, "srv/repo/x"), home, [join(base, "srv/repo"), join(base, "srv/repo/x")]],
    // A repository at home (dotfiles) makes no folder below it one.
    [join(dots, "plain"), dots, [join(dots, "plain")]],
    [dots, dots, [dots]],
    // Through a link: the typed folders whose real place is allowed (the link to the top counts, the folders around it don't).
    [join(home, "plain/repo-link/a"), home, [join(home, "plain/repo-link"), join(home, "plain/repo-link/a")]],
    // A link straight into a repository's folder: that folder's file, never the top's (pi never walks there).
    [join(base, "sub-link"), home, [join(base, "sub-link")]],
  ];
  // A walk that climbed into the home folder fails the dotfiles and worktree cases; one by typed path alone, the links.
  for (const [cwd, h, want] of cases) assert.deepEqual(kept(cwd, h), files(...want), `${cwd} (home ${h})`);
});

test("the agent folder's file is kept whatever the folder, and nothing else outside the allowed folders", () => {
  const keep = contextFileKeeper(join(home, "plain/sub"), { home, agentDir });
  assert.equal(keep(join(agentDir, "CLAUDE.md")), true);
  assert.equal(keep(join(home, "AGENTS.md")), false, "the home folder's file never loads by climbing");
  assert.equal(keep("AGENTS.md"), false, "a relative path is no file of a folder");
});

// ---- a project's files are real files in it ---------------------------------------------------------------------

/** A repository with links out of it and inside it, an outside folder, and an agent folder whose files are links. */
function linked() {
  const at = dir(`linked-${Math.random().toString(36).slice(2)}`);
  const put = (rel: string, text = rel) => (mkdirSync(dirname(join(at, rel)), { recursive: true }), writeFileSync(join(at, rel), text), join(at, rel));
  const skill = (rel: string, name: string) => put(`${rel}/SKILL.md`, `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`);
  mkdirSync(join(at, "repo", ".git"), { recursive: true });
  put("outside/AGENTS.md", "OUTSIDE");
  skill("outside/skills/away", "away");
  skill("outside/config/skills/mine", "mine");
  put("outside/config/AGENTS.md", "MINE");
  put("repo/real.md", "REAL");
  skill("repo/lib/kept", "kept");
  mkdirSync(join(at, "repo", "sub", ".agents", "skills"), { recursive: true });
  symlinkSync(join(at, "outside", "AGENTS.md"), join(at, "repo", "AGENTS.md")); // out of the repository
  symlinkSync(join(at, "repo", "real.md"), join(at, "repo", "sub", "CLAUDE.md")); // inside it
  mkdirSync(join(at, "repo", ".agents", "skills"), { recursive: true });
  symlinkSync(join(at, "outside", "skills", "away"), join(at, "repo", ".agents", "skills", "away"));
  symlinkSync(join(at, "repo", "lib", "kept"), join(at, "repo", ".agents", "skills", "kept"));
  // The agent folder: its file and skills are links into the user's config, and it is no project.
  const agent = join(at, "agent");
  mkdirSync(join(agent, "skills"), { recursive: true });
  symlinkSync(join(at, "outside", "config", "AGENTS.md"), join(agent, "AGENTS.md"));
  symlinkSync(join(at, "outside", "config", "skills", "mine"), join(agent, "skills", "mine"));
  return { at, repo: join(at, "repo"), agent };
}

test("a project's context file or skill linked out of the project never loads; a link inside it does; the agent folder's links always do", () => {
  const { at, repo, agent } = linked();
  const sub = join(repo, "sub");
  const keep = contextFileKeeper(sub, { home, agentDir: agent });
  assert.equal(keep(join(repo, "AGENTS.md")), false, "AGENTS.md linked to a file outside the repository");
  assert.equal(keep(join(sub, "CLAUDE.md")), true, "a link to a file inside it");
  assert.equal(keep(join(agent, "AGENTS.md")), true, "the agent folder's file, itself a link");
  const real = projectFileKeeper(sub, { home, agentDir: agent });
  assert.equal(real(join(repo, ".agents/skills/away/SKILL.md")), false, "a skill folder linked outside");
  assert.equal(real(join(repo, ".agents/skills/kept/SKILL.md")), true, "a skill folder linked inside");
  assert.equal(real(join(agent, "skills/mine/SKILL.md")), true);
  assert.equal(real(join(at, "outside/skills/away/SKILL.md")), true, "found outside the project: not the project's to judge");
  symlinkSync(join(at, "nowhere"), join(repo, "dangling.md"));
  assert.equal(real(join(repo, "dangling.md")), false, "a dangling link loads nothing");
  // An agent folder inside the repository (a worktree's hermetic .agent) is still no project: its links load.
  const inner = join(repo, ".agent");
  mkdirSync(join(inner, "skills"), { recursive: true });
  symlinkSync(join(at, "outside", "config", "AGENTS.md"), join(inner, "AGENTS.md"));
  symlinkSync(join(at, "outside", "config", "skills", "mine"), join(inner, "skills", "mine"));
  assert.equal(contextFileKeeper(sub, { home, agentDir: inner })(join(inner, "AGENTS.md")), true);
  assert.equal(projectFileKeeper(sub, { home, agentDir: inner })(join(inner, "skills/mine/SKILL.md")), true);
  assert.equal(projectFileKeeper(sub, { home })(join(inner, "skills/mine/SKILL.md")), false, "the same link, were it not the agent folder");
  // A chat at home or above works in no project: nothing of it is judged.
  assert.equal(projectFileKeeper(home, { home })(join(home, "anything", "SKILL.md")), true);
});

test("through the adapter's funnel: pi's own load of the folder drops the linked-out file and skill, and keeps the rest", async () => {
  const { repo, agent } = linked();
  const res = await folderResources(join(repo, "sub"), agent);
  assert.deepEqual(res.context.map((f) => f.path), [join(agent, "AGENTS.md"), join(repo, "sub", "CLAUDE.md")]);
  const skills = res.skills.map((s) => s.name).sort();
  assert.ok(skills.includes("kept") && skills.includes("mine"), `in-repo link and the agent folder's: ${skills}`);
  assert.ok(!skills.includes("away"), "a skill linked out of the repository is not offered");
});
