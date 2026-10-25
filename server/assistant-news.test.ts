// What's new, for the Project Assistant (§app.project-assistant/news): project_news gives the team's updates, the
// last release and what was finished since (the owner's requests done, decisions agreed, a count of finished work),
// read from the owner page's own cleaned answer; nothing before the release is listed as new. A throwaway workspace;
// the release history and finished work stood in; no model runs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-assistant-news-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "site"), { recursive: true });
const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const news = await import("./assistant-news");
after(() => {
  news.setNewsFactsForTest(null);
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
const proj = await orgs.addProject(org.id, { name: "Archery website", root: join(root, "site") });

const run = async (params: Record<string, unknown> = {}) =>
  ((await news.projectNewsTool({ orgId: org.id, projects: () => [{ id: proj.id, name: proj.name, root: proj.root }] }).execute("c", params as never, undefined, undefined, undefined as never)) as { content: { text: string }[] }).content[0]!.text;

test("with no release: every finished thing so far; the page's own updates and agreed decisions", async () => {
  news.setNewsFactsForTest({
    page: async () => ({
      news: [
        { id: "u1", at: "2026-10-01T10:00:00.000Z", text: "The shop page is live." },
        { id: "u2", at: "2026-10-20T10:00:00.000Z", text: "Checkout is faster." },
      ],
      decisions: [
        { topic: "Prices", statement: "Prices show in riyals.", quote: "", by: { name: "Omar Haddad", first: "Omar" }, at: "2026-10-05T00:00:00.000Z", state: "agreed" },
        { topic: "Colours", statement: "Maybe green.", quote: "", by: { name: "Omar Haddad", first: "Omar" }, at: "2026-10-06T00:00:00.000Z", state: "noted" },
      ],
    }),
    lastRelease: async () => null,
    finishedAt: () => ["2026-10-02T00:00:00.000Z", "2026-10-21T00:00:00.000Z"],
  });
  const r = store.fileRequest(org.id, { projectId: proj.id, kind: "bug", title: "The bow page is slow", text: "x" });
  store.setRequestStatus(org.id, r.id, "done");
  const text = await run();
  assert.match(text, /^## Archery website\nUpdates from the team, newest first:\n- Oct 20, 2026: Checkout is faster\.\n- Oct 1, 2026: The shop page is live\.\nNo release is recorded yet\.\nFinished so far:/);
  assert.match(text, /- the owner's request "The bow page is slow" \(done /);
  assert.match(text, /- agreed: Prices show in riyals\. \(Oct 5, 2026\)/);
  assert.ok(!text.includes("Maybe green"), "only agreed decisions");
  assert.match(text, /- 2 pieces of work finished$/);
  assert.ok(!text.includes(r.id), "no request id");
});

test("after a release: only what came after it is new", async () => {
  news.setNewsFactsForTest({
    page: async () => ({ news: [], decisions: [{ topic: "Prices", statement: "Prices show in riyals.", quote: "", by: { name: "Omar Haddad", first: "Omar" }, at: "2026-10-05T00:00:00.000Z", state: "agreed" }] }),
    lastRelease: async () => "2026-10-10T00:00:00.000Z",
    finishedAt: () => ["2026-10-02T00:00:00.000Z", "2026-10-21T00:00:00.000Z"],
  });
  const text = await run({ project: "archery website" });
  assert.match(text, /No updates from the team yet\.\nLast release: Oct 10, 2026\.\nFinished since that release:/);
  assert.ok(!text.includes("riyals"), "agreed before the release");
  assert.match(text, /- 1 piece of work finished$/);
  await assert.rejects(() => run({ project: "Someone else's" }), /not one of the owner's projects/);
});

test("the real owner page answers (nothing stood in but the release and the work)", async () => {
  news.setNewsFactsForTest({ lastRelease: async () => null, finishedAt: () => [] });
  const text = await run();
  assert.match(text, /^## Archery website\nNo updates from the team yet\.\nNo release is recorded yet\./);
});

test("a model's words pass the outsider filter: a person's private profile never comes through a request's title", async () => {
  await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach", voice: "Runs the Falcon Holdings acquisition desk" });
  news.setNewsFactsForTest({ page: async () => ({ news: [], decisions: [] }), lastRelease: async () => null, finishedAt: () => [] });
  const r = store.fileRequest(org.id, { projectId: proj.id, kind: "bug", title: "Ask who runs the Falcon Holdings acquisition desk", text: "x" });
  store.setRequestStatus(org.id, r.id, "done");
  const text = await run();
  assert.ok(text.includes('the owner\'s request "'), text);
  assert.ok(!text.includes("Falcon Holdings acquisition desk"), text);
});
