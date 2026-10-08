// Run: pnpm test -- server/project-files-tool.test.ts. The project overseer's sova_files
// (§app.project-overseer/files): list, copy into a coding session's worktree (incoming/, excluded
// from git, refused outside it, under a protected root or where its sandbox says no), delete in
// the operator's turn only; and a download's headers (§app.organizations/files-card). A fake host,
// a real git repository under a scratch root, a throwaway PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, test } from "node:test";
import type { Autonomy, CodingWorktree } from "../shared/project-overseer";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-files-tool-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));
const files = await import("./project-files");
const { projectOverseerTools } = await import("./project-overseer-tools");
const { setFileCopyGuards } = await import("./project-files-tool");
const { attachmentDisposition, downloadHeaders } = await import("./project-files-routes");
const { defaultPoSettings, effectiveAutonomy, projectOverseerPaths } = await import("./project-overseer-store");
const { uncommitted } = await import("./project-worktrees");
const PID = "prj_bbbbbbbb";
files.setLedgerPathForTests((pid) => join(root, "ws", pid, "files.jsonl"));

// A repository with one commit and a coding session's worktree beside it.
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const repo = join(root, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "commit", "-q", "--allow-empty", "-m", "first");
const wt = join(root, "repo-wt");
git(repo, "worktree", "add", "-q", "-b", "sova/build-abc123", wt);

const build = (over: Partial<CodingWorktree> = {}): CodingWorktree =>
  ({ sessionId: "c1", path: "/s/c1.jsonl", title: "Import the dump", startedBy: "overseer", branch: "sova/build-abc123", worktree: wt, base: null, target: "main", state: "open", merged: false, ahead: 0, dirty: false, running: false, workers: 0, ...over }) as CodingWorktree;

function tools(opts: { attended?: boolean; autonomy?: Autonomy; builds?: CodingWorktree[] } = {}) {
  const settings = { ...defaultPoSettings(), autonomy: opts.autonomy ?? "L1" };
  const host = {
    paths: projectOverseerPaths(PID, join(root, "ws")),
    project: () => ({ id: PID, name: "Portal", root: repo, archived: false, createdAt: "" }),
    settings: () => settings,
    effective: () => effectiveAutonomy(settings, null),
    attended: () => opts.attended ?? false,
    overseerId: () => "po-1",
    engine: () => PID,
    gaps: () => null,
    placed: () => true,
    contributed: () => [],
    sessions: async () => [],
    builds: async () => opts.builds ?? [build()],
  } as never;
  const all = projectOverseerTools(host, () => ({ redact: (t: string) => t, redactDeep: <T>(v: T) => v }) as never);
  const t = all.find((x) => x.name === "sova_files")!;
  return (params: Record<string, unknown>) => t.execute("call-1", params, undefined, undefined, undefined).then((r) => (r.content[0] as { text: string }).text);
}

/** A received file, as a gathering's message leaves it. */
async function received(name: string, data: string): Promise<string> {
  const s = await files.stageFile({ projectId: PID, sessionId: "s-one", personId: "p_alex", name, type: "application/json", body: Readable.from([Buffer.from(data)]), maxBytes: 1024 * 1024 });
  files.receiveFiles(PID, files.takeStagedFiles(PID, "s-one", "p_alex", [s.id]));
  return s.id;
}

