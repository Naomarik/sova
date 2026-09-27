// Run: pnpm exec tsx --test server/owner-updates.test.ts. §app.owner-page/news: the updates store
// (append, withdraw, fold, refusals), its operator routes, and the project overseer's
// sova_owner_update as its runtime builds it: posted at a milestone, one a day unattended,
// "requested" only when the operator asked, and refused when it repeats the About text, the
// overseer's notes, a goal, a profile or a contact. A throwaway PI_CODING_AGENT_DIR (with this
// tree's pi-config extensions linked in) in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ProjectUpdate } from "../shared/owner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-updates-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const updates = await import("./project-updates");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { writeNotes } = await import("./overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate Archery", dir: join(root, "ws") });
mkdirSync(join(root, "a"));
mkdirSync(join(root, "b"));
const pa = orgs.addProject(org.id, { name: "Booking site", root: join(root, "a") });
const pb = orgs.addProject(org.id, { name: "Payroll", root: join(root, "b") });
const alp = orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Director" });
const kim = orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach", voice: "Warm and patient, likes examples", contact: { email: "kim.lee@example.test" } });

const app = new Hono();
registerOrgRoutes(app);

describe("the updates store", () => {
  test("append, fold newest first, withdraw (stays in the file), refusals", async () => {
    const a = updates.appendUpdate(org.id, pb.id, { text: "  First.  ", milestone: "decided", by: "overseer" }, Date.parse("2026-09-01T10:00:00Z"));
    const b = updates.appendUpdate(org.id, pb.id, { text: "Second.", milestone: "built", by: "overseer" }, Date.parse("2026-09-02T10:00:00Z"));
    assert.equal(a.text, "First.");
    assert.deepEqual(updates.readUpdates(org.id, pb.id).map((u) => u.id), [b.id, a.id]);
    assert.throws(() => updates.appendUpdate(org.id, pb.id, { text: " ", milestone: "decided", by: "overseer" }), /Write the update first/);
    assert.throws(() => updates.appendUpdate(org.id, pb.id, { text: "x".repeat(1201), milestone: "decided", by: "overseer" }), /at most 1200/);
    assert.throws(() => updates.appendUpdate(org.id, pb.id, { text: "ok", milestone: "shipped", by: "overseer" }), /milestone must be one of/);
    const r = await app.request(`/api/orgs/${org.id}/projects/${pb.id}/updates/${a.id}/withdraw`, { method: "POST" });
    assert.equal(r.status, 200);
    const after = (await r.json()) as ProjectUpdate[];
    assert.ok(after.find((u) => u.id === a.id)!.withdrawnAt);
    assert.deepEqual(updates.publishedUpdates(org.id, pb.id).map((u) => u.id), [b.id]);
    assert.equal((await app.request(`/api/orgs/${org.id}/projects/${pb.id}/updates/${a.id}/withdraw`, { method: "POST" })).status, 409);
    assert.equal((await app.request(`/api/orgs/${org.id}/projects/prj_nope0000/updates`)).status, 404);
    const file = readFileSync(join(orgs.orgDir(org.id), "projects", pb.id, "updates.jsonl"), "utf8");
    assert.match(file, /"kind":"withdraw"/);
    assert.match(file, /First\./, "a withdrawn post stays in the workspace history");
  });

  test("path segments are never anything but an id", () => {
    assert.throws(() => updates.readUpdates(org.id, "../x"), /Unknown project/);
  });
});

describe("sova_owner_update, as the project overseer's runtime builds it", async () => {
  orgs.setOrgOwner(org.id, alp.id);
  orgs.patchOrg(org.id, { about: "They are selling the academy next spring and must not hear of it." });
  await po.ensureProjectOverseer(org.id, pa.id);
  writeNotes("Kim tends to overpromise on delivery dates, check with Bob.\n", store.projectOverseerPaths(org.id, pa.id).notes);
  baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Hours", goal: "Find out whether Kim will accept weekend shifts quietly", mintLink: false });
  const run = (params: Record<string, unknown>) => po.toolsForTest(org.id, pa.id).find((t) => t.name === "sova_owner_update")!.execute("t1", params as never, undefined, undefined, undefined as never);

  test("each private source refuses the post, named, never quoted", async () => {
    for (const [text, what] of [
      ["Good news: they are selling the academy next spring.", "About this organization"],
      ["Note that Kim tends to overpromise on delivery dates.", "your notes"],
      ["We wanted to find out whether Kim will accept weekend shifts.", "a conversation's goal or briefing"],
      ["Kim is warm and patient, likes examples.", "a person's profile"],
      ["Write to kim.lee@example.test for details.", "a person's contact details"],
    ] as const) {
      await assert.rejects(() => run({ milestone: "decided", text }), (err: Error) => err.message.includes(`repeats ${what}`) && !err.message.includes(text), text);
    }
    assert.equal(updates.readUpdates(org.id, pa.id).length, 0, "nothing was posted");
  });

  test("a milestone posts (unattended); a second the same day is refused; requested is refused unattended", async () => {
    assert.equal(po.attendedForTest(org.id, pa.id), false);
    await assert.rejects(() => run({ milestone: "requested", text: "Hello." }), /only for a post the operator asked for/);
    const out = await run({ milestone: "decided", text: "The opening hours are agreed: 9 to 6, closed Mondays. See https://demo.example.test" });
    assert.match(JSON.stringify(out.content), /Posted to Alperen Kaya's owner page/);
    await assert.rejects(() => run({ milestone: "built", text: "The booking page is built." }), /already went out today/);
    const log = updates.readUpdates(org.id, pa.id);
    assert.deepEqual(log.map((u) => [u.milestone, u.by]), [["decided", "overseer"]]);
    // Logged on the project page's activity list too.
    const actions = readFileSync(store.projectOverseerPaths(org.id, pa.id).actions, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a.tool === "sova_owner_update");
    assert.deepEqual(actions.map((a) => a.outcome), ["refused", "refused", "refused", "refused", "refused", "refused", "ok", "refused"]);
    assert.equal(actions.find((a) => a.outcome === "ok").note, "Posted an owner update (decided)");
  });

  test("its prompt carries the rule and the tool", () => {
    const prompt = po.renderProjectOverseerPrompt(org.id, pa.id, po.toolsForTest(org.id, pa.id));
    assert.match(prompt, /sova_owner_update/);
    assert.match(prompt, /at most one per project per\s+day/);
    assert.match(prompt, /never anything\s+from "About this organization"/);
  });
});
