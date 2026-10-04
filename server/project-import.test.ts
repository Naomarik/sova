// Run: pnpm exec tsx --test server/project-import.test.ts. Importing a standalone project into an org
// (§app.projects/import), in process: the refusals that change nothing, the confirm, then the move itself
// (files byte for byte, the org's engine taking the sessions in, the placement, the workspace commit, the
// standalone dir set aside) and a restart after it. The route's guards (peer, Overseer) too. A throwaway
// PI_CODING_AGENT_DIR, workspace and project repos in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-import-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(root, "agent", "extensions"));

const { buildWorld, stateOf } = await import("./project-import-child");
const { importProject } = await import("./project-import");
const { registryEntry, markImporting } = await import("./projects/registry");
const { ceilingOf } = await import("./projects/contributions");
const { closeAllOrgHosts, hostOf } = await import("./org-engine");
const { ensureProjectOverseer } = await import("./project-overseer");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { registerOrgRoutes } = await import("./org-routes");
const { RELAYED_HEADER } = await import("./mesh/proxy");
const { OVERSEER_SENDER_HEADER } = await import("./overseer-sender");
const { OrgError } = await import("./org-error");

const w = await buildWorld(root);
after(async () => {
  await disposeAllChats();
  await settled(w.ws);
  await closeAllOrgHosts();
});

const refusal = async (p: Promise<unknown>): Promise<{ message: string; status: number; code?: string }> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof OrgError) return { message: err.message, status: err.status, ...(err.code ? { code: err.code } : {}) };
    throw err;
  }
  throw new Error("not refused");
};

test("refusals change nothing: unknown, without confirm, being imported, a placed project, a file the org holds otherwise", async () => {
  const before = JSON.stringify(registryEntry(w.soloId));
  assert.deepEqual(await refusal(importProject(w.orgId, "prj_zzzzzzzz", true)), { message: "Unknown project", status: 404 });
  const c = await refusal(importProject(w.orgId, w.soloId, false));
  assert.equal(c.status, 409);
  assert.equal(c.code, "confirm");
  assert.equal(c.message, "Importing Solo One commits its history (overseer conversations, builds, costs) to Acme's workspace repo. It can't be undone.");
  assert.equal(JSON.stringify(registryEntry(w.soloId)), before, "no mark");
  assert.equal(hostOf(w.soloId).data(`project/${w.soloId}`)?.name, "Solo One", "its engine still open");
  assert.deepEqual(await refusal(importProject(w.orgId, w.otherId, true)), { message: "Other is already in Acme.", status: 409 });
  markImporting(w.soloId, { org: w.orgId, at: "2026-01-01T00:00:00.000Z" });
  assert.equal((await refusal(importProject(w.orgId, w.soloId, true))).message, `${w.soloId} is already being imported.`);
  markImporting(w.soloId, null);
  const theirs = join(w.ws, "projects", w.soloId, "costs.json");
  mkdirSync(join(theirs, ".."), { recursive: true });
  writeFileSync(theirs, "{}\n");
  assert.deepEqual(await refusal(importProject(w.orgId, w.soloId, true)), { message: `Solo One can't be imported: projects/${w.soloId}/costs.json already exists in Acme with other content.`, status: 409 });
  rmSync(join(w.ws, "projects", w.soloId), { recursive: true });
  assert.equal(JSON.stringify(registryEntry(w.soloId)), before);
});

