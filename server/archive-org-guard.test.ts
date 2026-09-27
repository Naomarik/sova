// Run: pnpm exec tsx --test server/archive-org-guard.test.ts. Archiving an empty husk deletes the
// file, except in an attached organization's workspace sessions/: a fresh baton waiting on its
// first link is a husk by shape, and baton.json names its file, so it is archived, never deleted.
// A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-archive-org-guard-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const ordinaryDir = join(root, "agent", "sessions", "--tmp-archive-org-guard--");
mkdirSync(ordinaryDir, { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { archiveSession, idOf } = await import("./sessions-index");
const { isArchived } = await import("./archived-sessions");
const { addWebSession } = await import("./web-sessions");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Guarded", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });

test("archiving an org's empty baton keeps its file; an ordinary empty husk is still deleted", async () => {
  const fresh = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Fresh", goal: "g", mintLink: false });
  const r = await archiveSession(fresh.path, true);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.ok(existsSync(fresh.path), "the baton's file survived archiving");
  assert.equal(isArchived(fresh.sessionId), true, "archived normally, by mark");
  assert.ok(baton.batonById(fresh.sessionId), "baton.json still lists it");

  const id = "01234567-89ab-7cde-8f01-00000000000d";
  const husk = join(ordinaryDir, `2026-09-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(husk, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp" })}\n`);
  addWebSession(id);
  const h = await archiveSession(husk, true);
  assert.ok(h.ok, h.ok ? "" : h.error);
  assert.equal(existsSync(husk), false, "an ordinary husk is deleted on archive, as before");
  assert.equal(isArchived(idOf(husk)), false);
});
