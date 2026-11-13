import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { skillDescentAllowed } from "./skill-descent";
import { scratchRoot } from "./test-scratch";

const base = scratchRoot("sova-descent-");
after(() => rmSync(base, { recursive: true, force: true }));
const dir = (p: string) => (mkdirSync(join(base, p), { recursive: true }), join(base, p));

// Two homes: `u`, whose folder is no repository, and `dots`, whose folder is one (dotfiles).
const home = dir("home/u");
const dots = dir("home/dots");
mkdirSync(join(dots, ".git"));
dir("home/u/repo/.git");
dir("home/u/repo/a/b");
dir("home/u/wt");
writeFileSync(join(home, "wt/.git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
dir("home/u/plain/sub");
dir("home/u/proj/sub");
dir("home/dots/plain");
dir("home/dots/repo/.git");
dir("srv/repo/.git");
dir("srv/repo/x");
symlinkSync(home, join(base, "home-link"));
symlinkSync(join(home, "repo"), join(home, "plain/repo-link"));

test("descent is on only inside a repository below home or a project, never at home or above it", () => {
  // [the chat's folder, its home, in a project, looks below it]
  const cases: [string, string, boolean, boolean][] = [
    // The home folder and every folder above it: off, a repository or a project there included.
    [home, home, false, false],
    [home, home, true, false],
    [join(base, "home"), home, true, false],
    ["/", home, true, false],
    [join(base, "home-link"), home, true, false], // home reached through a link
    [home, join(base, "home-link"), true, false], // the home named by a link
    [dots, dots, false, false], // a repository at home
    [dots, dots, true, false], // a project at home
    // Inside a repository whose top is below home: its top, a folder inside, a worktree (a .git file).
    [join(home, "repo"), home, false, true],
    [join(home, "repo/a/b"), home, false, true],
    [join(home, "wt"), home, false, true],
    [join(home, "plain/repo-link"), home, false, true], // a link into one: its real path's
    [join(base, "home-link/repo/a"), join(base, "home-link"), false, true],
    [join(dots, "repo"), dots, false, true],
    // A repository outside home: its top is no folder above home.
    [join(base, "srv/repo/x"), home, false, true],
    // A plain folder: off, unless it is a project's.
    [join(home, "plain/sub"), home, false, false],
    [join(home, "proj/sub"), home, false, false],
    [join(home, "proj/sub"), home, true, true],
    // Below a repository at home: the walk never reaches home, so a plain folder there stays plain.
    [join(dots, "plain"), dots, false, false],
    [join(dots, "plain"), dots, true, true],
    // A folder that isn't there.
    ["", home, true, false],
  ];
  for (const [cwd, h, inProject, want] of cases) assert.equal(skillDescentAllowed(cwd, { home: h, inProject }), want, `${cwd} (home ${h}, in a project: ${inProject})`);

  // The rule catches a walk that goes on past home (the dotfiles repository counted, as adHocRootOf would if it didn't stop).
  const pastHome = (cwd: string) => {
    for (let d = cwd; d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".git"))) return true;
    return false;
  };
  assert.notEqual(pastHome(join(dots, "plain")), skillDescentAllowed(join(dots, "plain"), { home: dots, inProject: false }));
});
