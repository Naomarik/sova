// Run: pnpm exec tsx --test server/cleanup-org-guard.test.ts. Clean Up… never sweeps an attached
// organization's workspace sessions (baton transcripts, project-overseer conversations), in any
// mode, while ordinary sessions still go. A throwaway PI_CODING_AGENT_DIR and workspace in the OS
// temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-cleanup-org-guard-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const ordinaryDir = join(root, "agent", "sessions", "--tmp-cleanup-org-guard--");
mkdirSync(ordinaryDir, { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { cleanupSessions, idOf } = await import("./sessions-index");
const { setArchived } = await import("./archived-sessions");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const age = (path: string, days: number) => {
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(path, t, t);
};
const header = (id: string, cwd: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd });
const user = (text: string) =>
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: text } });
/** A session file in `dir`, a husk unless given a user message, aged `days`. */
function file(dir: string, id: string, cwd: string, days: number, text?: string): string {
  const path = join(dir, `2026-09-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[header(id, cwd), ...(text ? [user(text)] : [])].join("\n")}\n`);
  age(path, days);
  return path;
}

const org = await orgs.createOrg({ name: "Guarded", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const wsDir = orgs.orgDir(org.id);
const wsSessions = join(wsDir, "sessions");

test("age, husks and paths never delete an org workspace session; ordinary sessions still go", async () => {
  // A baton waiting on its first link: no user message yet, so a husk too, and 40 days idle.
  const idle = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Idle", goal: "g", mintLink: false });
  age(idle.path, 40);
  // Any other conversation in the workspace (a project overseer's, say), with a user message.
  const talk = file(wsSessions, "01234567-89ab-7cde-8f01-00000000000a", wsDir, 40, "overseer chat");
  const oldOrdinary = file(ordinaryDir, "01234567-89ab-7cde-8f01-00000000000b", "/tmp", 40, "old");
  const huskOrdinary = file(ordinaryDir, "01234567-89ab-7cde-8f01-00000000000c", "/tmp", 1);
  const guarded = [idle.path, talk];

  // The dry run is the count the dialog shows: it must match what the real run deletes.
  const preview = await cleanupSessions({ mode: "age", minAgeDays: 7, dryRun: true });
  assert.deepEqual(preview.deletedIds, [idOf(oldOrdinary)]);
  const aged = await cleanupSessions({ mode: "age", minAgeDays: 7, dryRun: false });
  assert.deepEqual(aged.deletedIds, [idOf(oldOrdinary)]);
  assert.equal(existsSync(oldOrdinary), false);

  const huskPreview = await cleanupSessions({ mode: "husks", dryRun: true });
  assert.deepEqual(huskPreview.deletedIds, [idOf(huskOrdinary)]);
  const husks = await cleanupSessions({ mode: "husks", dryRun: false });
  assert.deepEqual(husks.deletedIds, [idOf(huskOrdinary)]);
  assert.equal(existsSync(huskOrdinary), false);

  // Even archived and named, an org file is refused, with the reason.
  for (const p of guarded) setArchived(idOf(p), true);
  const named = await cleanupSessions({ mode: "paths", paths: guarded, dryRun: false });
  assert.equal(named.deletedCount, 0);
  assert.deepEqual(named.refused?.map((r) => basename(r.path)), guarded.map((p) => basename(p)));
  assert.ok(named.refused?.every((r) => /organization/i.test(r.reason)));

  for (const p of guarded) assert.ok(existsSync(p), `${p} survived`);
  assert.ok(baton.batonById(idle.sessionId), "baton.json still lists it");
});
