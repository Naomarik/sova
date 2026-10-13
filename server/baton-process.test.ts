// Run: pnpm test -- server/baton-process.test.ts. A baton session whose chat runs in a process of its own
// (§app.chat-processes/special-kinds): its kind hears the run's events as data, and a process that died
// mid-reply ends the reply for the statechart once. A throwaway PI_CODING_AGENT_DIR and workspace; no
// chat is opened and no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { until } from "./test-wait";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-process-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
await import("./baton-loadout");
const { specialHostOf } = await import("./chat-handle");
const { hostOf } = await import("./org-engine");

after(() => {});

test("a process that died mid-reply: the reply ends for the statechart once; its late settle ends nothing more", async () => {
  const org = await orgs.createOrg({ name: "Proc", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "g" });
  const host = specialHostOf("baton")!;
  const sid = baton.batonSid(org.id, c.sessionId);
  const ended = () => hostOf(org.id).log.rows({ session: sid }).filter((r) => r.event === "reply/ended" && !r.refused).length;
  const reply = () => hostOf(org.id).data(sid)?.reply;

  baton.noteMessage(c.sessionId, tony.id);
  host.runEvent!(c.path, { type: "run.start" }, 1);
  await until(() => reply() === "writing", "the reply is being written");
  host.died!(c.path);
  await until(() => reply() === "idle", "the reply ended");
  assert.equal(ended(), 1);
  host.died!(c.path); // told twice: nothing more
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ended(), 1);
});
