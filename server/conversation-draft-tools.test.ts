// Run: env -u SOVA_CHAT_UNIT pnpm test server/conversation-draft-tools.test.ts. A conversation's draft
// record, its tools, the operator's query, approve and build, end to end on plain folders in the OS temp
// dir: no org, no registry (setDraftPlaceForTest), the spec draft tool in-process (server/spec-tool-fake.ts).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { scratchRoot } from "./test-scratch";
import type { HEntry } from "../shared/harness";

const tmp = scratchRoot("sova-conv-tools-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const writer = await import("./spec-draft-writer");
const fake = (await import("./spec-tool-fake")).fakeDraftTool();
let toolCalls = 0;
writer.setDraftToolForTest(async (root, args) => {
  toolCalls++;
  return fake(root, args);
});
const tools = await import("./conversation-draft-tools");
const routes = await import("./conversation-draft-routes");
const store = await import("./conversation-draft-store");

/** A project: its root with a seed spec, and its workspace. */
function project(pid: string) {
  const root = join(tmp, pid, "root");
  const workspace = join(tmp, pid, "ws");
  mkdirSync(join(root, ".sova", "spec", "claims", "site"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(root, ".sova", "spec", "manifest.json"),
    `${JSON.stringify({ formatVersion: 1, claims: { "§site/pages": { kind: "surface", authority: "accepted" }, "§site.pages/home": { kind: "behavior", authority: "accepted" } } }, null, 2)}\n`,
  );
  writeFileSync(join(root, ".sova", "spec", "claims", "site", "pages.md"), "# §site/pages — Pages\n\nThe website's pages.\n\n## §site.pages/home — Home\n\nThe home page shows the next class dates.\n");
  return { root, workspace, name: `Archery site ${pid}` };
}
const places = new Map<string, ReturnType<typeof project>>();
tools.setDraftPlaceForTest((pid) => {
  const p = places.get(pid);
  if (!p) throw new Error("Unknown project");
  return p;
});

function current(root: string): Record<string, string> {
  const spec = join(root, ".sova", "spec");
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = relative(spec, p);
      if (rel === "drafts" || rel === ".gitignore") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(spec);
  return out;
}

let n = 0;
function conversation(pid: string) {
  const sessionId = `0000000${++n}-aaaa-4bbb-8ccc-0123456789ab`;
  const ref = { sessionId, projectId: pid, kind: "gathering" as const, title: "Your archery website", person: { id: "p_alperen", name: "Alperen" } };
  // A transcript the tools read: entries appended as the test goes.
  const branch: HEntry[] = [];
  let leaf = 0;
  const say = (kind: "user" | "assistant") => {
    const id = `e${++leaf}`;
    branch.push({ id, kind, blocks: [] } as unknown as HEntry);
    return id;
  };
  const ctx = { leafId: () => branch.at(-1)?.id ?? null, branch: () => branch } as any;
  const t = tools.conversationDraftTools({ sessionId, conversation: () => ref, projects: () => [{ projectId: pid }] });
  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = t.find((x) => x.name === name)!;
    const r = await tool.execute("c", params as any, undefined, undefined, ctx);
    return (r.content[0] as { text: string }).text;
  };
  let d = 0;
  const agree = (statement: string, change: { changes?: string; changesHash?: string } = {}) => {
    const entryId = say("user");
    return tools.agreeRequirement(ref, { decisionId: `${sessionId}:d${++d}`, area: "Content editing", areaKey: "content-editing", statement, quote: `I'd like ${statement.toLowerCase()}`, by: "p_alperen", name: "Alperen", at: "2026-10-17T10:00:00Z", entryId }, change);
  };
  const rec = () => store.readRecord(places.get(pid)!.workspace, pid, sessionId)!;
  return { sessionId, ref, say, call, agree, rec };
}

describe("agreeing, catching up, locking in", () => {
  const P = "prj_lockin";
  places.set(P, project(P));
  const p = places.get(P)!;
  const c = conversation(P);

  test("a recorded decision becomes item r1 of the conversation's record; the record is unconfirmed", async () => {
    const out = await c.agree("The founder edits class dates himself.");
    assert.equal(out.itemId, "r1");
    const rec = c.rec();
    assert.equal(rec.state, "unconfirmed");
    assert.equal(rec.draft, `conv-${c.sessionId}`);
    assert.deepEqual(rec.items.map((i) => [i.id, i.kind, i.status]), [["r1", "new", "agreed"]]);
    // Another decision is another item; the same decision noted twice (a retry) is still one.
    assert.equal((await c.agree("The founder edits class dates himself.").then(() => c.rec())).items.length, 2);
    const again = await tools.agreeRequirement(c.ref, { decisionId: `${c.sessionId}:d1`, area: "Content editing", areaKey: "content-editing", statement: "x", quote: "x", by: "p_alperen", name: "Alperen", at: "2026-10-17T10:00:00Z", entryId: "e1" });
    assert.equal(again.itemId, "r1");
    assert.equal(c.rec().items.length, 2);
  });

  test("the catch-up builds the draft, leaves current byte for byte, and does nothing the second time", async () => {
    const before = current(p.root);
    const out = await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    assert.deepEqual(out, { notes: [] });
    assert.ok(writer.draftExists(p.root, c.rec().draft));
    assert.deepEqual(current(p.root), before);
    const calls = toolCalls;
    const rec = c.rec();
    await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    assert.equal(toolCalls, calls, "an unchanged catch-up runs no spec tool");
    assert.deepEqual(c.rec(), rec);
  });

  test("requirement_drop drops an item; an unknown id is refused", async () => {
    assert.match(await c.call("requirement_drop", { id: "r2" }), /Dropped r2/);
    assert.equal(c.rec().items.find((i) => i.id === "r2")!.status, "dropped");
    await assert.rejects(c.call("requirement_drop", { id: "r9" }), /no requirement r9/);
  });

  test("confirm: refused before a summary, and before the person answers it; accepted after their message", async () => {
    await assert.rejects(c.call("requirements_confirm", { summary: "x" }), /requirements_summary/);
    c.say("assistant");
    const text = await c.call("requirements_summary");
    assert.match(text, /r1: The founder edits class dates himself\./);
    assert.doesNotMatch(text, /r2/);
    assert.ok(c.rec().summaryShownAt);
    await assert.rejects(c.call("requirements_confirm", { summary: "You edit class dates yourself." }), /Wait for the person's answer/);
    c.say("user");
    assert.match(await c.call("requirements_confirm", { summary: "You edit class dates yourself." }), /Locked in/);
    const rec = c.rec();
    assert.equal(rec.state, "confirmed");
    assert.equal(rec.confirmedSummary, "You edit class dates yourself.");
  });

  test("a requirement added after the summary needs a new summary, even when the person writes after it", async () => {
    const d = conversation(P);
    await d.agree("Archers book lanes online.");
    d.say("assistant");
    await d.call("requirements_summary");
    // "Mostly right, but add branding": the chat records it, the person writes again.
    await d.agree("The site uses the academy's branding.");
    d.say("user");
    await assert.rejects(d.call("requirements_confirm", { summary: "Lanes and branding." }), /requirements_summary/);
    d.say("assistant");
    await d.call("requirements_summary");
    await assert.rejects(d.call("requirements_confirm", { summary: "Lanes and branding." }), /Wait for the person's answer/);
    d.say("user");
    assert.match(await d.call("requirements_confirm", { summary: "Lanes and branding." }), /Locked in/);
    assert.equal(tools.goalDoneRefusalOf(d.rec()), null, "confirmed: the conversation may end");
    // A drop after the lock-in unconfirms it too, and the conversation can't end on the model's word.
    await d.call("requirement_drop", { id: "r2" });
    assert.match(tools.goalDoneRefusalOf(d.rec())!, /Repeat back what's agreed and get a clear yes first/);
    await d.call("requirement_drop", { id: "r1" });
    assert.equal(tools.goalDoneRefusalOf(d.rec()), null, "nothing agreed left: nothing to confirm");
    assert.equal(d.rec().state, "unconfirmed");
    assert.equal(d.rec().summaryShownAt, null);
  });

  test("anything agreed after the lock-in makes it unconfirmed again, until a new summary is confirmed", async () => {
    await c.agree("Prices show in riyals.");
    const rec = c.rec();
    assert.equal(rec.state, "unconfirmed");
    assert.equal(rec.summaryShownAt, null);
    await assert.rejects(c.call("requirements_confirm", { summary: "again" }), /requirements_summary/);
  });

  test("no timer: an unconfirmed record stays unconfirmed, and current is unchanged after a confirmed conversation", async () => {
    c.say("assistant");
    await c.call("requirements_summary");
    c.say("user");
    await c.call("requirements_confirm", { summary: "Dates and riyals." });
    await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    assert.equal(c.rec().state, "confirmed");
    // Master unchanged after a confirmed conversation (al_2 a13).
    assert.deepEqual(Object.keys(current(p.root)).sort(), ["claims/site/pages.md", "manifest.json"]);
    assert.equal(JSON.parse(readFileSync(join(p.root, ".sova/spec/manifest.json"), "utf8")).claims["§requirements/content-editing"], undefined);
  });
});

describe("a change, its clash, and the operator's query", () => {
  const P = "prj_change";
  places.set(P, project(P));
  const p = places.get(P)!;
  const c = conversation(P);

  test("a spec look-up reference resolves to its record and hash; another conversation's reference is refused", async () => {
    tools.setResolveRefForTest((sid, ref) => (sid === c.sessionId && ref === "s1" ? { projectId: P, id: "§site.pages/home" } : null));
    const ch = await tools.changeOfRef(c.sessionId, P, "s1");
    assert.equal(ch.changes, "§site.pages/home");
    assert.match(ch.changesHash!, /^[0-9a-f]{64}$/);
    await assert.rejects(tools.changeOfRef(c.sessionId, P, "s2"), /not a reference spec_lookup gave/);
    assert.deepEqual(await tools.changeOfRef(c.sessionId, P, undefined), {});
    await c.agree("Home shows the next tournament too.", ch);
    await c.agree("A gallery per class.");
  });

  test("the query lists new items and changes with the current text; a moved target is a clash the chat is told to re-check", async () => {
    await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    let [d] = await routes.listDraftSpecs(P);
    assert.equal(d!.projectName, p.name);
    assert.equal(d!.person, "Alperen");
    assert.equal(d!.state, "unconfirmed");
    assert.deepEqual(d!.newItems.map((i) => i.text), ["A gallery per class."]);
    assert.equal(d!.changes[0]!.target, "§site.pages/home");
    assert.match(d!.changes[0]!.currentText!, /next class dates/);
    assert.equal(d!.clashes, 0);
    const file = join(p.root, ".sova/spec/claims/site/pages.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("next class dates", "next class dates and prices"));
    const out = await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    assert.equal(out!.notes.length, 1);
    assert.match(out!.notes[0]!, /check that requirement with the person again/);
    [d] = await routes.listDraftSpecs(P);
    assert.equal(d!.clashes, 1);
    const text = routes.draftSpecsText(await routes.listDraftSpecs(P), true);
    assert.match(text, /Not confirmed yet/);
    assert.match(text, /Change to §site\.pages\/home \[agreed, clash: changed\]/);
    assert.match(text, /New \[agreed\]: A gallery per class\./);
  });

  test("approve: the new item is promoted into current at once; the change waits for a build; approving again promotes nothing twice", async () => {
    const out = await routes.approveDraft(P, c.sessionId);
    assert.deepEqual(out.promoted, ["r2"]);
    assert.deepEqual(out.waitingForBuild, ["r1"]);
    assert.deepEqual(out.alreadyPromoted, []);
    const m = JSON.parse(readFileSync(join(p.root, ".sova/spec/manifest.json"), "utf8"));
    const rid = c.rec().items.find((i) => i.id === "r2")!.recordId!;
    assert.equal(m.claims[rid].decision, `${c.sessionId}:d2`);
    // The change's target is untouched: only a build changes it.
    assert.match(readFileSync(join(p.root, ".sova/spec/claims/site/pages.md"), "utf8"), /## §site\.pages\/home — Home\n\nThe home page shows the next class dates and prices\./);
    assert.equal(out.draft.newItems[0]!.status, "promoted");
    assert.equal(out.draft.changes[0]!.status, "approved");
    const again = await routes.approveDraft(P, c.sessionId);
    assert.deepEqual([again.promoted, again.alreadyPromoted], [[], ["r2"]]);
  });

  test("build: a coding session whose first prompt names the draft and holds the change; built once its note is current", async () => {
    const seen: { title: string; prompt: string; extra?: { conversationDraft: string } }[] = [];
    routes.setDraftBuildStarterForTest(async (_pid, input) => {
      seen.push(input);
      return { sessionId: "coding-1", path: "/x.jsonl" };
    });
    const out = await routes.buildDraft(P, c.sessionId);
    // Every item not built or dropped: the change, and the new requirement promoted at approve (not built yet).
    assert.deepEqual([out.sessionId, out.items], ["coding-1", ["r1", "r2"]]);
    const asked = seen[0];
    assert.ok(asked);
    assert.match(asked!.prompt, new RegExp(`conv-${c.sessionId}`));
    assert.match(asked!.prompt, /Change to §site\.pages\/home: Home shows the next tournament too\./);
    assert.match(asked!.prompt, /## New requirements\n\n### New requirement \(in the spec, not built yet\): A gallery per class\./);
    assert.match(asked!.prompt, /## Changes to existing behaviour\n\n### Change to/);
    assert.match(asked!.prompt, /1 new requirement and 1 change to existing behaviour/);
    assert.equal(asked!.extra?.conversationDraft, `conv-${c.sessionId}`);
    assert.equal(c.rec().items.find((i) => i.id === "r1")!.buildSessionId, "coding-1");
    // The coding session promoted the change's note: the item reads built.
    const rid = c.rec().items.find((i) => i.id === "r1")!.recordId!;
    const mp = join(p.root, ".sova/spec/manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.claims[rid] = { kind: "note", authority: "accepted", decision: `${c.sessionId}:d1`, changes: "§site.pages/home" };
    writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
    let [d] = await routes.listDraftSpecs(P, c.sessionId);
    assert.equal(d!.changes[0]!.status, "built");
    // The new requirement is still promoted, not built: a second build takes it alone.
    assert.equal(d!.newItems[0]!.status, "promoted");
    assert.deepEqual((await routes.buildDraft(P, c.sessionId)).items, ["r2"]);
    // Its record now maps code with verified evidence: built, and nothing is left to build.
    const r2 = c.rec().items.find((i) => i.id === "r2")!.recordId!;
    const m2 = JSON.parse(readFileSync(mp, "utf8"));
    m2.claims[r2] = { ...m2.claims[r2], code: ["src/gallery.ts"], evidence: "verified" };
    writeFileSync(mp, `${JSON.stringify(m2, null, 2)}\n`);
    [d] = await routes.listDraftSpecs(P, c.sessionId);
    assert.equal(d!.newItems[0]!.status, "built");
    await assert.rejects(routes.buildDraft(P, c.sessionId), /Nothing in this draft is waiting/);
    routes.setDraftBuildStarterForTest(null);
  });

  test("the routes: GET /api/draft-specs, approve 200, build 202, an unknown conversation 404", async () => {
    const app = new Hono();
    routes.registerConversationDraftRoutes(app);
    const list = await app.request(`/api/draft-specs?project=${P}`);
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as any).drafts.length, 1);
    const none = await app.request(`/api/projects/${P}/draft-specs/nope/approve`, { method: "POST" });
    assert.equal(none.status, 404);
    const ok = await app.request(`/api/projects/${P}/draft-specs/${c.sessionId}/approve`, { method: "POST", body: JSON.stringify({ items: ["r2"] }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as any).alreadyPromoted, ["r2"]);
    const bad = await app.request(`/api/projects/${P}/draft-specs/${c.sessionId}/approve`, { method: "POST", body: JSON.stringify({ items: "r2" }) });
    assert.equal(bad.status, 400);
  });
});

describe("the legacy promotion path and the draft", () => {
  test("a decision promoted the old way reads promoted in its draft, and leaves the draft's changes", async () => {
    const P = "prj_legacy";
    places.set(P, project(P));
    const p = places.get(P)!;
    const c = conversation(P);
    await c.agree("Members see their own scores.");
    await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    const rid = c.rec().items[0]!.recordId!;
    // The legacy path promoted the same decision, under a record id of its own.
    const mp = join(p.root, ".sova/spec/manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.claims["§requirements.scores/members-see-their-own-scores"] = { kind: "note", authority: "accepted", decision: `${c.sessionId}:d1` };
    writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
    mkdirSync(join(p.root, ".sova/spec/claims/requirements"), { recursive: true });
    writeFileSync(join(p.root, ".sova/spec/claims/requirements/scores.md"), "# §requirements/scores — Scores\n\nScores.\n\n## §requirements.scores/members-see-their-own-scores — Members see their own scores.\n\nMembers see their own scores.\n");
    routes.markDecisionItemsPromoted(P, [`${c.sessionId}:d1`]);
    await tools.catchUpConversationDraft(c.sessionId, P, c.ref);
    const item = c.rec().items[0]!;
    assert.equal(item.status, "promoted");
    assert.equal(item.recordId, "§requirements.scores/members-see-their-own-scores");
    assert.notEqual(item.recordId, rid);
    const out = await routes.approveDraft(P, c.sessionId);
    assert.deepEqual([out.promoted, out.alreadyPromoted], [[], ["r1"]]);
    assert.equal(existsSync(join(p.root, ".sova/spec/claims/requirements/content-editing.md")), false);
  });
});

describe("the overseers' draft tools", () => {
  test("sova_draft_specs reads; approve and build are refused unless the operator is in the turn", async () => {
    const P = "prj_overseer";
    places.set(P, project(P));
    const c = conversation(P);
    await c.agree("Results are posted after each tournament.");
    const specs = routes.draftSpecsTool(P);
    const text = ((await specs.execute("t", {} as any, undefined, undefined, undefined)).content[0] as { text: string }).text;
    assert.match(text, /New \[agreed\]: Results are posted after each tournament\./);
    assert.match(text, /Their words: "I'd like results are posted after each tournament\."/);
    let attended = false;
    const [approve, build] = routes.draftActTools({ ownProject: P, attended: () => attended });
    await assert.rejects(approve!.execute("t", { session: c.sessionId } as any, undefined, undefined, undefined), /Approving a draft is the operator's: ask them\./);
    await assert.rejects(build!.execute("t", { session: c.sessionId } as any, undefined, undefined, undefined), /operator's: ask them/);
    assert.equal(c.rec().items[0]!.status, "agreed");
    attended = true;
    // The project folder on a feature branch: refused even for the operator, nothing written.
    tools.setApproveBranchForTest(async () => ({ inGit: true, checkedOut: "feat/x", main: "master" }));
    await assert.rejects(approve!.execute("t", { session: c.sessionId } as any, undefined, undefined, undefined), /^Error: The project folder is on feat\/x; approving writes into master's spec\. Switch it to master first\.$/);
    assert.equal(c.rec().items[0]!.status, "agreed");
    tools.setApproveBranchForTest(async () => ({ inGit: true, checkedOut: "master", main: "master" }));
    const out = ((await approve!.execute("t", { session: c.sessionId } as any, undefined, undefined, undefined)).content[0] as { text: string }).text;
    tools.setApproveBranchForTest(null);
    assert.match(out, /Promoted: r1\./);
  });
});
