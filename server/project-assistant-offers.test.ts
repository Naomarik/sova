// Run: pnpm test server/project-assistant-offers.test.ts. What the Project Assistant offers (§app.project-assistant/offers):
// at each reply its prompt and tool list follow the question Home's card asks, for the owner's turns and the operator's
// alike; an ability offered nowhere is never mentioned; several projects are named; a change between replies gets one
// hidden note. Stand-in answers for the question (setWouldActFactsForTest) on a real throwaway org; the loadout's own
// spec and runStart are called in-process. No model is called, no act is set off, no chat process runs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { BATON_SENT_ENTRY, OPERATOR } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import type { RunStartAnswer } from "../shared/chat-runtime";
import { assistantDefaults, type PowerMap } from "../shared/powers";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-pa-offers-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const would = await import("./assistant-would-act");
const offersMod = await import("./project-assistant-offers");
const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const pa = await import("./project-assistant");
const { OFFERS_NOTE } = await import("./project-assistant-loadout");
const { specialHostOf } = await import("./chat-handle");
const { settled } = await import("./workspace-git");

after(async () => {
  await settled(join(root, "ws"));
});
afterEach(() => would.setWouldActFactsForTest(null));

const ALL: (keyof PowerMap)[] = ["codingStart", "copiesRun", "deploy", "gather"];
const on = (...ps: (keyof PowerMap)[]): PowerMap => ({ ...assistantDefaults(), ...Object.fromEntries(ps.map((p) => [p, true])) });
interface Fixture {
  column?: PowerMap;
  braked?: boolean;
  release?: boolean;
  version?: boolean;
  limit?: boolean;
}
/** Stand-in facts per project id ("*" for any other): unset is every switch On, a waiting period, release steps and a version. */
function facts(per: Record<string, Fixture>): import("./assistant-would-act").WouldActFacts {
  const of = (id: string): Fixture => per[id] ?? per["*"] ?? {};
  const refusal = (id: string) => (of(id).limit ? { code: "limit", sentence: "The day's limit is reached." } : null);
  return {
    column: (id) => ({ assistant: of(id).column ?? on(...ALL), models: null }),
    braked: async (id) => of(id).braked ?? false,
    codingModel: () => ({ model: "scripted/scripted" }),
    gatheringModel: () => ({ model: "scripted/scripted" }),
    hasRelease: async (id) => of(id).release ?? true,
    hasVersion: async (_o, id) => of(id).version ?? true,
    engine: async (id) => ({ refusal: refusal(id), holdMs: 600_000 }),
    placement: async (_o, id) => ({ refusal: refusal(id) }),
  };
}

