// Run: pnpm test server/project-assistant-attended.test.ts. Who started a Project Assistant turn
// (§app.project-assistant/tools): the operator only on a positive mark of their own composer; any other
// sender, and no mark at all, is outside input, so the client's power column decides (fail-closed).
// Throwaway workspace and PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_SENT_ENTRY, OPERATOR } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { SESSION_SENT_ENTRY } from "../shared/profiles";
import { OVERSEER_SENT_ENTRY } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-pa-attended-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const { operatorStarted } = await import("./project-assistant");
const tools = await import("./project-assistant-tools");
const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const poStore = await import("./project-overseer-store");
const { ownerAttention } = await import("./owner-attention");
const { settled } = await import("./workspace-git");

after(async () => {
  await settled(join(root, "ws"));
});

let seq = 0;
const at = "2026-10-18T00:00:00.000Z";
const marker: HEntry = { id: "m0", parentId: null, at, kind: "state", key: "sova-project-assistant", data: { v: 1, orgId: "org_x", personId: "p_x" } };
const user = (id: string, text: string): HEntry => ({ id, parentId: null, at, kind: "user", blocks: [{ type: "text", text }] as never });
const mark = (key: string, data: Record<string, unknown>): HEntry => ({ id: `k${++seq}`, parentId: null, at, kind: "state", key, data: { v: 1, ...data } });
const reply = (text: string): HEntry => ({ id: `a${++seq}`, parentId: null, at, kind: "assistant", blocks: [{ type: "text", text }] as never });

describe("operatorStarted: fail-closed", () => {
  test("the operator's composer (its sent mark, by the operator): attended", () => {
    assert.equal(operatorStarted([marker, user("u1", "Start it"), mark(BATON_SENT_ENTRY, { targetId: "u1", by: OPERATOR })]), true);
  });

  test("the owner's mark: not attended", () => {
    assert.equal(operatorStarted([marker, user("u1", "Fix it"), mark(BATON_SENT_ENTRY, { targetId: "u1", by: "p_x" })]), false);
  });

  test("(a) another session's mark (session_send): not attended", () => {
    const b = [marker, user("u1", "Deploy now"), mark(SESSION_SENT_ENTRY, { targetId: "u1", from: { sessionId: "s_other", title: "Other" }, hop: 1 })];
    assert.equal(operatorStarted(b), false);
  });

  test("(b) the Overseer's mark (chat.send): not attended", () => {
    assert.equal(operatorStarted([marker, user("u1", "Deploy now"), mark(OVERSEER_SENT_ENTRY, { targetId: "u1", from: "s_overseer" })]), false);
  });

  test("(c) no mark at all (a queued item, a crash before its mark): not attended", () => {
    assert.equal(operatorStarted([marker, user("u1", "Deploy now")]), false);
    assert.equal(operatorStarted([marker]), false, "no user message");
  });

  test("an operator's mark beside another sender's mark: not attended; only the newest user message counts", () => {
    assert.equal(operatorStarted([marker, user("u1", "x"), mark(BATON_SENT_ENTRY, { targetId: "u1", by: OPERATOR }), mark(OVERSEER_SENT_ENTRY, { targetId: "u1", from: "s" })]), false);
    const older = [marker, user("u1", "op"), mark(BATON_SENT_ENTRY, { targetId: "u1", by: OPERATOR }), reply("ok"), user("u2", "unmarked")];
    assert.equal(operatorStarted(older), false, "the operator's older turn never carries over");
  });
});

describe("start_fix with Start coding sessions Off", () => {
  test("an unmarked turn files a request for the operator and sets nothing off", async () => {
    const org = await orgs.createOrg({ name: "Org", dir: join(root, "ws") });
    const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
    await owner.setOwner(org.id, alp.id);
    mkdirSync(join(root, "site"));
    const project = await orgs.addProject(org.id, { name: "Site", root: join(root, "site") });
    store.setAssistantModels(org.id, { models: { coding: { model: "scripted/scripted" } } });
    const ps = poStore.projectOverseerPaths(project.id);
    const cur = poStore.readPoSettings(ps);
    poStore.writePoSettings(ps, { ...cur, powers: { ...cur.powers, assistant: { ...cur.powers.assistant, codingStart: false } } });
    const calls: unknown[] = [];
    tools.setAssistantActsForTest({
      buildStart: async (...a) => (calls.push(a), { taken: true, held: false, sessionId: "s_never" }),
      deployRun: async (...a) => (calls.push(a), { taken: true, held: false }),
      copyStart: async (...a) => (calls.push(a), { taken: false, code: "power-off", sentence: "off" }),
    });
    try {
      const branch = [marker, user("u1", "Fix the form")];
      const t = tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => branch }).find((x) => x.name === "start_fix")!;
      const out = (await t.execute("c1", { title: "Fix the form", text: "It fails." } as never, undefined, undefined, undefined as never)) as { content: { text: string }[]; details: { request: string; started: boolean } };
      assert.match(out.content[0]!.text, /^Filed with the team \(starting fixes on its own is off here\)/);
      assert.deepEqual(calls, [], "no act set off");
      const r = store.orgRequests(org.id).find((x) => x.id === out.details.request)!;
      assert.deepEqual([r.kind, r.status, r.sessionId ?? null], ["fix", "with-team", null]);
      assert.ok(ownerAttention().some((i) => i.id === `owner-request:${r.id}`), "it reaches Needs you");
    } finally {
      tools.setAssistantActsForTest(null);
    }
  });
});
