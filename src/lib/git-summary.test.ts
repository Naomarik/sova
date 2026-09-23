import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitFileChange, GitRepoSummary } from "../../shared/protocol";
import { capNote, changeLabel, changesLabel, fileLines, filesHeadline, headLabel, linesNote, loadGitSummary, placeLabel, rootLabel, upstreamLabel, visiblePath } from "./git-summary";

const base: GitRepoSummary = {
  state: "repo",
  where: { kind: "local" },
  cwd: "/home/u/proj/src",
  root: "/home/u/proj",
  head: { kind: "branch", name: "main" },
  unborn: false,
  upstream: null,
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  clean: true,
  lastCommit: null,
  files: [],
  filesTotal: 0,
  statusPartial: false,
  lines: "ok",
  added: 0,
  removed: 0,
  checkedAt: 0,
};
const repo = (over: Partial<GitRepoSummary>): GitRepoSummary => ({ ...base, ...over });
const file = (over: Partial<GitFileChange>): GitFileChange => ({ path: "a.ts", kind: "tracked", lines: null, ...over });

test("head: branch, unborn branch, detached with and without an oid", () => {
  assert.equal(headLabel(base), "main");
  assert.equal(headLabel(repo({ unborn: true })), "main · no commits yet");
  assert.equal(headLabel(repo({ head: { kind: "detached", oid: "1a2b3c4d5e6f" } })), "Detached at 1a2b3c4");
  assert.equal(headLabel(repo({ head: { kind: "detached", oid: "" } })), "Detached");
});

test("upstream: never 'up to date' — the client doesn't fetch — and a gone upstream says so", () => {
  const level = upstreamLabel(repo({ upstream: { name: "origin/main", ahead: 0, behind: 0 } }));
  assert.equal(level, "Level with origin/main");
  assert.doesNotMatch(level, /up to date/i);
  assert.equal(upstreamLabel(repo({ upstream: { name: "origin/main", ahead: 2, behind: 0 } })), "2 ahead origin/main");
  assert.equal(upstreamLabel(repo({ upstream: { name: "origin/main", ahead: 1, behind: 3 } })), "1 ahead, 3 behind origin/main");
  assert.equal(upstreamLabel(repo({ upstream: { name: "origin/x", gone: true } })), "origin/x is gone");
  assert.equal(upstreamLabel(base), "None set");
});

test("changes: clean only when the server said clean; a partial read is 'at least', never 'clean'", () => {
  assert.equal(changesLabel(base), "Clean");
  const dirty = { clean: false, counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 1 } };
  assert.equal(changesLabel(repo(dirty)), "1 conflicted · 1 staged · 2 unstaged · 3 untracked");
  assert.equal(changesLabel(repo({ ...dirty, statusPartial: true })), "At least 1 conflicted · 1 staged · 2 unstaged · 3 untracked");
  const nothingRead = changesLabel(repo({ clean: false, statusPartial: true }));
  assert.notEqual(nothingRead, "Clean");
});

test("per-file lines: counts with signs; binary, untracked and uncounted in words — never +0 −0", () => {
  assert.equal(fileLines(file({ lines: { added: 12, removed: 3 } })), "+12 −3");
  assert.equal(fileLines(file({ lines: "binary" })), "binary");
  assert.equal(fileLines(file({ kind: "untracked" })), "untracked");
  assert.equal(fileLines(file({ kind: "untracked", path: "dir/" })), "untracked folder");
  assert.equal(fileLines(file({ lines: null })), "not counted");
});

test("change labels: staged side first, the rename source only on a rename, submodules marked", () => {
  assert.equal(changeLabel(file({ staged: "renamed", from: "old.ts", unstaged: "modified" })), "staged renamed from old.ts · unstaged modified");
  assert.equal(changeLabel(file({ staged: "type-changed" })), "staged type changed");
  assert.equal(changeLabel(file({ unstaged: "deleted", submodule: true })), "submodule · unstaged deleted");
  assert.equal(changeLabel(file({ kind: "conflicted" })), "conflicted");
  assert.equal(changeLabel(file({ kind: "untracked" })), "not tracked yet");
});

test("the list headline, the cap note and the lines note", () => {
  assert.equal(filesHeadline(repo({ filesTotal: 1 })), "1 changed path");
  assert.equal(filesHeadline(repo({ filesTotal: 7, added: 120, removed: 40 })), "7 changed paths · +120 −40");
  assert.equal(filesHeadline(repo({ filesTotal: 7, statusPartial: true })), "At least 7 changed paths");
  assert.equal(capNote(repo({ files: [file({})], filesTotal: 1 })), null);
  assert.equal(capNote(repo({ files: [file({})], filesTotal: 900 })), "Showing the first 1 of 900.");
  assert.equal(linesNote(base), null);
  for (const lines of ["partial", "timeout", "failed"] as const) assert.match(linesNote(repo({ lines }))!, /not counted/);
});

test("places: ~ locally, target:path remotely", () => {
  assert.equal(rootLabel(base, "/home/u"), "~/proj");
  assert.equal(rootLabel(repo({ where: { kind: "remote", target: "box" }, root: "/srv/app" }), "/home/u"), "box:/srv/app");
  assert.equal(placeLabel({ where: { kind: "remote", target: "box" }, cwd: "/home/u/x" }, "/home/u"), "box:/home/u/x", "a remote path is never tilde'd with the LOCAL home");
});

test("visiblePath writes control characters out instead of breaking the row", () => {
  assert.equal(visiblePath("new\nline\t.txt"), "new\\nline\\t.txt");
  assert.equal(visiblePath("bell\x07"), "bell\\x07");
  assert.equal(visiblePath("ünï 文字.txt"), "ünï 文字.txt");
});

test("loadGitSummary shares a running request, and a plain read joins a running fresh one", async () => {
  const calls: string[] = [];
  const release: (() => void)[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    await new Promise<void>((r) => release.push(r));
    return new Response(JSON.stringify({ state: "none", where: { kind: "local" }, cwd: "/x", checkedAt: 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    const a = loadGitSummary("/s/a.jsonl");
    const b = loadGitSummary("/s/a.jsonl");
    const f = loadGitSummary("/s/b.jsonl", true);
    const g = loadGitSummary("/s/b.jsonl");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 2, JSON.stringify(calls));
    assert.ok(calls.some((u) => u.includes("fresh=1") && u.includes(encodeURIComponent("/s/b.jsonl"))));
    release.forEach((r) => r());
    const [ra, rb, rf, rg] = await Promise.all([a, b, f, g]);
    assert.equal(ra, rb);
    assert.equal(rf, rg);
    loadGitSummary("/s/a.jsonl");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 3, "once settled, the next read is a new request");
    release.forEach((r) => r());
  } finally {
    globalThis.fetch = realFetch;
  }
});