describe("sova_files", () => {
  test("list: each file's id, name, sender, gathering, time, size, kind and status; none says so", async () => {
    assert.equal(await tools()({ op: "list" }), "No files yet. People send them in a gathering session with files on.");
    const id = await received("dump.json", '{"records": [1]}');
    const line = await tools()({ op: "list" });
    assert.match(line, new RegExp(`^- ${id} · dump\\.json · from Someone · in "a gathering no longer listed" · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC · 16 bytes · JSON · Received$`));
    files.confirmFile(PID, "s-one", id);
    assert.match(await tools()({ op: "list" }), / · Confirmed$/);
  });

  test("copy: L3 outside the operator's turn; into incoming/, a taken name deduped, excluded from git so nothing is uncommitted", async () => {
    const id = await received("export.json", '{"a": 1}');
    await assert.rejects(tools({ autonomy: "L1" })({ op: "copy", id, session: "c1" }), /needs L3 in a turn the operator didn't start/);
    const out = await tools({ autonomy: "L3" })({ op: "copy", id, session: "sova://s/c1" });
    assert.match(out, /^Copied to incoming\/export\.json in \[Import the dump\]\(sova:\/\/s\/c1\)'s worktree/);
    assert.equal(readFileSync(join(wt, "incoming", "export.json"), "utf8"), '{"a": 1}');
    assert.match(await tools({ attended: true })({ op: "copy", id, session: "c1" }), /incoming\/export \(2\)\.json/);
    const exclude = readFileSync(git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim(), "utf8");
    assert.equal(exclude.split("\n").filter((l) => l === "/incoming/").length, 1, "added once");
    assert.deepEqual(await uncommitted(async (args, cwd) => {
      try {
        return { code: 0, stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), stderr: "" };
      } catch (e) {
        return { code: 1, stdout: "", stderr: String(e) };
      }
    }, wt), [], "Merge Branch and Remove Worktree aren't blocked");
  });

  test("copy refusals: an unknown session, one with no worktree here, a linked incoming, a protected root, the session's sandbox", async () => {
    const id = await received("x.json", "{}");
    const run = (b: CodingWorktree[]) => tools({ attended: true, builds: b });
    await assert.rejects(run([build()])({ op: "copy", id, session: "nope" }), /No coding session "nope" in this project/);
    await assert.rejects(run([build({ state: "root", worktree: null })])({ op: "copy", id, session: "c1" }), /no worktree of its own on this host/);
    await assert.rejects(run([build({ state: "removed" })])({ op: "copy", id, session: "c1" }), /no worktree of its own/);
    await assert.rejects(run([build()])({ op: "copy", id: "f_AAAAAAAAAAAAAAAA", session: "c1" }), /No file f_AAAAAAAAAAAAAAAA/);
    // incoming is a link out of the worktree
    const wt2 = join(root, "repo-wt2");
    git(repo, "worktree", "add", "-q", "-b", "sova/two-abc123", wt2);
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(wt2, "incoming"));
    await assert.rejects(run([build({ worktree: wt2 })])({ op: "copy", id, session: "c1" }), /incoming in that worktree is a link/);
    assert.equal(existsSync(join(root, "outside", "x.json")), false);
    // a protected root (Sova's own state), and the session's sandbox
    setFileCopyGuards(async () => undefined, () => [wt]);
    await assert.rejects(run([build()])({ op: "copy", id, session: "c1" }), /Sova's own: nothing was copied/);
    setFileCopyGuards(async (sid, p) => (sid === "c1" ? `${p} is outside the sandbox's writable roots` : undefined), () => []);
    await assert.rejects(run([build()])({ op: "copy", id, session: "c1" }), /sandbox would refuse the write \(.*outside the sandbox's writable roots\)/);
    setFileCopyGuards(async () => undefined, () => []);
  });

  test("delete: only in the operator's turn; the bytes go and the list drops it", async () => {
    const id = await received("gone.json", "{}");
    await assert.rejects(tools({ autonomy: "L3" })({ op: "delete", id }), /Deleting a file is the operator's/);
    assert.match(await tools({ attended: true })({ op: "delete", id }), /^Deleted gone\.json/);
    assert.equal(files.fileOf(PID, id), null);
    assert.doesNotMatch(await tools()({ op: "list" }), /gone\.json/);
  });
});

describe("the download", () => {
  test("an attachment, never rendered, sniffed or run", () => {
    const h = downloadHeaders("Alex's dump (1).json", 42);
    assert.equal(h["Content-Type"], "application/octet-stream");
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(h["Content-Security-Policy"], "default-src 'none'; sandbox");
    assert.equal(h["Cache-Control"], "no-store");
    assert.equal(h["Content-Length"], "42");
    assert.equal(attachmentDisposition("Alex's dump (1).json"), `attachment; filename="Alex's dump (1).json"; filename*=UTF-8''Alex%27s%20dump%20%281%29.json`);
    assert.equal(attachmentDisposition('a"b\\é.txt'), `attachment; filename="a_b__.txt"; filename*=UTF-8''a%22b%5C%C3%A9.txt`);
  });
});
