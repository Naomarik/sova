// Run: pnpm exec tsx --test server/baton-told.test.ts. Who started a gathering session, why, and what it is
// told (§app.baton/told): the statechart's `started` from each start (the operator's, a project overseer's, a gap's,
// a plan's), the strip's `BatonInfo.started`, and `GET /api/baton/:sid/told` with the prompt replayed from the
// session file's pi 0.86+ system entries by pi-ai's own replay. Throwaway workspace and PI_CODING_AGENT_DIR;
// no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { BatonInfo, BatonTold } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-told-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const told = await import("./baton-told");
const { registerOrgRoutes } = await import("./org-routes");
const { disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { hostOf } = await import("./org-engine");
const { fakeLooks } = await import("./org-test-fixtures");
const { WRAPUP_SYSTEM } = await import("./baton-wrapup");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["hosting"] });
const toni = await orgs.addPerson(org.id, { name: "Toni Diaz", role: "Payroll", decides: ["payroll"] });
await po.ensureProjectOverseer(org.id, project.id);
fakeLooks(org.id);
const app = new Hono();
registerOrgRoutes(app);
await po.patchProjectOverseer(org.id, project.id, { autonomy: "L1", holdMin: 0, caps: { gatherPerDay: null, gatherPerTurn: null, gatheringsOpen: 20 } });

const WHY = "Nobody has said who hosts the portal, and Tony runs IT.";
const run = (name: string, params: Record<string, unknown>) => {
  const t = po.toolsForTest(org.id, project.id, { attended: true }).find((x) => x.name === name);
  assert.ok(t, name);
  return t.execute("call-1", params as never, undefined, undefined, undefined as never);
};
const detailsOf = (r: { details?: unknown }) => r.details as { id: string; path: string };
const statechartStarted = (sessionId: string) => hostOf(org.id).data(baton.batonSid(org.id, sessionId))?.["started"];
const info = async (path: string) => (await (await app.request(`/api/baton?path=${encodeURIComponent(path)}`)).json()) as BatonInfo;
const toldOf = async (sessionId: string) => {
  const r = await app.request(`/api/baton/${sessionId}/told`);
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()) as BatonTold;
};
const overseerId = () => store.readPoState(store.projectOverseerPaths(project.id))?.current ?? "";

/** Append entries to a session file as pi does (each the child of the last). */
function append(path: string, entries: Record<string, unknown>[]): void {
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id?: string });
  let parent = lines.filter((l) => l.id).at(-1)?.id ?? null;
  for (const e of entries) {
    const id = Math.random().toString(16).slice(2, 10);
    appendFileSync(path, `${JSON.stringify({ ...e, id, parentId: parent })}\n`);
    parent = id;
  }
}
const decl = (name: string, description = `${name} does its thing.`) => ({ name, description, parameters: { type: "object", properties: { x: { type: "string", description: `${name}'s x` } } } });
/** pi 0.86+'s system entry: empty content, named sections, whole tool declarations. */
const system = (at: string, message: Record<string, unknown>) => ({ type: "message", timestamp: at, message: { role: "system", content: "", timestamp: Date.parse(at), ...message } });

