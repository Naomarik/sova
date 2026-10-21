// Run: pnpm test server/assistant-would-act.test.ts. The one question "what would the Project Assistant do if asked
// now?" (§app.project-assistant/abilities): each step of its order on stand-in facts, the server's own facts on a real
// throwaway org, and that the owner page's card and the tools give the same answer on the same fixtures.
// Throwaway workspace and PI_CODING_AGENT_DIR; no model is called, no act is set off.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import type { HEntry } from "../shared/harness";
import { assistantDefaults, type PowerMap } from "../shared/powers";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-would-act-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const would = await import("./assistant-would-act");
const tools = await import("./project-assistant-tools");
const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const poStore = await import("./project-overseer-store");
const { ownerHome } = await import("./owner-page");
const { handleOf } = await import("./person-links");
const { settled } = await import("./workspace-git");

after(async () => {
  await settled(join(root, "ws"));
});
afterEach(() => {
  would.setWouldActFactsForTest(null);
  tools.setAssistantActsForTest(null);
});

const on = (...ps: (keyof PowerMap)[]): PowerMap => ({ ...assistantDefaults(), ...Object.fromEntries(ps.map((p) => [p, true])) });

interface Fixture {
  column?: PowerMap | null;
  braked?: boolean | null;
  model?: boolean;
  release?: boolean;
  version?: boolean;
  engine?: { refusal: { code: string; sentence: string } | null; holdMs: number } | null;
}
/** Stand-in facts per project id; unset: everything On and allowed, a 10-minute waiting period. */
function facts(per: Record<string, Fixture>, seen: string[] = []): import("./assistant-would-act").WouldActFacts {
  const of = (id: string): Fixture => per[id] ?? per["*"] ?? {};
  return {
    // A project with no coding model carries `coding: null` in its models (the stand-in codingModel reads it).
    column: (id) => ({ assistant: "column" in of(id) ? of(id).column! : on("codingStart", "copiesRun", "deploy"), models: of(id).model === false ? { coding: null } : null }),
    braked: async (id) => ("braked" in of(id) ? of(id).braked! : false),
    codingModel: (_org, models) => (models && models.coding === null ? null : { model: "scripted/scripted" }),
    hasRelease: async (id) => of(id).release ?? true,
    hasVersion: async (_org, id) => of(id).version ?? true,
    engine: async (id, event) => {
      seen.push(`${id} ${event}`);
      return "engine" in of(id) ? of(id).engine! : { refusal: null, holdMs: 600_000 };
    },
  };
}

