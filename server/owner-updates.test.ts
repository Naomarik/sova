// Run: pnpm exec tsx --test server/owner-updates.test.ts. §app.owner-page/news: the updates store
// (append, withdraw, fold, refusals), its operator routes, and the project overseer's
// sova_owner_update as its runtime builds it: posted at a milestone, one a day unattended,
// "requested" only when the operator asked, and refused when it repeats the About text, the
// overseer's notes, a goal, a profile or a contact. A throwaway PI_CODING_AGENT_DIR (with this
// tree's pi-config extensions linked in) in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ProjectUpdate } from "../shared/owner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-updates-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
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
const { TOOL_NEEDS } = await import("./project-overseer-tools");
const { settled } = await import("./workspace-git");
const { hostOf, setOrgClockForTest } = await import("./org-engine");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate Archery", dir: join(root, "ws") });
mkdirSync(join(root, "a"));
mkdirSync(join(root, "b"));
const pa = await orgs.addProject(org.id, { name: "Booking site", root: join(root, "a") });
const pb = await orgs.addProject(org.id, { name: "Payroll", root: join(root, "b") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Director" });
const kim = await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach", voice: "Warm and patient, likes examples", contact: { email: "kim.lee@example.test" } });

const app = new Hono();
registerOrgRoutes(app);

describe("the updates store", () => {
  test("append, fold newest first, take down (stays in the file), refusals", async () => {
    const a = updates.appendUpdate(org.id, pb.id, { text: "  First.  ", run: "auto" }, Date.parse("2026-09-01T10:00:00Z"));
    const b = updates.appendUpdate(org.id, pb.id, { text: "Second.", run: "operator" }, Date.parse("2026-09-02T10:00:00Z"));
    assert.equal(a.text, "First.");
    assert.deepEqual(updates.readUpdates(org.id, pb.id).map((u) => [u.id, u.by]), [
      [b.id, "operator"],
      [a.id, "overseer"],
    ]);
    assert.throws(() => updates.appendUpdate(org.id, pb.id, { text: " ", run: "auto" }), /Write the update first/);
    assert.throws(() => updates.appendUpdate(org.id, pb.id, { text: "x".repeat(2001), run: "auto" }), /^OrgError: An update is at most 2,000 characters\.$|An update is at most 2,000 characters\./);
    updates.appendUpdate(org.id, pb.id, { text: "x".repeat(2000), run: "auto" }, Date.parse("2026-08-01T10:00:00Z"));
    const r = await app.request(`/api/orgs/${org.id}/projects/${pb.id}/updates/${a.id}/withdraw`, { method: "POST" });
    assert.equal(r.status, 200);
    const after = (await r.json()) as ProjectUpdate[];
    assert.ok(after.find((u) => u.id === a.id)!.withdrawnAt);
    assert.deepEqual(updates.publishedUpdates(org.id, pb.id).map((u) => u.id).slice(0, 1), [b.id]);
    assert.ok(!updates.publishedUpdates(org.id, pb.id).some((u) => u.id === a.id));
    assert.equal((await app.request(`/api/orgs/${org.id}/projects/${pb.id}/updates/${a.id}/withdraw`, { method: "POST" })).status, 409);
    assert.equal((await app.request(`/api/orgs/${org.id}/projects/prj_nope0000/updates`)).status, 404);
    const file = readFileSync(join(orgs.orgDir(org.id), "projects", pb.id, "updates.jsonl"), "utf8");
    assert.match(file, /"kind":"withdraw"/);
    assert.match(file, /"by":\{"kind":"overseer","run":"operator"\}/);
    assert.match(file, /First\./, "a taken-down post stays in the workspace history");
  });

  test("path segments are never anything but an id", () => {
    assert.throws(() => updates.readUpdates(org.id, "../x"), /Unknown project/);
  });
});

describe("sova_owner_update, as the project overseer's runtime builds it", async () => {
  const tool = () => po.toolsForTest(org.id, pa.id).find((t) => t.name === "sova_owner_update")!;
  const run = (text: string) => tool().execute("t1", { text } as never, undefined, undefined, undefined as never);
  await po.ensureProjectOverseer(org.id, pa.id);
  await po.patchProjectOverseer(org.id, pa.id, { autonomy: "L1" });

  test("L1; with no owner it refuses: there is no page to post to", async () => {
    assert.equal(TOOL_NEEDS.sova_owner_update, "L1");
    await assert.rejects(() => run("Hello."), /^Error: This organization has no owner, so there is no page to post to\.$/);
  });

  test("each private source refuses the post, never quoted", async () => {
    await orgs.setOrgOwner(org.id, alp.id);
    await orgs.patchOrg(org.id, { about: "They are selling the academy next spring and must not hear of it." });
    writeNotes("Kim tends to overpromise on delivery dates, check with Bob.\n", store.projectOverseerPaths(pa.id).notes);
    await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Hours", goal: "Find out whether Kim will accept weekend shifts quietly" }, { mintLink: false });
    const PRIVATE = "This update repeats text from About this organization or your notes. Updates are for the client: write it again in your own words.";
    for (const [text, why] of [
      ["Good news: they are selling the academy next spring.", PRIVATE],
      ["Note that Kim tends to overpromise on delivery dates.", PRIVATE],
      ["We wanted to find out whether Kim will accept weekend shifts.", /repeats private text/],
      ["Kim is warm and patient, likes examples.", /repeats private text/],
      ["Write to kim.lee@example.test for details.", /repeats private text/],
    ] as const) {
      await assert.rejects(() => run(text), (err: Error) => (typeof why === "string" ? err.message === why : why.test(err.message)) && !err.message.includes(text.slice(0, 30)), text);
    }
    await assert.rejects(() => run("x".repeat(2001)), /^Error: An update is at most 2,000 characters\.$/);
    assert.equal(updates.readUpdates(org.id, pa.id).length, 0, "nothing was posted");
  });

  test("unattended: nothing new refuses; a finished conversation is a milestone; then 24 hours", async () => {
    assert.equal(po.attendedForTest(org.id, pa.id), false);
    const NOTHING = "Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged.";
    await assert.rejects(() => run("The opening hours are agreed."), (e: Error) => e.message === NOTHING);
    const s = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Hours", goal: "g" }, { mintLink: false });
    await baton.setHiddenFromOwner(s.sessionId, true);
    await baton.markDone(s.sessionId);
    await assert.rejects(() => run("The opening hours are agreed."), (e: Error) => e.message === NOTHING, "a hidden conversation is no milestone");
    const t = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Hours 2", goal: "g" }, { mintLink: false });
    await baton.markDone(t.sessionId);
    // With the hold on (the default), the unattended post waits in a hold the operator may cancel (q10/r4).
    const held = await run("The opening hours are agreed: 9 to 6, closed Mondays. See https://demo.example.test");
    assert.match(JSON.stringify(held.content), /Held: the update to Alperen Kaya's owner page waits until .* so the operator can cancel it/);
    assert.equal(updates.readUpdates(org.id, pa.id).length, 0, "nothing posted while it is held");
    const hold = hostOf(org.id).holds().find((h) => h.event === "owner-update/post")!;
    await hostOf(org.id).act(`project/${org.id}/${pa.id}`, "hold/cancel", { id: hold.id, reason: "test: post it without the hold" }, { by: "operator", attended: true });
    await po.patchProjectOverseer(org.id, pa.id, { holdMin: 0 });
    const out = await run("The opening hours are agreed: 9 to 6, closed Mondays. See https://demo.example.test");
    assert.match(JSON.stringify(out.content), /Posted to Alperen Kaya's owner page/);
    await assert.rejects(() => run("More news."), /^Error: An update was posted less than an hour ago: at most one a day\.$/);
    // A day later: nothing new since the post still refuses; a conversation finished after it allows the next one.
    const later = Date.now() + 25 * 3_600_000;
    setOrgClockForTest(() => later);
    try {
      await assert.rejects(() => run("Parking is sorted too."), (e: Error) => e.message === NOTHING);
      const u = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Parking", goal: "g" }, { mintLink: false });
      await baton.markDone(u.sessionId);
      await run("Parking is sorted too.");
      await assert.rejects(() => run("More news."), /at most one a day/);
    } finally {
      setOrgClockForTest(null);
    }
    assert.deepEqual(updates.readUpdates(org.id, pa.id).map((u) => u.by), ["overseer", "overseer"]);
    const actions = readFileSync(store.projectOverseerPaths(pa.id).actions, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a.tool === "sova_owner_update");
    assert.deepEqual(actions.filter((a) => a.outcome === "ok").map((a) => a.note), [undefined, "Posted an owner update", "Posted an owner update"], "the held call, then the two posts");
    assert.ok(actions.some((a) => a.outcome === "refused" && a.error === NOTHING), "refusals are in the activity list");
  });

  test("its prompt carries the rule and the tool", () => {
    const prompt = po.renderProjectOverseerPrompt(org.id, pa.id, po.toolsForTest(org.id, pa.id));
    assert.match(prompt, /sova_owner_update/);
    assert.match(prompt, /at most one per project per\s+day/);
    assert.match(prompt, /never anything\s+from "About this organization"/);
  });
});
