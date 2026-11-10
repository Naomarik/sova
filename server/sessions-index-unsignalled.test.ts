// Run: pnpm test server/sessions-index-unsignalled.test.ts
// A row that changes with no event of its own (§app.session-list/listing-reuse): a build that keeps
// rows must still rebuild it at the session feed's next comparison, whatever set that comparison off,
// as a build of every row did. Each case: the change, then a comparison set off by another file's
// write (the feed's tracked build), which must show it, equal to a fresh build of every row:
// - a signal going after GUESS_IDLE_MS (a time-driven mark);
// - a coding session's merged mark, git's answer read in the background (build-merged.ts);
// - a context window after the model list changed.
// Time is moved by Date.now.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const root = realpathSync(scratchRoot("sova-unsignalled-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--unsignalled--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const orgs = await import("./orgs");
await import("./org-sessions");
const { closeAllOrgHosts } = await import("./org-engine");
const { seedBuild } = await import("./org-test-fixtures");
const { BUILD_TTL_MS, setBuildReader } = await import("./build-merged");
const { listPhases, listSessions, listSessionsTracked, trackSessionFiles } = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { GUESS_IDLE_MS, updateSignals } = await import("./signals-store");
const { readDecisionSettings, writeDecisionSettings } = await import("./decide-settings");
const { canonicalPath } = await import("./paths");
const { stateRoot } = await import("./state-root");

const tracker = trackSessionFiles();
after(async () => {
  tracker.stop();
  Date.now = realNow;
  await closeAllOrgHosts();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function session(name: string, cwd = "/tmp", more: object[] = []): { id: string; path: string } {
  const id = `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-09-27T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd },
    { type: "message", id: `u${n}`, parentId: null, message: { role: "user", content: `hello from ${name}` } },
    ...more,
  ];
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  // As the folder watch would tell of it (this tracker has no watch).
  tracker.note(path);
  return { id, path };
}
const other = session("the other chat");
type Rows = Awaited<ReturnType<typeof listSessions>>;
const byId = (rows: Rows, id: string) => rows.find((r) => r.id === id);
/** Every row built again. */
const fresh = async () => {
  sessionsChanged();
  return listSessions();
};
/** The feed's comparison, set off by another chat's write: its tracked build, which keeps unchanged rows. */
const compare = async () => {
  appendFileSync(other.path, `${JSON.stringify({ type: "message", id: `o${++n}`, parentId: null, message: { role: "user", content: "more" } })}\n`);
  tracker.note(other.path);
  return listSessionsTracked();
};
/** Stores just written are read through short caches, so a build keeps no row for 2 s after a write:
    date them back past that, so the comparisons below keep every unchanged row. */
const settleStores = () => {
  const t = new Date(realNow() - 10_000);
  for (const f of readdirSync(stateRoot())) if (f.endsWith(".json")) utimesSync(join(stateRoot(), f), t, t);
};
/** Two comparisons: the first is a full build (the tracker's first), the second a kept-rows one. */
const settle = async () => {
  await listSessionsTracked();
  await compare();
};

test("a signal going after GUESS_IDLE_MS shows at the next comparison", async () => {
  const s = session("asked a while ago");
  const d = readDecisionSettings();
  writeDecisionSettings({ ...d, features: { ...d.features, attention: true } });
  updateSignals((data) => {
    data.sessions[s.id] = {
      turnId: "t1",
      replyAt: realNow() - GUESS_IDLE_MS + 3_000,
      at: realNow() - GUESS_IDLE_MS + 4_000,
      provider: "pi",
      model: "m",
      schema: 3,
      answers: { asks_user: { type: "boolean", p: 0.95 }, ask_kind: { type: "choice", choice: "choose-between-options", probabilities: {}, confidence: 0.9 } },
    } as never;
  });
  settleStores();
  await settle();
  assert.ok(byId(await compare(), s.id)?.signals, "the signal shows");
  skew += 4_000;
  const rows = await compare();
  assert.equal(byId(rows, s.id)?.signals, undefined, "gone at the next comparison");
  assert.deepEqual(byId(rows, s.id), byId(await fresh(), s.id));
});

test("a context window after the model list changed shows at the next comparison", async () => {
  const s = session("with a context", "/tmp", [
    { type: "message", id: `a${++n}`, parentId: `u${n}`, timestamp: "2026-09-27T00:01:00.000Z", message: { role: "assistant", provider: "p", model: "m1", content: [{ type: "text", text: "hi" }], stopReason: "stop", usage: { input: 1000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 1005 } } },
  ]);
  let window = 100_000;
  listPhases.window = () => () => window;
  try {
    settleStores();
    await settle();
    assert.equal(byId(await compare(), s.id)?.context?.window, 100_000);
    window = 200_000; // the model list refreshed: no event tells of it
    const rows = await compare();
    assert.equal(byId(rows, s.id)?.context?.window, 200_000, "the new window at the next comparison");
    assert.deepEqual(byId(rows, s.id), byId(await fresh(), s.id));
  } finally {
    listPhases.window = undefined;
  }
});

test("a coding session's merged mark, git's answer, shows at the next comparison after it", async () => {
  const org = await orgs.createOrg({ name: "Unsignalled Co", dir: join(root, "ws") });
  const rootDir = join(root, "proj");
  mkdirSync(rootDir, { recursive: true });
  const project = await orgs.addProject(org.id, { name: "Proj", root: rootDir });
  let merged = false;
  let reads = 0;
  setBuildReader(async () => (reads++, { merged, branch: true }));
  const s = session("coding", rootDir);
  await seedBuild(org.id, project.id, { sessionId: s.id, kind: "coding", worktree: { path: join(root, "wt"), branch: "feat/x", base: "b0", target: "master" } });
  settleStores();
  await settle();
  const until = async (what: string, ok: () => boolean) => {
    const t = realNow();
    while (!ok()) {
      if (realNow() - t > 10_000) assert.fail(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until("git's first answer", () => reads > 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(byId(await compare(), s.id)?.project?.kind, "coding");
  assert.equal(byId(await compare(), s.id)?.project?.finished, undefined, "not merged yet");

  merged = true; // merged outside Sova: nothing tells the list
  skew += BUILD_TTL_MS + 1;
  const before = reads;
  await compare(); // asks git again, in the background, as every build of the row did
  await until("git's next answer", () => reads > before);
  await new Promise((r) => setTimeout(r, 20));
  const rows = await compare();
  assert.equal(byId(rows, s.id)?.project?.finished, true, "merged at the next comparison");
  assert.deepEqual(byId(rows, s.id), byId(await fresh(), s.id));
});