describe("assistantWouldAct: the order (stand-in facts)", () => {
  const ask = (f: Fixture, ability: "fix" | "version" | "release", o: { attended?: boolean } = {}) => {
    would.setWouldActFactsForTest(facts({ p: f }));
    return would.assistantWouldAct("org", "p", ability, o);
  };

  test("each switch On: a fix and a release wait the waiting period, a version starts at once", async () => {
    assert.deepEqual(await ask({}, "fix"), { outcome: "held", reason: "ok" });
    assert.deepEqual(await ask({}, "release"), { outcome: "held", reason: "ok" });
    assert.deepEqual(await ask({}, "version"), { outcome: "now", reason: "ok" });
  });

  test("a waiting period of 0: everything starts right away", async () => {
    const f = { engine: { refusal: null, holdMs: 0 } };
    for (const a of ["fix", "release", "version"] as const) assert.equal((await ask(f, a)).outcome, "now", a);
  });

  test("each switch Off: the team, and the engine is not asked", async () => {
    for (const [a, p] of [["fix", "codingStart"], ["version", "copiesRun"], ["release", "deploy"]] as const) {
      const seen: string[] = [];
      const all = on("codingStart", "copiesRun", "deploy");
      would.setWouldActFactsForTest(facts({ p: { column: { ...all, [p]: false } } }, seen));
      const r = await would.assistantWouldAct("org", "p", a);
      assert.deepEqual([r.outcome, r.reason], ["team", "power-off"], a);
      assert.deepEqual(seen, [], `${a}: nothing asked of the engine`);
    }
  });

  test("a brake (paused, or an empty roster): all three read as Off", async () => {
    for (const a of ["fix", "version", "release"] as const) assert.deepEqual([(await ask({ braked: true }, a)).outcome, (await ask({ braked: true }, a)).reason], ["team", "brake"], a);
  });

  test("no coding model: a fix goes to the team; release and version don't need one", async () => {
    would.setWouldActFactsForTest(facts({ p: { model: false } }));
    assert.deepEqual(await would.assistantWouldAct("org", "p", "fix"), { outcome: "team", reason: "no-model", sentence: "no model is set for fixes" });
    assert.equal((await would.assistantWouldAct("org", "p", "release")).outcome, "held");
    assert.equal((await would.assistantWouldAct("org", "p", "version")).outcome, "now");
  });

  test("no version listed: none, whatever the switch", async () => {
    assert.deepEqual(await ask({ version: false }, "version"), { outcome: "none", reason: "no-version" });
    assert.equal((await ask({ version: false, column: assistantDefaults() }, "version")).outcome, "none");
  });

  test("no release steps set up: a release goes to the team", async () => {
    assert.deepEqual([(await ask({ release: false }, "release")).outcome, (await ask({ release: false }, "release")).reason], ["team", "no-recipe"]);
  });

  test("unreadable settings, an unreadable brake or an engine that can't be asked: the team, never a promise", async () => {
    for (const f of [{ column: null }, { braked: null }, { engine: null }] as Fixture[])
      for (const a of ["fix", "version", "release"] as const) assert.deepEqual([(await ask(f, a)).outcome, (await ask(f, a)).reason], ["team", "unreadable"], `${JSON.stringify(f)} ${a}`);
  });

  test("the engine refuses (a limit, a brake it holds, archived): the team, with its sentence for the model", async () => {
    const r = await ask({ engine: { refusal: { code: "limit", sentence: "The day's limit of coding sessions is reached." }, holdMs: 600_000 } }, "fix");
    assert.deepEqual(r, { outcome: "team", reason: "refused", sentence: "The day's limit of coding sessions is reached." });
    assert.equal((await ask({ engine: { refusal: { code: "brake", sentence: "Paused." }, holdMs: 0 } }, "release")).reason, "brake");
  });

  test("the act asked of the engine is the act the tool sets off", async () => {
    const seen: string[] = [];
    would.setWouldActFactsForTest(facts({}, seen));
    for (const a of ["fix", "version", "release"] as const) await would.assistantWouldAct("org", "p", a);
    assert.deepEqual(seen, ["p build/start", "p services/run", "p deploy/run"]);
  });

  test("attended (the operator's own turn): switch, brake and engine are not asked; the model and the release steps are", async () => {
    const seen: string[] = [];
    would.setWouldActFactsForTest(facts({ p: { column: assistantDefaults(), braked: true } }, seen));
    assert.equal((await would.assistantWouldAct("org", "p", "fix", { attended: true })).outcome, "now");
    assert.deepEqual(seen, []);
    would.setWouldActFactsForTest(facts({ p: { release: false } }));
    assert.equal((await would.assistantWouldAct("org", "p", "release", { attended: true })).reason, "no-recipe");
  });
});

// ---- a real org: the page and the tools on the same fixtures -------------------------------------------------

const org = await orgs.createOrg({ name: "Org", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
await owner.setOwner(org.id, alp.id);
mkdirSync(join(root, "designs"));
mkdirSync(join(root, "shop"));
const designs = await orgs.addProject(org.id, { name: "RakibaDesigns", root: join(root, "designs") });
const shop = await orgs.addProject(org.id, { name: "Rakiba Shop", root: join(root, "shop") });
store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" }, coding: { model: "scripted/scripted" } } });

const marker: HEntry = { id: "m0", parentId: null, at: "2026-10-18T00:00:00.000Z", kind: "state", key: "sova-project-assistant", data: { v: 1, orgId: org.id, personId: alp.id } };
const ownerTurn: HEntry = { id: "u1", parentId: null, at: "2026-10-18T00:00:00.000Z", kind: "user", blocks: [{ type: "text", text: "Fix it" }] as never };
function tool(name: string) {
  return tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => [marker, ownerTurn] }).find((t) => t.name === name)!;
}
async function run(name: string, params: Record<string, unknown>): Promise<{ started: boolean; text: string }> {
  const out = (await tool(name).execute("c1", params as never, undefined, undefined, undefined as never)) as { content: { text: string }[]; details: { started?: boolean } };
  return { started: out.details.started === true, text: out.content[0]!.text };
}
/** The acts, standing in: taken (held per the waiting period) unless a test refuses them. Records what was set off. */
function standInActs(set: string[], held = true) {
  tools.setAssistantActsForTest({
    buildStart: async (pid) => (set.push(`${pid} build/start`), { taken: true, held, sessionId: held ? undefined : "s_fix" }),
    deployRun: async (pid) => (set.push(`${pid} deploy/run`), { taken: true, held }),
    copyStart: async (pid) => (set.push(`${pid} services/run`), { taken: true, done: Promise.resolve({ ok: true as const }) }),
  });
}

