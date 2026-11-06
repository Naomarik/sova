// Run: bun test server/modes/personal.test.ts (or pnpm test)
// Personal minor modes (server/modes/personal.ts): the folder's discovery and "yours wins" against a project's.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverProjectModes } from "../../pi-config/extensions/mode/project-discovery.ts";
import type { ProjectModeListing } from "../../shared/project-modes";
import { approvalRootFor, approvalRootOfDir, discoverPersonalModes, isPersonalDir, isPersonalId, mergeModeListings, personalModesDir, projectRootForDir } from "./personal";

const MODE = (description: string, body = "Do the thing.") => `---\ndescription: ${description}\n---\n${body}\n`;

function withDirs(fn: (home: string, repo: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "personal-modes-"));
  try {
    const home = join(base, "home", "minor-modes");
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    fn(home, repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const put = (dir: string, id: string, text: string | null) => {
  mkdirSync(join(dir, id), { recursive: true });
  if (text !== null) writeFileSync(join(dir, id, "MODE.md"), text);
};

test("personalModesDir: <state root>/minor-modes, read per call from the chat's state root", () => {
  const before = process.env.SOVA_CHAT_STATE_ROOT;
  try {
    process.env.SOVA_CHAT_STATE_ROOT = "/x/state";
    assert.equal(personalModesDir(), "/x/state/minor-modes");
    process.env.SOVA_CHAT_STATE_ROOT = "/y/state";
    assert.equal(personalModesDir(), "/y/state/minor-modes");
  } finally {
    if (before === undefined) delete process.env.SOVA_CHAT_STATE_ROOT;
    else process.env.SOVA_CHAT_STATE_ROOT = before;
  }
});

test("discoverPersonalModes: the project format, broken folders listed, built-ins reserved, never throws", () => {
  withDirs((home) => {
    put(home, "tidy", MODE("Keep it tidy"));
    put(home, "spec", MODE("Not allowed"));
    put(home, "Bad_Name", MODE("Bad"));
    put(home, "empty", null);
    put(home, ".hidden", MODE("Skipped"));
    writeFileSync(join(home, "loose-file"), "not a folder");
    const listing = discoverPersonalModes(home);
    assert.equal(listing.root, home);
    assert.equal(listing.name, "");
    assert.deepEqual(listing.modes.map((m) => [m.id, m.description, m.dir]), [["tidy", "Keep it tidy", join(home, "tidy")]]);
    assert.ok(listing.modes[0]!.text.startsWith("# Project minor mode: tidy\n"), "the same block a project mode gets");
    assert.deepEqual(
      listing.problems.map((p) => [p.id, p.kind]),
      [
        ["Bad_Name", "bad-id"],
        ["empty", "no-entry"],
        ["spec", "clash"],
      ],
    );
    assert.deepEqual(discoverPersonalModes(join(home, "missing")), { root: join(home, "missing"), name: "", modes: [], problems: [] });
  });
});

test("discoverPersonalModes reads a folder exactly as a project's: same words and block, only the folder differs", () => {
  withDirs((home, repo) => {
    const text = MODE("Same words", "Same body.");
    put(home, "same", text);
    put(join(repo, ".sova", "minor-modes"), "same", text);
    const mine = discoverPersonalModes(home).modes[0]!;
    const theirs = discoverProjectModes(repo).modes[0]!;
    // Only the folder differs (and so the block's Folder: line and the sha that covers it).
    assert.equal(mine.description, theirs.description);
    assert.equal(mine.text.replace(home, "<dir>"), theirs.text.replace(join(repo, ".sova", "minor-modes"), "<dir>"));
  });
});

test("mergeModeListings: yours wins, one entry per id, the rest of both kept", () => {
  withDirs((home, repo) => {
    const proj = join(repo, ".sova", "minor-modes");
    put(proj, "release", MODE("Project release"));
    put(proj, "lint", MODE("Project lint"));
    put(proj, "broken", null);
    put(home, "release", MODE("My release"));
    put(home, "broken", MODE("My fixed one"));
    put(home, "notes", null);
    put(home, "zeta", MODE("Mine only"));
    const merged = mergeModeListings(discoverProjectModes(repo), discoverPersonalModes(home));
    assert.equal(merged.root, repo, "root and name stay the project's");
    assert.equal(merged.name, "repo");
    assert.deepEqual(
      merged.modes.map((m) => [m.id, m.description]),
      [
        ["broken", "My fixed one"],
        ["lint", "Project lint"],
        ["release", "My release"],
        ["zeta", "Mine only"],
      ],
    );
    assert.deepEqual(merged.problems.map((p) => p.id), ["notes"]);
    const ids = [...merged.modes, ...merged.problems].map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "no id twice");
    assert.deepEqual(merged.personalIds, ["broken", "notes", "release", "zeta"]);
    assert.deepEqual(merged.replacedIds, ["broken", "release"], "the ids yours took over from the project");
    assert.equal(merged.personalRoot, home);
    assert.equal(merged.modes.find((m) => m.id === "release")!.dir, join(home, "release"));
  });
});

test("mergeModeListings: a broken personal folder still wins over the project's working mode", () => {
  withDirs((home, repo) => {
    put(join(repo, ".sova", "minor-modes"), "release", MODE("Project release"));
    put(home, "release", "---\nnope: 1\n---\nx\n");
    const merged = mergeModeListings(discoverProjectModes(repo), discoverPersonalModes(home));
    assert.deepEqual(merged.modes, []);
    assert.deepEqual(merged.problems.map((p) => [p.id, p.kind, p.path.startsWith(home)]), [["release", "parse", true]]);
  });
});

test("mergeModeListings: no personal modes leaves the project listing as it was", () => {
  const project: ProjectModeListing = { root: "/r", name: "r", modes: [], problems: [] };
  assert.deepEqual(mergeModeListings(project, null), { ...project, personalRoot: null, personalIds: [], replacedIds: [] });
  assert.deepEqual(mergeModeListings(project, { root: "/h", name: "", modes: [], problems: [] }), { ...project, personalRoot: null, personalIds: [], replacedIds: [] });
});

test("approvalRootFor: the personal folder for yours (once, every project), the checkout for the project's", () => {
  withDirs((home, repo) => {
    put(join(repo, ".sova", "minor-modes"), "lint", MODE("Project lint"));
    put(home, "tidy", MODE("Mine"));
    const merged = mergeModeListings(discoverProjectModes(repo), discoverPersonalModes(home));
    assert.equal(approvalRootFor(merged, "tidy"), home);
    assert.equal(approvalRootFor(merged, "lint"), repo);
    assert.equal(isPersonalId(merged, "tidy"), true);
    assert.equal(isPersonalId(discoverProjectModes(repo), "lint"), false, "a plain listing has no personal ids");
    assert.equal(approvalRootFor(discoverProjectModes(repo), "lint"), repo);
    // Another project gets the same key for the same personal mode.
    const other = mergeModeListings({ root: "/elsewhere", name: "elsewhere", modes: [], problems: [] }, discoverPersonalModes(home));
    assert.equal(approvalRootFor(other, "tidy"), home);
  });
});

test("from a copy's folder alone: personal or not, its approval key, and the project root its programs get", () => {
  withDirs((home, repo) => {
    const modeDir = join(repo, ".sova", "minor-modes", "lint");
    mkdirSync(join(repo, "sub"), { recursive: true });
    assert.equal(isPersonalDir(join(home, "tidy"), home), true);
    assert.equal(isPersonalDir(modeDir, home), false);
    assert.equal(isPersonalDir("", home), false);
    assert.equal(isPersonalDir(join(home, "tidy", "deeper"), home), false);
    assert.equal(approvalRootOfDir(join(home, "tidy"), home), home, "yours: your folder");
    assert.equal(approvalRootOfDir(modeDir, home), repo, "a project's: its checkout");
    assert.equal(projectRootForDir(join(home, "tidy"), join(repo, "sub"), home), repo, "yours runs for the chat's checkout");
    assert.equal(projectRootForDir(modeDir, "/anywhere", home), repo);
  });
});