describe("who started it (§app.baton/told)", () => {
  test("the statechart's start data, else the owner and startedVia of a session from before it", () => {
    assert.deepEqual(told.starterOf({ started: { by: "project-overseer", overseerId: "c1", why: " W " } }), { who: "project-overseer", overseerId: "c1", why: "W" });
    assert.deepEqual(told.starterOf({ started: { by: "overseer", why: "" } }), { who: "overseer" });
    assert.deepEqual(told.starterOf({ started: { by: "operator" }, owner: { overseerOf: "p" } }), { who: "operator" }, "recorded wins over derived");
    assert.deepEqual(told.starterOf({ owner: { overseerOf: "prj_1" }, startedVia: "overseer" }), { who: "project-overseer" }, "old: the project overseer's owner");
    assert.deepEqual(told.starterOf({ owner: "operator", startedVia: "overseer" }), { who: "overseer" }, "old: you, via the Overseer");
    assert.deepEqual(told.starterOf({ owner: "operator" }), { who: "operator" });
    assert.deepEqual(told.starterOf({ started: { by: "someone" }, owner: "operator" }), { who: "operator" }, "an unknown by is not trusted");
  });

  test("the operator's Start: `started {by: operator}`, no why, and the preview before its first reply", async () => {
    const r = await app.request("/api/baton", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: org.id, projectId: project.id, to: "operator", publicTitle: "Mine", goal: "Mine to find out", why: "ignored", started: { by: "overseer", why: "ignored" } }),
    });
    assert.equal(r.status, 201, await r.clone().text());
    const { sessionId, path } = (await r.json()) as { sessionId: string; path: string };
    assert.deepEqual(statechartStarted(sessionId), { by: "operator" }, "a body's why and started are ignored");
    const i = await info(path);
    assert.deepEqual(i.started, { who: "operator", at: i.session.createdAt });
    const t = await toldOf(sessionId);
    assert.equal(t.prompt.kind, "preview", "never run: a render, labelled as such");
    assert.match(t.prompt.text, /Mine to find out/);
    assert.deepEqual(t.tools.map((x) => x.name), ["hand_to", "goal_done", "record_decision", "propose_roster_edit"]);
    assert.deepEqual(t.inactive, [{ name: "read_link", when: "while it can read links" }, { name: "write_profile_updates", when: "only during the wrap-up" }]);
    assert.equal(t.startedFor, undefined);
    assert.equal(t.projectName, "Portal");
  });

  test("a project overseer's start: its conversation and its why, on the statechart, the strip and the told document", async () => {
    await assert.rejects(
      () => run("sova_start_gathering", { gap: "none", person: "Tony Reyes", public_title: "Hosting", goal: "Who hosts the portal", question: "Who hosts it?" }),
      /^Error: Say why you start it \(why\): one or two sentences for the operator, never shown to the person\.$/,
    );
    const out = await run("sova_start_gathering", { gap: "none", person: "Tony Reyes", why: WHY, public_title: "Hosting", goal: "Who hosts the portal", question: "Who hosts it?" });
    const { id, path } = detailsOf(out);
    assert.ok(overseerId(), "the overseer has a conversation");
    assert.deepEqual(statechartStarted(id), { by: "project-overseer", overseerId: overseerId(), why: WHY });
    const i = await info(path);
    assert.deepEqual(i.started, { who: "project-overseer", at: i.session.createdAt, why: WHY, overseer: { id: overseerId(), current: true } });
    const t = await toldOf(id);
    assert.equal(t.started.why, WHY);
    assert.equal(t.goal, "Who hosts the portal");
  });

  test("an offer, a gap's gathering and a planned one keep it too", async () => {
    const offer = detailsOf(await run("sova_offer", { gap: "none", people: ["Tony Reyes", "Toni Diaz"], why: WHY, public_title: "Pay day", goal: "g", question: "q?" }));
    assert.deepEqual(statechartStarted(offer.id), { by: "project-overseer", overseerId: overseerId(), why: WHY });
    await run("sova_idea", { op: "add", id: "§gap/payday", title: "Nobody decided the pay day" });
    const gap = detailsOf(await run("sova_start_gathering", { gap: "§gap/payday", person: "Toni Diaz", why: WHY, public_title: "Pay day 2", goal: "Which day", question: "Which day?" }));
    assert.deepEqual(statechartStarted(gap.id), { by: "project-overseer", overseerId: overseerId(), why: WHY });
    assert.equal(hostOf(org.id).data(baton.batonSid(org.id, gap.id))?.["startedVia"], "overseer", "a gap's start no longer drops startedVia");
    assert.deepEqual((await toldOf(gap.id)).startedFor, { kind: "gap", id: "§gap/payday", title: "Nobody decided the pay day" });
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L0" });
    await run("sova_idea", { op: "add", id: "§gap/vat", title: "VAT" });
    await po.toolsForTest(org.id, project.id, { attended: false }).find((x) => x.name === "sova_start_gathering")!
      .execute("c2", { gap: "§gap/vat", plan: true, person: "Toni Diaz", why: "Planned: the VAT rate is open.", public_title: "VAT rate", goal: "Which VAT rate", question: "Which VAT rate?" } as never, undefined, undefined, undefined as never);
    await po.patchProjectOverseer(org.id, project.id, { autonomy: "L1" });
    await new Promise((r) => setTimeout(r, 100));
    const planned = baton.allBatons().find((b) => b.publicTitle === "VAT rate");
    assert.ok(planned, "the statechart started the plan");
    assert.deepEqual(statechartStarted(planned.sessionId), { by: "project-overseer", overseerId: overseerId(), why: "Planned: the VAT rate is open." });
  });

  test("a session from before `started`: the owner says who, the transition log's start row says which conversation", async () => {
    const { id } = detailsOf(await run("sova_start_gathering", { gap: "none", person: "Tony Reyes", why: WHY, public_title: "Old", goal: "g", question: "q?" }));
    const row = baton.batonById(id)!.row;
    // Its statechart data as a session started before `started` has it.
    const { started: _started, ...old } = told.batonData(row)!;
    assert.deepEqual(told.startedOf(row, old), { who: "project-overseer", at: row.createdAt, overseer: { id: overseerId(), current: true } }, "no why: none was recorded, none is guessed");
  });

  test("404 for a session that isn't a gathering session", async () => {
    assert.equal((await app.request("/api/baton/not-a-session/told")).status, 404);
  });
});