test("the route: a peer's call and the Overseer's are refused; without confirm the sentence comes back with its code", async () => {
  const app = new Hono();
  registerOrgRoutes(app);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api/orgs/${w.orgId}/projects/import`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const peer = await post({ projectId: w.soloId, confirm: true }, { [RELAYED_HEADER]: "peer" });
  assert.equal(peer.status, 403, await peer.clone().text());
  assert.equal((await post({ projectId: w.soloId, confirm: true }, { [OVERSEER_SENDER_HEADER]: "ov-1" })).status, 403);
  const r = await post({ projectId: w.soloId });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { code?: string }).code, "confirm");
  assert.ok(registryEntry(w.soloId) && !registryEntry(w.soloId)!.importing);
});

test("the import moves everything byte for byte, places it, commits it and sets the standalone dir aside", async () => {
  const conv = readFileSync(w.overseer.path);
  const convName = w.overseer.path.split("/").pop()!;
  const rowsBefore = hostOf(w.soloId).log.rows().filter((r) => r.project === w.soloId).length;
  await importProject(w.orgId, w.soloId, true);
  await settled(w.ws);
  const s = (await stateOf(w)) as Record<string, any>;
  assert.deepEqual(s.registry, [], "the entry is dropped");
  assert.equal(s.engine, w.orgId, "the org's engine holds it");
  assert.equal(s.otherEngine, w.orgId);
  assert.equal(s.placement?.placedVia ?? s.placement?.via, "import");
  assert.deepEqual(s.space, { kind: "org", orgId: w.orgId, orgName: "Acme" });
  assert.equal(s.projectData?.name, "Solo One");
  assert.ok(s.watch, "its watch came along");
  assert.ok(s.soloRows >= rowsBefore, `its Activity rows read in the org (${s.soloRows} ≥ ${rowsBefore})`);
  assert.equal(s.dupRows, 0);
  assert.ok(s.sessions.includes(convName), "the overseer conversation is in the workspace");
  assert.ok(readFileSync(join(w.ws, "sessions", convName)).equals(conv), "byte for byte");
  assert.equal(s.costs, true);
  assert.equal(s.aside.length, 1, "the standalone dir is set aside");
  assert.ok(existsSync(join(root, "agent", "sova", "projects", ".imported", s.aside[0], "host-local")), "its host-local charts with it");
  assert.ok(!existsSync(w.soloDir));
  assert.ok(!existsSync(join(root, "agent", "sova", "statecharts", w.soloId)));
  assert.equal(s.commits[0], "Imported project Solo One");
  assert.deepEqual(s.problems, []);
  // the log segments landed beside the org's under their imported names
  assert.ok(readdirSync(join(w.ws, "statecharts", "log")).some((f) => f.endsWith(`.imported-${w.soloId}.jsonl`)));
  // the org's ceiling now applies: no active person, L0
  assert.equal(ceilingOf(w.orgId, w.soloId)?.autonomy, "L0");
  assert.equal((hostOf(w.orgId).data(`watch/${w.soloId}`)?.ceiling as { autonomy?: string } | undefined)?.autonomy, "L0", "the watch heard it");
  // the conversation goes on at its new path
  const again = await ensureProjectOverseer(w.soloId);
  assert.equal(again.id, w.overseer.id);
  assert.equal(again.path, join(w.ws, "sessions", convName));
  // a second import is refused: it is in an org now
  assert.equal((await refusal(importProject(w.orgId, w.soloId, true))).message, "Solo One is already in Acme.");
});

test("a restart after the import opens it in the org with nothing lost", async () => {
  const before = (await stateOf(w)) as Record<string, any>;
  await disposeAllChats();
  await closeAllOrgHosts();
  const { resetSpacesForTest, openRegisteredProjects } = await import("./projects/spaces");
  resetSpacesForTest();
  const { openAttachedOrgs } = await import("./orgs");
  const { rollForwardCopies, finishImports } = await import("./project-import");
  rollForwardCopies();
  await openAttachedOrgs();
  await openRegisteredProjects();
  await finishImports();
  const s = (await stateOf(w)) as Record<string, any>;
  assert.equal(s.engine, w.orgId);
  assert.deepEqual(s.problems, []);
  assert.equal(s.soloRows >= before.soloRows, true);
  assert.equal(s.dupRows, 0);
  assert.deepEqual(s.commits, before.commits, "nothing more to commit");
});
