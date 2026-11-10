// Run: pnpm test server/sessions-index-lookup.test.ts
// listedSession / listedSessionAt: one session's row as the list has it, built alone when it can be.
// The rule: for every kind of session (and ids or paths that name none), the answer is the row a
// fresh listing finds, field for field (live presence, group, worker marks, readiness and branches
// joined the same way), and costs no listing unless two files share the id.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-lookup-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-session-lookup--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { listedSession, listedSessionAt, listSessions, listStats } = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { setArchived } = await import("./archived-sessions");
const { setSessionTitle } = await import("./session-titles");
const { setDraft } = await import("./drafts");
const { canonicalPath } = await import("./paths");
const { assignSession, createGroup } = await import("./session-groups");
const { configureReadiness, readinessIdle } = await import("./merge-readiness");

let n = 0;
const uuid = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
/** As pi names them: `<time>_<id>.jsonl` (a label before the id, so two files may share one). */
const fileOf = (name: string, id: string) => canonicalPath(join(sessionsDir, `2026-09-27T00-00-${String(n).padStart(2, "0")}-000Z_${name}_${id}.jsonl`));
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: "/tmp" });
const said = (text: string) => JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, message: { role: "user", content: text } });
function session(id: string, name: string, user = true, more: object[] = []): string {
  const path = fileOf(name, id);
  writeFileSync(path, [header(id), ...(user ? [said(`hello from ${name}`)] : []), ...more.map((e) => JSON.stringify(e))].map((l) => `${l}\n`).join(""));
  return path;
}

test("a lookup by id or path answers what a fresh listing finds, for every kind of session", async () => {
  const plain = uuid();
  const archived = uuid();
  const renamed = uuid();
  const husk = uuid();
  const drafted = uuid();
  const twin = uuid();
  const paths = new Map<string, string>();
  paths.set(plain, session(plain, "plain"));
  paths.set(archived, session(archived, "archived"));
  paths.set(renamed, session(renamed, "renamed"));
  paths.set(husk, session(husk, "husk", false));
  paths.set(drafted, session(drafted, "drafted", false));
  const twinA = session(twin, "twin-a");
  const twinB = session(twin, "twin-b");
  const gone = uuid();
  paths.set(gone, session(gone, "gone"));
  // What the list joins in from elsewhere: a group, a live record, the worker scan, readiness and branches.
  const grouped = uuid();
  paths.set(grouped, session(grouped, "grouped"));
  const group = createGroup("Lookups");
  assert.ok(group.ok);
  assignSession(grouped, group.group.id);
  const live = uuid();
  paths.set(live, session(live, "live"));
  writeFileSync(join(liveDir, "p-lookup.json"), JSON.stringify({ session: { pid: process.ppid, sessionFile: paths.get(live), mode: "tui" }, presence: { status: "busy", activity: { state: "working", since: 1 }, workerCounts: { working: 1, total: 2 } } }));
  const worker = uuid();
  paths.set(worker, session(worker, "worker"));
  const owner = uuid();
  paths.set(owner, session(owner, "owner", true, [{ type: "custom_message", customType: "subagent-complete", display: true, content: `### ag_01 (the worker) — done\nSession: ${worker}\nModel: m\nreport`, id: "w1", parentId: null }]));
  const tracking = uuid();
  const tree = { path: "/wt/lookup", branch: "feat/lookup", base: "b0", baseBranch: "master", status: "active", session: tracking, how: "created", at: 1 };
  paths.set(
    tracking,
    session(tracking, "tracking", true, [
      { type: "custom", customType: "worktrees", data: { version: 1, trees: [tree] }, timestamp: "2026-09-29T15:36:00.000Z", id: "t1", parentId: null },
      { type: "message", id: "t2", parentId: "t1", timestamp: "2026-09-29T19:44:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done; shall I merge?" }], stopReason: "stop" } },
    ]),
  );
  configureReadiness({
    served: async () => true,
    insights: { treeStatus: async () => ({ path: "/wt/lookup", source: "session", exists: true, branch: "feat/lookup", base: "master", merged: "no", ahead: 1, behind: 0, dirty: false, head: "h1", subjects: ["lookup"] }) },
    git: async () => ({ code: 0, stdout: "", stderr: "" }),
    asksUser: () => undefined,
  });
  setArchived(archived, true);
  setSessionTitle(renamed, "A name of its own");
  setDraft(drafted, "half a thought");
  sessionsChanged();
  await listSessions();
  await readinessIdle();
  sessionsChanged();
  const joined = await listSessions();
  const row = (id: string) => joined.find((s) => s.id === id);
  // The comparison below covers these only if the list has them.
  assert.equal(row(grouped)?.groupId, group.group.id);
  assert.equal(row(live)?.live?.pid, process.ppid);
  assert.equal(row(live)?.activity?.state, "working");
  assert.equal(row(worker)?.workerSession, true);
  assert.equal(row(worker)?.workerOf?.id, owner);
  assert.ok(row(tracking)?.readiness, "the tracking chat's row has its readiness");
  assert.equal(row(tracking)?.branches?.[0]?.branch, "feat/lookup", "and its branches");

  // After that listing: one file is removed, one is new, and a store write renames a listed one.
  rmSync(paths.get(gone)!);
  const late = uuid();
  paths.set(late, session(late, "late"));
  setSessionTitle(plain, "Renamed since");

  // `late` first: no listing has read it yet, so only its file name finds it.
  const ids = [late, plain, archived, renamed, husk, drafted, twin, gone, grouped, live, worker, owner, tracking, uuid()];
  for (const id of ids) {
    sessionsChanged();
    const got = await listedSession(id);
    sessionsChanged();
    const want = (await listSessions()).find((s) => s.id === id);
    assert.deepEqual(got, want, `by id: ${id}`);
  }
  for (const path of [...paths.values(), twinA, twinB, join(sessionsDir, "none.jsonl"), join(sessionsDir, "x.txt")]) {
    sessionsChanged();
    const got = await listedSessionAt(path);
    sessionsChanged();
    const want = (await listSessions()).find((s) => s.path === path);
    assert.deepEqual(got, want, `by path: ${path}`);
  }
  assert.equal((await listedSession(plain))?.title, "Renamed since", "a store write shows in the next lookup");
  assert.equal(await listedSession(husk), undefined, "a husk is left out, as the list leaves it out");
  assert.equal((await listedSession(drafted))?.hasDraft, true, "a husk with a draft is listed, with its draft");
});

test("a lookup builds no listing, whether or not a listing has read the file", async () => {
  const id = uuid();
  const path = session(id, "cheap");
  sessionsChanged();
  await listSessions();
  for (const ask of [() => listedSession(id), () => listedSessionAt(path)]) {
    sessionsChanged();
    const before = listStats.builds;
    assert.equal((await ask())?.id, id);
    assert.equal(listStats.builds, before, "no listing built");
  }
  // A file no listing has read yet: found by the id in its name, still with no listing.
  const fresh = uuid();
  session(fresh, "fresh");
  sessionsChanged();
  const before = listStats.builds;
  assert.equal((await listedSession(fresh))?.id, fresh);
  assert.equal(listStats.builds, before, "a new file is found by its name, with no listing");
  // Two files sharing an id: only a listing knows which one it shows.
  const twin = uuid();
  session(twin, "twin-x");
  session(twin, "twin-y");
  sessionsChanged();
  await listSessions();
  sessionsChanged();
  const before2 = listStats.builds;
  await listedSession(twin);
  assert.equal(listStats.builds, before2 + 1, "a shared id takes a listing");
});
