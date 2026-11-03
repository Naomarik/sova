// B2 (§app.project-assistant/closing, q9/a9): the owner closes a `feature` request while its planning chat is still
// starting. The start finishing afterwards never writes over the close, and the new chat is ended (kept as history).
// The gathering's start and close stood in; a throwaway workspace; no model runs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-feature-race-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "site"), { recursive: true });
const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const close = await import("./owner-request-close");
const fc = await import("./feature-chats");
after(() => {
  fc.setFeatureStartForTest(null);
  fc.setFeatureCloseForTest(null);
  close.setCloseDepsForTest(null);
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
const proj = await orgs.addProject(org.id, { name: "Archery website", root: join(root, "site") });
store.setAssistantModels(org.id, { models: { gathering: { model: "anthropic/claude-sonnet-4-5" } } });

test("a close while the planning chat starts: the request stays closed and the new chat ends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fc.setFeatureStartForTest((async () => {
    await gate;
    return { sessionId: "feat-race-1", path: join(root, "feat.jsonl") };
  }) as never);
  const closed: string[] = [];
  fc.setFeatureCloseForTest((async (sid: string) => void closed.push(sid)) as never);
  close.setCloseDepsForTest({ cancelHeldStart: async () => 0, note: async () => true });
  const starting = fc.startFeatureChat(org.id, { projectId: proj.id, owner: { id: omar.id, name: omar.name }, title: "Gift cards", text: "Customers ask." }, { attended: false });
  await new Promise((r) => setTimeout(r, 10));
  const r = store.orgRequests(org.id).find((x) => x.title === "Gift cards")!;
  assert.equal(r.status, "with-team");
  await close.closeOwnerRequests(org.id, [r.id], { kind: "owner", personId: omar.id });
  release();
  await starting;
  const after = store.findRequest(org.id, r.id)!;
  assert.equal(after.status, "closed", "the start finishing never writes over the close");
  assert.deepEqual(closed, ["feat-race-1"], "the new planning chat is ended");
  assert.equal(store.featureChatRecord(org.id, "feat-race-1")?.requestId, r.id, "kept as the owner's history");
});
