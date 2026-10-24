// Closing a fix request whose start still waits cancels that start (§app.project-assistant/closing, q8), against the
// real engine host: the Project Assistant's build/start is held for the waiting period, the owner closes the request,
// the hold is gone and nothing starts. Another request's held start stays. Throwaway workspace and
// PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-close-holds-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);

const orgs = await import("./orgs");
const owner = await import("./owner");
const po = await import("./project-overseer");
const store = await import("./project-assistant-store");
const close = await import("./owner-request-close");
const { hostOf } = await import("./org-engine");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { fakeLooks } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
await po.ensureProjectOverseer(project.id);
fakeLooks(org.id);

const heldStarts = () => hostOf(org.id).holds().filter((h) => h.projectId === project.id && h.event === "build/start");

test("a held fix start is cancelled when the owner closes its request; another request's stays", async () => {
  await po.patchProjectOverseer(project.id, { autonomy: "L1", holdMin: 10, powers: { assistant: { codingStart: true } } });
  const fix = store.fileRequest(org.id, { projectId: project.id, kind: "fix", title: "Fix the login", text: "It fails." });
  const other = store.fileRequest(org.id, { projectId: project.id, kind: "fix", title: "Fix the logout", text: "It fails too." });
  for (const r of [fix, other]) {
    const out = await po.assistantAct(project.id, { act: "build/start", basis: { kind: "owner-request", id: r.id }, prompt: `${r.title}\n\n${r.text}`, title: `Fix: ${r.title}` }, { attended: false });
    assert.ok(out.taken && out.held, JSON.stringify(out));
  }
  assert.equal(heldStarts().length, 2);
  close.setCloseDepsForTest(null);
  await close.closeOwnerRequests(org.id, [fix.id], { kind: "owner", personId: omar.id });
  const left = heldStarts();
  assert.equal(left.length, 1, "only the closed request's start is cancelled");
  assert.equal((left[0]!.data as { basis?: { id?: string } }).basis?.id, other.id);
  assert.equal(store.findRequest(org.id, fix.id)?.status, "closed");
});
