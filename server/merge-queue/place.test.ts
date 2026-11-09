import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProjectOf } from "../project-root";
import { branchPlace, type PlaceProject } from "./place";

const HOME = "/home/me";
const MAIN = `${HOME}/code/app`;
const WT = `${HOME}/code/.worktrees/app-feat`;
const ok = (root: string): ProjectOf => ({ state: "ok", root, name: "x", git: true });

/** One row's place, over a Projects list, from where git puts `path` (undefined: its folder is gone). */
const placeOf = (listed: PlaceProject[], path: string, gitRoot: string | undefined, targetOf = async (_: string): Promise<string | undefined> => "master") =>
  branchPlace({ listed: () => listed, projectOf: async () => (gitRoot ? ok(gitRoot) : { state: "missing", message: "gone" }), exists: () => gitRoot !== undefined, targetOf, home: HOME }, path);

describe("a branch's place (§chat.worktrees/place)", () => {
  const cases: [string, PlaceProject[], string, string | undefined, string, string | undefined][] = [
    ["a registered project: its name", [{ root: MAIN, name: "AmalMoney" }], WT, MAIN, "AmalMoney", MAIN],
    ["an attached folder at any path: the name git's main checkout has", [{ root: MAIN, name: "AmalMoney" }], "/mnt/elsewhere/feat", MAIN, "AmalMoney", MAIN],
    ["an archived project: the folder", [{ root: MAIN, name: "AmalMoney", archived: { at: "x" } }], WT, MAIN, "~/code/app", MAIN],
    ["a repository not on the list: the folder", [{ root: "/other", name: "Other" }], WT, MAIN, "~/code/app", MAIN],
    ["a blank name: the folder", [{ root: MAIN, name: "   " }], WT, MAIN, "~/code/app", MAIN],
    ["a folder outside home stays absolute", [], "/srv/wt", "/srv/app", "/srv/app", "/srv/app"],
    ["two listed projects with one name: just enough of the folder", [{ root: `${HOME}/work/notes`, name: "Notes" }, { root: `${HOME}/home/notes`, name: "Notes" }], WT, `${HOME}/work/notes`, "Notes · work/notes", `${HOME}/work/notes`],
    ["the same name on an archived project tells nothing apart", [{ root: `${HOME}/work/notes`, name: "Notes" }, { root: `${HOME}/old/notes`, name: "Notes", archived: true }], WT, `${HOME}/work/notes`, "Notes", `${HOME}/work/notes`],
    ["a deleted folder Sova named: the project still worked out, with no git", [{ root: MAIN, name: "AmalMoney" }], WT, undefined, "AmalMoney", MAIN],
    ["a deleted folder of an archived project: its main folder, never the name", [{ root: MAIN, name: "AmalMoney", archived: true }], WT, undefined, "~/code/app", MAIN],
    ["a deleted attached folder at a custom path: as last recorded, no main folder", [{ root: MAIN, name: "AmalMoney" }], `${HOME}/scratch/feat`, undefined, "~/scratch/feat", undefined],
    ["a deleted folder with nothing listed: as last recorded", [], WT, undefined, "~/code/.worktrees/app-feat", undefined],
  ];
  for (const [name, listed, path, gitRoot, label, root] of cases)
    test(name, async () => {
      const p = await placeOf(listed, path, gitRoot);
      assert.deepEqual([p.label, p.root], [label, root]);
      assert.equal(p.target, root ? "master" : undefined, "a target only with a repository to read it from");
    });

  test("a target nothing can name is left out, and a failing read is not a guess", async () => {
    assert.equal("target" in (await placeOf([], WT, MAIN, async () => undefined)), false);
    assert.equal("target" in (await placeOf([], WT, MAIN, async () => Promise.reject(new Error("git")))), false);
  });

  test("a remote session's folder: the target's own, never this computer's home or list", async () => {
    const path = `${HOME}/.pi/agent/sova/targets/box/home/me/wt`;
    const p = await branchPlace({ listed: () => [{ root: HOME, name: "Dotfiles" }], projectOf: async () => ok(HOME), exists: () => true, targetOf: async () => "master", remote: () => ({ target: "box", remoteCwd: "/home/me/wt" }), home: HOME }, path);
    assert.deepEqual(p, { label: "box:/home/me/wt" });
  });

  test("a list that can't be read still gives the folder", async () => {
    const p = await branchPlace({ listed: () => { throw new Error("not open"); }, projectOf: async () => ok(MAIN), exists: () => true, home: HOME }, WT);
    assert.deepEqual(p, { label: "~/code/app", root: MAIN });
  });
});