const org = await orgs.createOrg({ name: "Rakiba", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
await owner.setOwner(org.id, alp.id);
mkdirSync(join(root, "designs"));
const designs = await orgs.addProject(org.id, { name: "RakibaDesigns", root: join(root, "designs") });
store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" } } });
const { path } = await pa.ensureAssistant(org.id);
const host = specialHostOf("project-assistant")!;

const at = "2026-10-24T00:00:00.000Z";
const ownerTurn: HEntry[] = [{ id: "u1", parentId: null, at, kind: "user", blocks: [{ type: "text", text: "It's broken" }] as never }];
const operatorTurn: HEntry[] = [
  { id: "u2", parentId: null, at, kind: "user", blocks: [{ type: "text", text: "Start a fix" }] as never },
  { id: "k2", parentId: null, at, kind: "state", key: BATON_SENT_ENTRY, data: { v: 1, targetId: "u2", by: OPERATOR } },
];
const runStart = (branch: HEntry[] = ownerTurn): Promise<RunStartAnswer> => host.runStart(path, { branch: () => branch, leafId: () => null } as never, { images: false });
const promptOf = (a: RunStartAnswer) => a.prompt.customPrompt ?? "";

describe("one project: the prompt and the tools follow the answers", () => {
  test("everything On: every offer, every tool, no names", async () => {
    would.setWouldActFactsForTest(facts({}));
    await host.spec(path);
    const a = await runStart();
    for (const t of ["start_fix", "start_feature_chat", "deploy", "start_version", "owner_versions", "report_issue"]) assert.ok(a.activeTools?.includes(t), t);
    const p = promptOf(a);
    assert.match(p, /^- When a problem needs fixing, offer to start a fix with `start_fix`/m);
    assert.match(p, /call `start_feature_chat`/);
    assert.match(p, /and no planning chat is opened for it, it is a requirement/);
    assert.match(p, /use `deploy` and say what its answer says\. It starts the release itself/);
    assert.match(p, /offer to start it with `start_version`/);
    assert.doesNotMatch(p, /\{\{[A-Z_]+\}\}/, "every placeholder filled");
    assert.equal(a.message, undefined, "nothing changed since the chat opened: no note");
  });

  test("Start coding sessions Off: no fix offer and no start_fix, for the owner's turn and the operator's alike", async () => {
    would.setWouldActFactsForTest(facts({ "*": { column: on("copiesRun", "deploy", "gather") } }));
    for (const branch of [ownerTurn, operatorTurn]) {
      const a = await runStart(branch);
      assert.ok(!a.activeTools?.includes("start_fix"), "start_fix not in the tool list");
      assert.ok(a.activeTools?.includes("start_feature_chat"));
      assert.doesNotMatch(promptOf(a), /start_fix|start a fix/);
      assert.match(promptOf(a), /file it with `report_issue` \(kind `bug`\)/, "a problem is still filed");
    }
  });

  test("gather Off: no planning chat anywhere; asking for something new is the requirement path, as the normal way", async () => {
    would.setWouldActFactsForTest(facts({ "*": { column: on("codingStart", "copiesRun", "deploy") } }));
    const a = await runStart(operatorTurn);
    assert.ok(!a.activeTools?.includes("start_feature_chat"));
    assert.ok(a.activeTools?.includes("start_fix"));
    const p = promptOf(a);
    assert.doesNotMatch(p, /planning chat|start_feature_chat/);
    assert.match(p, /^- When Alperen asks for something new or a change to how something works, it is a requirement:/m);
    assert.doesNotMatch(p, /\boff\b|isn't allowed|can't open/, "never framed as a refusal");
    // gather On again: offered.
    would.setWouldActFactsForTest(facts({}));
    const b = await runStart();
    assert.ok(b.activeTools?.includes("start_feature_chat"));
    assert.match(promptOf(b), /offer to plan it with them in a planning chat/);
  });

  test("a brake (paused): nothing is offered; releasing goes to the team, opening a version stays", async () => {
    would.setWouldActFactsForTest(facts({ "*": { braked: true } }));
    const a = await runStart();
    assert.ok(!a.activeTools?.includes("start_fix") && !a.activeTools?.includes("start_feature_chat"));
    for (const t of ["deploy", "start_version", "owner_versions"]) assert.ok(a.activeTools?.includes(t), t);
    const p = promptOf(a);
    assert.doesNotMatch(p, /start_fix|start_feature_chat|planning chat|starts the release itself|offer to start it/);
    assert.match(p, /It asks the team to release it/);
    assert.match(p, /One that is running or starting can always be opened/);
    assert.match(p, /isn't started from here/);
    // The two worded tools are registered again with words that never claim it acts itself.
    const words = Object.fromEntries((a.reregister ?? []).map((d) => [d.name, d.description]));
    assert.match(words.deploy ?? "", /never releases on its own/);
    assert.match(words.start_version ?? "", /^Open a version/);
  });

  test("a daily limit reached: the same as Off (the whole question, not only the switch)", async () => {
    would.setWouldActFactsForTest(facts({ "*": { limit: true } }));
    const a = await runStart();
    assert.ok(!a.activeTools?.includes("start_fix") && !a.activeTools?.includes("start_feature_chat"));
  });

  test("no release steps: it never says the team will release it", async () => {
    would.setWouldActFactsForTest(facts({ "*": { release: false } }));
    const p = promptOf(await runStart());
    assert.match(p, /It sends the request to the team: say it's with the team, and never that it is released or that the team will release it\./);
    assert.doesNotMatch(p, /asks the team to release it|starts the release itself/);
  });
});

describe("a change between replies: one hidden note", () => {
  test("a switch flipped Off: the next reply's note names it, once; flipped back: named as offered", async () => {
    would.setWouldActFactsForTest(facts({}));
    await runStart();
    assert.equal((await runStart()).message, undefined, "no change, no note");
    would.setWouldActFactsForTest(facts({ "*": { column: on("copiesRun", "deploy", "gather") } }));
    const a = await runStart();
    assert.equal(a.message?.customType, OFFERS_NOTE);
    assert.equal(a.message?.display, false);
    assert.match(a.message!.content, /No longer offered: starting a fix\. Don't follow up an earlier offer of it/);
    assert.doesNotMatch(a.message!.content, /Now offered/);
    assert.doesNotMatch(a.message!.content, /codingStart|Start coding sessions|switch/, "never a switch's name");
    assert.equal((await runStart()).message, undefined, "once");
    would.setWouldActFactsForTest(facts({}));
    assert.match((await runStart()).message?.content ?? "", /Now offered: starting a fix\./);
  });

  test("the worded tools are registered again only when their words change", async () => {
    would.setWouldActFactsForTest(facts({}));
    await runStart();
    assert.equal((await runStart()).reregister, undefined);
    would.setWouldActFactsForTest(facts({ "*": { column: on("codingStart", "gather") } }));
    const a = await runStart();
    assert.deepEqual((a.reregister ?? []).map((d) => d.name).sort(), ["deploy", "start_version"]);
    assert.equal((await runStart()).reregister, undefined);
  });
});

describe("several projects", () => {
  test("an ability on for only some: the prompt names them; the note names them too", async () => {
    mkdirSync(join(root, "shop"));
    const shop = await orgs.addProject(org.id, { name: "Rakiba Shop", root: join(root, "shop") });
    would.setWouldActFactsForTest(facts({ [designs.id]: {}, [shop.id]: { column: on("deploy") } }));
    await runStart();
    const p = promptOf(await runStart());
    assert.match(p, /^- When a problem in RakibaDesigns needs fixing, offer to start a fix/m);
    assert.match(p, /For any other project, the problem you filed is with the team/);
    assert.match(p, /something new in RakibaDesigns that needs planning/);
    assert.match(p, /For RakibaDesigns, you can also offer to start one that isn't running/);
    assert.match(p, /It starts the release itself|starts the release itself/);
    would.setWouldActFactsForTest(facts({ "*": { column: on("deploy") } }));
    const a = await runStart();
    assert.match(a.message?.content ?? "", /No longer offered: .*starting a fix \(RakibaDesigns\)/);
    assert.ok(!a.activeTools?.includes("start_fix"));
  });
});

describe("offerLines, unit", () => {
  const ok = { outcome: "now" as const, reason: "ok" as const };
  const team = { outcome: "team" as const, reason: "power-off" as const };
  test("mixed release answers are named per group", () => {
    const o = {
      projects: [
        { id: "a", name: "A", fix: team, version: team, feature: team, release: ok },
        { id: "b", name: "B", fix: team, version: team, feature: team, release: team },
        { id: "c", name: "C", fix: team, version: team, feature: team, release: { outcome: "team" as const, reason: "no-recipe" as const } },
      ],
    };
    const r = offersMod.offerLines(o).release;
    assert.match(r, /For A, it starts the release itself/);
    assert.match(r, /For B, it asks the team to release it/);
    assert.match(r, /For C, it sends the request to the team/);
    assert.deepEqual(offersMod.hiddenTools(o), ["start_fix", "start_feature_chat"]);
    assert.equal(offersMod.offerLines(o).fix, "");
    assert.equal(offersMod.offerLines(o).planning, "");
  });
});
