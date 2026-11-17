import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { contextFileKeeper } from "./context-scope";
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
