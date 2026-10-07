// Run: pnpm exec tsx --test server/baton-offers.integration.test.ts. Offers over a real share
// listener (§app/baton slice 2): N first messages at once on the share route, and the share
// WebSocket while the offer is taken and after its lease lapses. A throwaway PI_CODING_AGENT_DIR
// and workspace in the OS temp dir; no model is called. The rest is baton-offers.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { until as waitFor } from "./test-wait";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-offers-int-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { replyEnded } = await import("./org-test-fixtures");

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
const carlos = await orgs.addPerson(org.id, { name: "Carlos", role: "CEO" });

describe("regressions from the slice-2 verification, on a share listener", async () => {
  const { createShareServer } = await import("./share/listener");
  const { disposeAllChats } = await import("./chat-manager");
  const { default: WebSocket } = await import("ws");
  const server = createShareServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  after(async () => {
    server.close();
    server.closeAllConnections();
    await disposeAllChats();
  });
  const post = (token: string, text: string) => fetch(`${base}/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

  test("N first messages at once on the share route: exactly one is accepted, the rest are 'taken'", async () => {
    const people = [tony, maria, carlos];
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: people.map((p) => p.id), publicTitle: "Race", goal: "g" });
    const res = await Promise.all(c.links!.map((l) => post(l.token, `me first, ${l.personId}`)));
    const bodies = await Promise.all(res.map((r) => r.json() as Promise<{ code?: string }>));
    const accepted = res.filter((r) => r.status === 202);
    assert.equal(accepted.length, 1, `statuses ${res.map((r) => r.status).join(",")}`);
    assert.deepEqual(bodies.filter((_, i) => res[i]!.status !== 202).map((b) => b.code), ["taken", "taken"]);
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.budget.messagesUsed, 1);
    assert.ok(people.some((p) => p.id === row.holder));
  });

  test("the share WebSocket writes nothing while taken; after the lease lapses a view that may write is pushed", async () => {
    // A one-second lease (hermetic tests only): the statechart's own timer lapses it.
    process.env.SOVA_BATON_LEASE_MS = "1000";
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "WS", goal: "g" }).finally(() => delete process.env.SOVA_BATON_LEASE_MS);
    const mariaTok = c.links!.find((l) => l.personId === maria.id)!.token;
    baton.noteMessage(c.sessionId, tony.id); // Tony holds a live lease
    await replyEnded(c.sessionId); // the reply to him ended: a lease lapses only between replies
    const views: { canWrite: boolean; reason?: string }[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/h?token=${mariaTok}`);
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "view") views.push(m.view.viewer);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "prompt", text: "let me in" }));
    // The server reads frames in order: its pong means the prompt was already handled.
    await new Promise((r) => (ws.once("pong", r), ws.ping()));
    await waitFor(() => views.length > 0);
    assert.deepEqual(views[0], { name: "Maria Lopez", canWrite: false, reason: "taken" }, "on connect: taken");
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.holder, tony.id, "a socket message claims nothing");
    assert.equal(row.budget.messagesUsed, 1, "and is not a message");
    await waitFor(() => views.at(-1)?.canWrite === true, "the lapsed lease's pushed view");
    ws.close();
    assert.equal(baton.batonById(c.sessionId)!.row.holder, null, "back in the pool");
    assert.deepEqual(views.at(-1), { name: "Maria Lopez", canWrite: true }, "Maria's page was told she may write");
  });
});
