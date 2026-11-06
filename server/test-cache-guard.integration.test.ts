// The fingerprint leaves out the spec claims and manifest because landing makes drafts official there and nowhere
// else, so a pass a chat got before landing stands for the merge copy's docs commit. This proves it by doing it: the
// spec tool's own `land --write`, as the merge queue runs it (server/merge-queue/run.ts landDrafts), on a spec of its
// own, then asks which paths changed and whether the tree fingerprint moved.
import { describe, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after } from "node:test";
import { expect } from "./merge-queue/testing/expect";
import { scratchRoot } from "./test-scratch";

const ROOT = resolve(import.meta.dirname, "..");
const TOOL = join(ROOT, "pi-config/extensions/spec/core/sova-spec-draft.mjs");
const cachePath = "../scripts/test-cache.mjs";
const fixturePath = "../pi-config/extensions/spec/tests/spec-fixture.mjs";
const { treeFingerprint, isExcluded } = (await import(cachePath)) as { treeFingerprint(root: string): { hash: string }; isExcluded(p: string): boolean };
const base = scratchRoot("sova-tc-spec-");
after(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tool = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [TOOL, ...args, "--root", root, "--json"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, timeout: 240_000 });
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  } catch {
    /* no answer */
  }
  return { code: r.status, j, out: `${r.stdout}\n${r.stderr}`.slice(-3000) };
};
/** Changed or new paths in the work tree (gitignored ones aside), as the merge copy's `git add` would see them. */
const changed = (root: string) =>
  git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
    .split("\0")
    .filter(Boolean)
    .map((r) => r.slice(3));

describe("what landing writes is exactly what the fingerprint leaves out", () => {
  test("land --write of a draft that rewrites an existing claim and adds a new one changes only excluded paths, and T doesn't move", { timeout: 300_000 }, async () => {
    const repo = join(base, "p");
    mkdirSync(repo);
    // A spec of its own (the spec tools' fixture writer, the layout Sova's spec uses): a test that read this
    // checkout's claims would itself depend on files the fingerprint leaves out.
    const specFixture = (await import(fixturePath)) as { writeSpec(root: string, o: Record<string, unknown>): void };
    specFixture.writeSpec(repo, {
      layout: 2,
      records: { "§a/top": { kind: "behavior", authority: "accepted", requires: [], code: ["app.txt"] } },
      claims: { "a/top.md": "# §a/top\n\nThe top does X.\n" },
    });
    writeFileSync(join(repo, ".sova/spec/.gitignore"), "/drafts/\n");
    writeFileSync(join(repo, ".sova/spec/README.md"), "readme\n");
    writeFileSync(join(repo, "app.txt"), "the app\n");
    git(repo, "init", "-q", "-b", "master");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "fixture");

    expect(tool(repo, "new", "probe", "--write").code).toBe(0);
    const spec = join(repo, ".sova/spec/drafts/probe/spec");
    // The existing claim rewritten, and a new one in an area of its own.
    const id = "§a/top";
    writeFileSync(join(spec, "claims/a/top.md"), "# §a/top\n\nThe top does X, and now Y.\n");
    const newId = "§b/probe";
    mkdirSync(join(spec, "claims/b"), { recursive: true });
    writeFileSync(join(spec, "claims/b/probe.json"), `${JSON.stringify({ [newId]: { kind: "behavior", authority: "accepted", requires: [], code: ["app.txt"] } }, null, 2)}\n`);
    writeFileSync(join(spec, "claims/b/probe.md"), `# ${newId}\n\nThe probe does its one thing.\n`);
    for (const x of [id, newId]) {
      const r = tool(repo, "evidence", "probe", "--id", x, "--by", "chat", "--verification", "checked", "--note", "--write");
      expect({ x, code: r.code, out: r.code ? r.out : "" }).toEqual({ x, code: 0, out: "" });
    }

    const before = treeFingerprint(repo).hash;
    // As the queue runs it (run.ts landDrafts).
    const land = tool(repo, "land", "--commit", "HEAD", "--by", "the user (Land)", "--verification", "merge queue", "--write");
    expect({ code: land.code, exit: land.j.exit, written: land.j.written, out: land.j.written ? "" : land.out }).toEqual({ code: 0, exit: 0, written: true, out: "" });
    const paths = changed(repo);
    expect(paths.length > 0).toBe(true); // the land wrote something: the check below isn't vacuous
    expect(paths.some((p) => p.endsWith(".md") && p.startsWith(".sova/spec/claims/"))).toBe(true);
    expect(paths.filter((p) => !isExcluded(p))).toEqual([]);
    expect((land.j.paths as string[]).filter((p) => !isExcluded(p) && !p.startsWith(".sova/spec/drafts/"))).toEqual([]);
    expect(treeFingerprint(repo).hash).toBe(before);
    // Committed as the queue's docs commit: still the same T.
    git(repo, "add", "--", ...paths);
    git(repo, "commit", "-q", "-m", "Spec: land probe");
    expect(treeFingerprint(repo).hash).toBe(before);
  });
});