describe("what it is told: the prompt as the file last recorded it (§app.baton/told)", () => {
  test("pi 0.86+ entries replayed by pi-ai: sections patched by name, tools added and removed, the wrap-up apart", async () => {
    const { id, path } = detailsOf(await run("sova_start_gathering", { gap: "none", person: "Toni Diaz", why: WHY, public_title: "Replay", goal: "g", question: "q?" }));
    append(path, [
      { type: "model_change", timestamp: "2026-09-30T10:00:00.000Z", provider: "zai", modelId: "glm-5.3" },
      { type: "thinking_level_change", timestamp: "2026-09-30T10:00:00.000Z", thinkingLevel: "low" },
      system("2026-09-30T10:00:01.000Z", { sections: { preamble: "PREAMBLE-ONE private steering", cwd: "<cwd>(none)</cwd>" }, toolsAdded: ["hand_to", "goal_done", "record_decision", "propose_roster_edit"].map((n) => decl(n)) }),
      { type: "message", timestamp: "2026-09-30T10:01:00.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
      // Read links turned on, then a hand-off re-renders the prompt; read_link turned off again (tools only).
      system("2026-09-30T10:02:00.000Z", { toolsAdded: [decl("read_link", "Open a page someone wrote.")] }),
      system("2026-09-30T10:03:00.000Z", { sections: { preamble: "PREAMBLE-TWO after the hand-off" } }),
      system("2026-09-30T10:04:00.000Z", { toolsRemoved: [{ name: "read_link" }] }),
    ]);
    let t = await toldOf(id);
    assert.equal(t.prompt.kind, "recorded");
    if (t.prompt.kind !== "recorded") return;
    assert.equal(t.prompt.text, "PREAMBLE-TWO after the hand-off\n\n<cwd>(none)</cwd>", "the section patched by name, the other kept");
    assert.equal(t.prompt.at, "2026-09-30T10:03:00.000Z", "last changed: the last entry that changed the text");
    assert.equal(t.prompt.changes, 2);
    assert.deepEqual(t.tools.map((x) => x.name), ["hand_to", "goal_done", "record_decision", "propose_roster_edit"], "read_link added, then removed");
    assert.deepEqual(t.tools[0], { name: "hand_to", description: "hand_to does its thing.", parameters: decl("hand_to").parameters });
    assert.deepEqual(t.inactive.map((x) => x.name), ["read_link", "write_profile_updates"]);
    assert.equal(t.model, "zai/glm-5.3");
    assert.equal(t.thinking, "low");
    assert.equal(t.wrapup, undefined);

    append(path, [system("2026-09-30T10:05:00.000Z", { toolsAdded: [decl("read_link", "Open a page someone wrote.")] })]);
    t = await toldOf(id);
    assert.deepEqual(t.tools.find((x) => x.name === "read_link"), { name: "read_link", description: "Open a page someone wrote.", parameters: decl("read_link").parameters, ability: "Read links" });
    assert.deepEqual(t.inactive.map((x) => x.name), ["write_profile_updates"]);

    // The wrap-up: its own prompt, apart; the conversation's stays the one before it.
    append(path, [system("2026-09-30T11:00:00.000Z", { sections: { preamble: WRAPUP_SYSTEM }, toolsAdded: [decl("write_profile_updates")], toolsRemoved: ["hand_to", "goal_done", "record_decision", "propose_roster_edit", "read_link"].map((name) => ({ name })) })]);
    t = await toldOf(id);
    assert.equal(t.prompt.kind === "recorded" && t.prompt.text, "PREAMBLE-TWO after the hand-off\n\n<cwd>(none)</cwd>");
    assert.deepEqual(t.wrapup, { text: `${WRAPUP_SYSTEM}\n\n<cwd>(none)</cwd>`, at: "2026-09-30T11:00:00.000Z" });
    assert.deepEqual(t.tools.map((x) => x.name), ["hand_to", "goal_done", "record_decision", "propose_roster_edit", "read_link"], "the conversation's tools");
  });

  test("the replay is pi-ai's, resolved beside the pi package", async () => {
    const r = await told.piReplay();
    assert.equal(typeof r.getCurrentSystemPrompt, "function");
    assert.equal(r.getCurrentSystemPrompt([{ role: "system", content: "base", sections: { a: "A" }, timestamp: 1 } as never]), "base\n\nA");
  });

  test("the loadout's tools it lacks, by name, and a model the file never recorded", () => {
    assert.deepEqual(told.inactiveTools(["hand_to", "goal_done", "record_decision", "propose_roster_edit", "read_link", "write_profile_updates"]), []);
    assert.deepEqual(told.recordedModel([]), { model: null, thinking: null });
  });
});

void toni;
