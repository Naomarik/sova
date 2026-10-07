// Run: npx tsx --test server/git-summary.test.ts
// Real git against throwaway repositories in the OS temp dir, and a throwaway PI_CODING_AGENT_DIR:
// ~/.pi is never read or written. The remote transport is the real one (targets.runOnTarget → the
// argv builder → runArgv) with a `docker` PATH shim that runs the exec'd argv on this machine, as
// server/targets.test.ts does — so a remote session's read crosses the same quoting it would in
// production, minus the network.
// Real repositories read through the real git script and process groups: git-summary.integration.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { GitRepoSummary, GitSummary } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-git-test-agent-")));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sova-git-test-")));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

mkdirSync(join(scratch, "bin"));
writeFileSync(join(scratch, "bin", "docker"), '#!/bin/sh\n[ "$1 $2" = "exec -i" ] || exit 99\nshift 3\nexec "$@"\n');
chmodSync(join(scratch, "bin", "docker"), 0o755);
process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH}`;
writeFileSync(join(agentDir, "targets.json"), JSON.stringify({ version: 1, targets: [{ name: "here", kind: "docker", docker: { container: "box" } }] }));
// Commits in these repos must not depend on the user's git config.
process.env.GIT_CONFIG_GLOBAL = join(scratch, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");

const G = await import("./git-summary");
const T = await import("./targets");

beforeEach(() => G.clearGitCache());

let n = 0;
/** A fresh folder under scratch. */
const fresh = (name = "repo") => {
  const dir = join(scratch, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (dir: string, rel: string, body: string | Buffer) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
/** A repository with one commit holding `files`. */
function repo(files: Record<string, string> = { "a.txt": "1\n2\n3\n" }, subject = "first"): string {
  const dir = fresh();
  git(dir, "init", "-q");
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", subject);
  return dir;
}
/** The summary of a local cwd, read through the real script. */
const read = (cwd: string, deps: Parameters<typeof G.getGitSummary>[2] = {}) =>
  G.getGitSummary("/sessions/x.jsonl", {}, { storedCwd: async () => cwd, ...deps });
function asRepo(s: GitSummary): GitRepoSummary {
  assert.equal(s.state, "repo", JSON.stringify(s));
  return s as GitRepoSummary;
}

// ---------------------------------------------------------------------------
// real repositories

test("a subject is kept as git wrote it, and a cut log loses only the commit it cut", () => {
  const sha = "a".repeat(40);
  const record = (subject: string, at = 1_700_000_000) => `${sha}\0${at}\0${subject}\n`;
  const whole = G.parseLog(record("one") + record("two — ünï \tcode"), true);
  assert.deepEqual(whole.map((c) => c.subject), ["one", "two — ünï \tcode"], "the subject is never folded, trimmed or relabelled");
  assert.equal(whole[0]?.at, 1_700_000_000_000);
  // Cut by the section's byte cap: the half-record goes, the whole ones before it stay.
  const cut = G.parseLog(record("one") + record("two") + `${sha}\0${1_700_000_000}\0half`, false);
  assert.deepEqual(cut.map((c) => c.subject), ["one", "two"]);
  // Nothing to read: an empty section, or git's refusal, is an empty list rather than a throw.
  assert.deepEqual(G.parseLog("", false), []);
  assert.deepEqual(G.parseLog("\n", true), []);
});

// ---------------------------------------------------------------------------
// which folder: remote

// ---------------------------------------------------------------------------
// cache and in-flight sharing

// ---------------------------------------------------------------------------
// the framing and parsers, including every way a section can be cut

const nonce = "00112233445566778899aabb";
const mk = (name: string, code: string | number) => `\0@@${nonce}:${name}:${code}@@\0`;

test("parseSections: noise before begin is ignored, a forged marker with another nonce is data, a cut section has no code", () => {
  const forged = `\0@@deadbeefdeadbeef:status:0@@\0`;
  const out = `motd ${mk("top", "-")}${mk("begin", 0)}${mk("top", "-")}/r${mk("top", 0)}${mk("status", "-")}1 .M N... 100644 100644 100644 a b x${forged}y\0${mk("status", 0)}${mk("log", "-")}abc\0`;
  const { begun, sections } = G.parseSections(out, nonce);
  assert.equal(begun, true);
  assert.deepEqual(sections.get("top"), { out: "/r", code: 0 });
  assert.equal(sections.get("status")!.code, 0);
  assert.ok(sections.get("status")!.out.includes(forged), "another nonce's marker is part of the data");
  assert.deepEqual(sections.get("log"), { out: "abc\0", code: null });
  assert.equal(G.parseSections("no markers at all", nonce).begun, false);
});

test("parseSections: a section cut by its cap is followed directly by the next one's opening marker", () => {
  const out = `${mk("begin", 0)}${mk("status", "-")}? a\0? b\0? c${mk("log", "-")}H\0${"1"}\0s\n${mk("log", 0)}`;
  const { sections } = G.parseSections(out, nonce);
  assert.equal(sections.get("status")!.code, null);
  assert.equal(sections.get("log")!.code, 0);
  assert.deepEqual(G.parseStatusV2(sections.get("status")!.out, false).entries.map((e) => e.path), ["a", "b"], "the half record goes");
});

test("parseStatusV2: headers, all record types, and a rename pair cut in two", () => {
  const whole = [
    "# branch.oid abc",
    "# branch.head feature/x y",
    "# branch.upstream origin/feature/x y",
    "# branch.ab +3 -4",
    "1 M. N... 100644 100644 100644 h1 h2 file with spaces",
    "2 R. N... 100644 100644 100644 h1 h2 R100 to name",
    "from name",
    "1 .M SC.. 160000 160000 160000 h1 h2 sub",
    "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict",
    "? untracked",
    "",
  ].join("\0");
  const r = G.parseStatusV2(whole, true);
  assert.equal(r.oid, "abc");
  assert.equal(r.branch, "feature/x y");
  assert.equal(r.upstream, "origin/feature/x y");
  assert.deepEqual(r.ab, { ahead: 3, behind: 4 });
  assert.deepEqual(r.entries, [
    { path: "file with spaces", kind: "tracked", staged: "modified" },
    { path: "to name", kind: "tracked", from: "from name", staged: "renamed" },
    { path: "sub", kind: "tracked", unstaged: "modified", submodule: true },
    { path: "conflict", kind: "conflicted" },
    { path: "untracked", kind: "untracked" },
  ]);
  const cut = ["# branch.oid (initial)", "# branch.head (detached)", "2 R. N... 100644 100644 100644 h1 h2 R100 to", "fro"].join("\0");
  const c = G.parseStatusV2(cut, false);
  assert.equal(c.oid, null);
  assert.equal(c.branch, null);
  assert.deepEqual(c.entries, [], "a rename whose source was cut off is not reported half-read");
});

test("parseNumstat: plain, binary, renames keyed by the new path, and a cut rename", () => {
  const m = G.parseNumstat(["3\t1\ta b.txt", "-\t-\timg.png", "2\t0\t", "old", "new", ""].join("\0"), true);
  assert.deepEqual([...m], [["a b.txt", { added: 3, removed: 1 }], ["img.png", "binary"], ["new", { added: 2, removed: 0 }]]);
  assert.deepEqual([...G.parseNumstat(["1\t1\tx", "2\t0\t", "old", "ne"].join("\0"), false)], [["x", { added: 1, removed: 1 }]]);
});

test("summarize: a cut status is partial and never clean; a cut count is partial; timeouts and refusals are words", () => {
  const place = { where: { kind: "local" as const }, cwd: "/r" };
  const sec = (o: Record<string, [string, number | null]>) => new Map(Object.entries(o).map(([k, [out, code]]) => [k, { out, code }]));
  const cut = G.summarize(sec({ top: ["/r", 0], status: ["# branch.oid a\0# branch.head main\0", null], numstat: ["", 0] }), place, 0);
  assert.equal(cut.state, "repo");
  assert.equal((cut as GitRepoSummary).statusPartial, true);
  assert.equal((cut as GitRepoSummary).clean, false, "nothing listed is not clean when the list was cut");
  const lines = G.summarize(sec({ top: ["/r", 0], status: ["", 0], numstat: ["1\t0\ta\0", null] }), place, 0) as GitRepoSummary;
  assert.equal(lines.lines, "partial");
  const slow = G.summarize(sec({ top: ["/r", 0], status: ["", 137] }), place, 0);
  assert.match((slow as { reason: string }).reason, /took too long/);
  const never = G.summarize(sec({ top: ["/r", 0], status: ["", 0], numstat: ["", 137] }), place, 0) as GitRepoSummary;
  assert.equal(never.lines, "timeout");
  const dubious = G.summarize(sec({ toperr: ["fatal: detected dubious ownership in repository at '/r'", 128] }), place, 0);
  assert.match((dubious as { reason: string }).reason, /detected dubious ownership/);
  assert.equal(G.summarize(sec({ toperr: ["fatal: not a git repository (or any of the parent directories): .git", 128] }), place, 0).state, "none");
  assert.match((G.summarize(sec({ toperr: ["", 137] }), place, 0) as { reason: string }).reason, /took too long/);
  // A root cut by its cap is never guessed at.
  const cutRoot = G.summarize(sec({ top: ["/very/long/ro", null], status: ["", 0] }), place, 0);
  assert.equal(cutRoot.state, "unavailable");
  assert.match((cutRoot as { reason: string }).reason, /cut short/);
  assert.match((G.summarize(sec({ nogit: ["", 127] }), { where: { kind: "remote", target: "box" }, cwd: "/r" }, 0) as { reason: string }).reason, /isn't installed on box/);
});

test("the file list is capped; filesTotal and the tallies still count everything", () => {
  const recs = Array.from({ length: G.MAX_GIT_FILES + 7 }, (_, i) => `? f${String(i).padStart(4, "0")}`);
  const s = G.summarize(new Map([["top", { out: "/r", code: 0 }], ["status", { out: `${recs.join("\0")}\0`, code: 0 }], ["numstat", { out: "", code: 0 }]]), { where: { kind: "local" }, cwd: "/r" }, 0) as GitRepoSummary;
  assert.equal(s.files.length, G.MAX_GIT_FILES);
  assert.equal(s.filesTotal, G.MAX_GIT_FILES + 7);
  assert.equal(s.counts.untracked, G.MAX_GIT_FILES + 7);
});

test("ordinary failures are answers, never throws: a header that can't be read, seams that throw", async () => {
  const missing = await G.getGitSummary(join(scratch, "no-such-session.jsonl"));
  assert.equal(missing.state, "unavailable");
  const header = await G.getGitSummary("/s.jsonl", {}, { storedCwd: async () => { throw new Error("EIO"); } });
  assert.equal(header.state, "unavailable");
  const local = await read(fresh("throws"), { runLocal: async () => { throw new Error("spawn sh ENOENT"); } });
  assert.match((local as { reason: string }).reason, /spawn sh ENOENT/);
  const remote = await G.getGitSummary("/s.jsonl", {}, { storedCwd: async () => T.targetDir("here", "/x"), runRemote: async () => { throw new Error("boom"); } });
  assert.equal(remote.state, "unavailable");
  assert.match((remote as { reason: string }).reason, /on here: boom/);
});

test("gitScript refuses a nonce that could carry shell code", () => {
  assert.throws(() => G.gitScript("abc; rm -rf /"));
});

// ---------------------------------------------------------------------------
// runArgv now decodes once: a character split across two chunks survives