describe("the owner page's card asks the same question (§app.project-assistant/abilities)", () => {
  test("Home carries each shown project's answers, by its handle, in the cards' order; the tools agree", async () => {
    would.setWouldActFactsForTest(
      facts({
        [designs.id]: {},
        [shop.id]: { column: on("copiesRun", "deploy"), engine: { refusal: { code: "brake", sentence: "Nothing happens without the operator right now." }, holdMs: 600_000 }, version: false },
      }),
    );
    const home = await ownerHome(org.id);
    assert.ok(home.abilities, "the assistant is ready");
    const by = new Map(home.abilities!.projects.map((a) => [a.project, a]));
    assert.deepEqual(home.abilities!.projects.map((a) => a.project), home.projects.map((p) => p.id), "the cards' order");
    assert.deepEqual(by.get(handleOf("q", designs.id)), { project: handleOf("q", designs.id), fix: "held", version: "now", release: "held" });
    // Deploy On, but the engine (a brake) refuses deploy/run: the card says the team, and the tool starts nothing.
    assert.deepEqual(by.get(handleOf("q", shop.id)), { project: handleOf("q", shop.id), fix: "team", version: "none", release: "team" });

    const set: string[] = [];
    standInActs(set);
    const fixShop = await run("start_fix", { project: "Rakiba Shop", title: "The cart is empty", text: "It shows nothing." });
    const releaseShop = await run("deploy", { project: "Rakiba Shop", why: "New prices." });
    assert.deepEqual([fixShop.started, releaseShop.started], [false, false], "the card's `team` is the tool's started: false");
    assert.match(releaseShop.text, /^Asked the team to release it/);
    assert.deepEqual(set, [], "nothing set off for a `team` answer");
    const versionShop = await run("start_version", { project: "Rakiba Shop" });
    assert.match(versionShop.text, /has no versions to try/, "version none: the tool has none either");

    const releaseDesigns = await run("deploy", { project: "RakibaDesigns", why: "New logo." });
    assert.equal(releaseDesigns.started, true, "the card's `held` is a release the tool set off");
    assert.match(releaseDesigns.text, /in a few minutes/, "held reads as held in the tool too");
    assert.deepEqual(set, [`${designs.id} deploy/run`]);
  });

  test("a switch change reaches the next read of Home (nothing pushed)", async () => {
    would.setWouldActFactsForTest(facts({ "*": { column: assistantDefaults() } }));
    const before = await ownerHome(org.id);
    assert.ok(before.abilities!.projects.every((a) => a.fix === "team" && a.release === "team" && a.version === "team"));
    would.setWouldActFactsForTest(facts({ "*": { column: on("codingStart") } }));
    const afterOn = await ownerHome(org.id);
    assert.ok(afterOn.abilities!.projects.every((a) => a.fix === "held" && a.release === "team"));
  });

  test("not ready (no reply model): no abilities on Home", async () => {
    store.setAssistantModels(org.id, { models: { reply: null, coding: { model: "scripted/scripted" } } });
    try {
      const home = await ownerHome(org.id);
      assert.equal(home.assistant?.ready, false);
      assert.equal("abilities" in home, false);
    } finally {
      store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" }, coding: { model: "scripted/scripted" } } });
    }
  });
});

describe("the server's own facts, on a real org", () => {
  test("Off by default (a new project's assistant column): the team; no version, no release steps", async () => {
    const r = await Promise.all((["fix", "version", "release"] as const).map((a) => would.assistantWouldAct(org.id, designs.id, a)));
    assert.deepEqual(
      r.map((x) => x.outcome),
      ["team", "none", "team"],
    );
    assert.equal(r[0]!.reason, "power-off");
  });

  test("Start coding sessions On, a coding model set: a fix waits the waiting period, as the engine says", async () => {
    const ps = poStore.projectOverseerPaths(designs.id);
    const cur = poStore.readPoSettings(ps);
    poStore.writePoSettings(ps, { ...cur, powers: { ...cur.powers, assistant: { ...cur.powers.assistant, codingStart: true, deploy: true } } });
    const fix = await would.assistantWouldAct(org.id, designs.id, "fix");
    assert.deepEqual(fix, { outcome: "held", reason: "ok" });
    const release = await would.assistantWouldAct(org.id, designs.id, "release");
    assert.deepEqual([release.outcome, release.reason], ["team", "no-recipe"], "Deploy On, but the project declares no release steps");
  });
});
