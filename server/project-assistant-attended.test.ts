// Run: pnpm test server/project-assistant-attended.test.ts. No turn of the Project Assistant's chat is attended
// (§app.project-assistant/offers, /tools): with a switch Off, a start_fix or a start_feature_chat goes to the team whoever
// started the turn, the owner, the operator's own composer, another chat or nobody on record, and sets nothing off.
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

/** Each sender a turn can have: the owner's mark, the operator's composer, another chat, the Overseer, no mark. */
const TURNS: [string, HEntry[]][] = [
  ["the owner's turn", [marker, user("u1", "Fix the form"), mark(BATON_SENT_ENTRY, { targetId: "u1", by: "p_x" })]],
  ["the operator's own turn", [marker, user("u1", "Fix the form"), mark(BATON_SENT_ENTRY, { targetId: "u1", by: OPERATOR })]],
  ["another chat's message", [marker, user("u1", "Fix the form"), mark(SESSION_SENT_ENTRY, { targetId: "u1", from: { sessionId: "s_other", title: "Other" }, hop: 1 })]],
  ["the Overseer's message", [marker, user("u1", "Fix the form"), mark(OVERSEER_SENT_ENTRY, { targetId: "u1", from: "s_overseer" })]],
  ["no mark at all", [marker, user("u1", "Fix the form")]],
];
void reply;

describe("Start coding sessions and Open feature request chats Off", () => {
  test("every turn, the operator's included: start_fix files a request for the team and sets nothing off", async () => {
    const org = await orgs.createOrg({ name: "Org", dir: join(root, "ws") });
    const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
    await owner.setOwner(org.id, alp.id);
    mkdirSync(join(root, "site"));
    const project = await orgs.addProject(org.id, { name: "Site", root: join(root, "site") });
    store.setAssistantModels(org.id, { models: { coding: { model: "scripted/scripted" }, gathering: { model: "scripted/scripted" } } });
    const ps = poStore.projectOverseerPaths(project.id);
    const cur = poStore.readPoSettings(ps);
    poStore.writePoSettings(ps, { ...cur, powers: { ...cur.powers, assistant: { ...cur.powers.assistant, codingStart: false, gather: false } } });
    const calls: unknown[] = [];
    tools.setAssistantActsForTest({
      buildStart: async (...a) => (calls.push(a), { taken: true, held: false, sessionId: "s_never" }),
      deployRun: async (...a) => (calls.push(a), { taken: true, held: false }),
      copyStart: async (...a) => (calls.push(a), { taken: false, code: "power-off", sentence: "off" }),
    });
    const features: unknown[] = [];
    tools.setFeatureStartForTest(async (...a: unknown[]) => (features.push(a), { kind: "opened", sessionId: "s_never", request: { id: "r_never" } }) as never);
    try {
      for (const [who, branch] of TURNS) {
        const all = tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => branch });
        const call = { branch: () => branch } as never;
        const fix = all.find((x) => x.name === "start_fix")!;
        const out = (await fix.execute("c1", { title: "Fix the form", text: "It fails." } as never, undefined, undefined, call)) as { content: { text: string }[]; details: { request: string; started: boolean } };
        assert.match(out.content[0]!.text, /^Filed with the team \(starting fixes on its own is off here\)/, who);
        const r = store.orgRequests(org.id).find((x) => x.id === out.details.request)!;
        assert.deepEqual([r.kind, r.status, r.sessionId ?? null], ["fix", "with-team", null], who);
        assert.ok(ownerAttention().some((i) => i.id === `owner-request:${r.id}`), `${who}: it reaches Needs you`);
        const plan = all.find((x) => x.name === "start_feature_chat")!;
        const p = (await plan.execute("c2", { title: "A gallery", text: "A page of photos." } as never, undefined, undefined, call)) as { content: { text: string }[]; details: { started: boolean } };
        assert.match(p.content[0]!.text, /^Filed with the team \(opening a planning chat on its own is off here\)/, who);
        assert.equal(p.details.started, false, who);
      }
      assert.deepEqual(calls, [], "no act set off");
      assert.deepEqual(features, [], "no planning chat opened");
    } finally {
      tools.setAssistantActsForTest(null);
      tools.setFeatureStartForTest(null);
    }
  });
});
