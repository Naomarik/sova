import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { DesignModelChoice, DesignRecord, DesignRun } from "../../shared/design";
import type { ToolSpec } from "../../shared/harness";

const agentDir = mkdtempSync(join(tmpdir(), "sova-coordinator-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { answerCoordinator, confirmRun, coordinatorCard, coordinatorTools, messageCoordinator, noteHandIn, originsIn, setCoordinatorPorts, startCoordinator, tellCoordinator } = await import("./coordinator");
const { changeDesigns, forgetDesignCache, runOf } = await import("./store");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const PNG = new Uint8Array([137, 80, 78, 71]);
let n = 0;
let parent = { sessionId: "", path: "" };
let log: { sends: { text: string; key: string }[]; launches: unknown[]; news: unknown[]; verbs: { verb: string; body: unknown; caller: { granted?: true } }[]; sites: string[]; delivered: unknown[] };
type Outcome = Awaited<ReturnType<typeof import("./browse").designBrowse>>;
let nextBrowse: Outcome;
let workerState: "running" | "idle" | "ended";
let lastTask = "";

const model = (ref: string, over: Partial<DesignModelChoice> = {}): DesignModelChoice => ({ ref, name: ref, design: true, coordinator: false, vision: true, route: "tool", ...over });
const runWith = (designers: number, directions: number, over: Partial<DesignRun> = {}): DesignRun => ({
  id: `run${++n}`,
  setup: { brief: "A landing page", models: [model("zai/coord", { design: false, coordinator: true }), ...Array.from({ length: designers }, (_, i) => model(`zai/m${i}`))], directions: Array.from({ length: directions }, (_, i) => ({ name: `D${i}`, on: true })) },
  phase: "setup", labels: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

beforeEach(() => {
  parent = { sessionId: `sid${++n}`, path: join(agentDir, `p${n}.jsonl`) };
  log = { sends: [], launches: [], news: [], verbs: [], sites: [], delivered: [] };
  workerState = "idle";
  nextBrowse = { kind: "pictures", url: "/settings", origin: "http://127.0.0.1:4810", outline: "OUTLINE", signedIn: false, shots: [{ size: "desktop", png: PNG, viewport: { w: 1440, h: 960 } }] };
  setCoordinatorPorts({
    workers: () => ({
      start: async (req) => ((lastTask = req.task ?? ""), { chatId: "worker-1", sessionFile: "/w.jsonl" }),
      send: async (_c, i) => (log.sends.push(i), { queued: false }),
      state: () => workerState,
      watch: () => () => {},
    }),
    designsFor: () => [{ label: "A", direction: "D0", model: "zai/m0", parents: [], status: "ready", route: "tool", versions: [{ n: 1, at: "t", chars: 50000, note: { layout: "l", sections: "s", type: "t", color: "c" } }], vision: true, createdAt: "", updatedAt: "", runId: "r" } as unknown as DesignRecord],
    launchDesigns: async (_p, _r, a) => (log.launches.push(a), ["A", "B"]),
    newDesign: async (_p, a) => (log.news.push(a), "G"),
    deliverDesign: async (_p, label, a) => (log.delivered.push({ label, ...a }), { queued: true }),
    lookAtDesign: async () => ({ shots: [{ size: "desktop", png: PNG }], outline: "O" }),
    systemPrompt: () => "PROMPT",
    specFor: () => ({}) as never,
    sessionDir: () => "/s",
    browse: async () => nextBrowse,
    stores: () => ({}) as never,
    verbs: async (verb, body, caller) => (log.verbs.push({ verb, body, caller }), { state: "running", instances: [] }),
    projects: () => [{ id: "p1", root: "/proj/a" }, { id: "p2", root: "/proj/b" }],
    approveSite: (o) => void log.sites.push(o),
    saveTestAccount: () => {},
  });
});
afterEach(() => {
  setCoordinatorPorts(null);
  forgetDesignCache();
});

type Tool = (args: unknown) => Promise<{ content: { type: string; text?: string }[]; details: any }>;
type Tools = Record<"design_status" | "design_launch" | "design_confirm" | "design_browse" | "design_send" | "design_new" | "coordinator_card" | "project_verbs", Tool>;
async function started(run: DesignRun) {
  changeDesigns(parent.sessionId, (s) => {
    s.runs.push(run);
    s.parentPath = parent.path;
  });
  await startCoordinator(parent, run, "/cwd");
  return Object.fromEntries(coordinatorTools(parent.sessionId).map((t) => [t.name, (args: unknown) => t.execute("c1", args, undefined, undefined, undefined as never)])) as Tools;
}
const textOf = (r: { content: { type: string; text?: string }[] }): string => r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const refused = (r: { content: { type: string; text?: string }[] }) => assert.match(textOf(r), /^Refused:/);

test("launch stays inside the Setup card: over 24, or over 12 unapproved, never reaches the runner", async () => {
  for (const [designers, directions, over] of [[5, 5, {}], [4, 4, {}]] as const) {
    const t = await started(runWith(designers, directions, over));
    refused(await t.design_launch({ briefFinal: "x" }));
  }
  assert.equal(log.launches.length, 0);
});

test("a run approved above 12 launches; a second launch of the run is refused", async () => {
  const run = runWith(4, 4, { confirmedSpend: true });
  const t = await started(run);
  assert.deepEqual((await t.design_launch({ briefFinal: "Final" })).details.labels, ["A", "B"]);
  changeDesigns(parent.sessionId, (s) => void (s.runs.find((r) => r.id === run.id)!.phase = "generating"));
  refused(await t.design_launch({ briefFinal: "Final" }));
  assert.equal(log.launches.length, 1);
});

test("a brief with nothing to look at launches with no confirm", async () => {
  const t = await started(runWith(2, 3));
  assert.deepEqual((await t.design_launch({ briefFinal: "Final" })).details.labels, ["A", "B"]);
});

test("working from an existing screen waits for Design This Screen, and references must be the approved ones", async () => {
  const run = runWith(2, 3);
  const t = await started(run);
  const shot = (await t.design_browse({ url: "http://127.0.0.1:4810/settings" })).details.shots[0];
  refused(await t.design_launch({ briefFinal: "x" }));
  await t.design_confirm({ text: "Found it", shots: [shot] });
  assert.equal(runOf(parent.sessionId, run.id)!.phase, "confirm");
  refused(await t.design_launch({ briefFinal: "x", references: [shot] }));
  await confirmRun(parent, run.id, "design");
  refused(await t.design_launch({ briefFinal: "x", references: ["s999"] }));
  await t.design_launch({ briefFinal: "x", references: [shot] });
  assert.equal(log.launches.length, 1);
  const ref = (log.launches[0] as { references: { outline: string; mime: string }[] }).references[0]!;
  assert.deepEqual([ref.outline, ref.mime], ["OUTLINE", "image/png"]);
});

test("a brief naming an address needs a confirm even before any look", async () => {
  const run = runWith(2, 3);
  run.setup.brief = "Redesign https://example.test/pricing";
  const t = await started(run);
  refused(await t.design_launch({ briefFinal: "x" }));
});

test("Not This Screen sends the user's words on, clears the screen, and an address in them counts as theirs", async () => {
  const run = runWith(2, 3);
  const t = await started(run);
  const shot = (await t.design_browse({ url: "http://127.0.0.1:4810/" })).details.shots[0];
  await t.design_confirm({ text: "Here", shots: [shot] });
  await confirmRun(parent, run.id, "not-this", "use https://other.test/x instead");
  assert.equal(runOf(parent.sessionId, run.id)!.confirm, undefined);
  assert.match(log.sends.at(-1)!.text, /other\.test/);
  nextBrowse = { kind: "needs-site", origin: "https://third.test" };
  await t.design_browse({ url: "https://third.test/" });
});

test("up and down of a project wait for the user's yes, which runs exactly what the card named", async () => {
  const t = await started(runWith(2, 3));
  const r = await t.project_verbs({ verb: "up", project: "/proj/b", branch: "preview" });
  assert.match(textOf(r), /Asked the user/);
  assert.equal(log.verbs.length, 0);
  const ask = (await import("./store")).viewOf(parent.sessionId).coordinator!.ask!;
  assert.equal(ask.kind, "start-project");
  refused(await t.project_verbs({ verb: "down", project: "/proj/b", instance: "i1" })); // one question at a time
  await assert.rejects(answerCoordinator(parent, "not-the-id", "yes"));
  assert.equal(log.verbs.length, 0);
  await answerCoordinator(parent, ask.id, "yes");
  assert.deepEqual(log.verbs, [{ verb: "up", body: { project: "/proj/b", branch: "preview" }, caller: { kind: "design-coordinator", id: parent.sessionId, granted: true } as never }]);
  await assert.rejects(answerCoordinator(parent, ask.id, "yes"), "a card's yes works once");
  assert.equal(log.verbs.length, 1);
});

test("a no runs nothing; up with no copy named is the main checkout and refused; other verbs are refused", async () => {
  const t = await started(runWith(2, 3));
  refused(await t.project_verbs({ verb: "up", project: "/proj/b" }));
  refused(await t.project_verbs({ verb: "teardown", project: "/proj/b", instance: "i1" }));
  await t.project_verbs({ verb: "up", project: "/proj/b", instance: "i1" });
  const ask = (await import("./store")).viewOf(parent.sessionId).coordinator!.ask!;
  await answerCoordinator(parent, ask.id, "no");
  assert.equal(log.verbs.length, 0);
});

test("status reads every project without asking, unconfirmed", async () => {
  const t = await started(runWith(2, 3));
  await t.project_verbs({ verb: "status" });
  assert.deepEqual(log.verbs.map((v) => [v.verb, v.body, v.caller.granted]), [["status", { project: "/proj/a" }, undefined], ["status", { project: "/proj/b" }, undefined]]);
});

test("an unapproved site asks on the card, and a yes is what approves it", async () => {
  const t = await started(runWith(2, 3));
  nextBrowse = { kind: "needs-site", origin: "https://third.test" };
  assert.match(textOf(await t.design_browse({ url: "https://third.test/" })), /Asked the user/);
  assert.deepEqual(log.sites, []);
  const ask = (await import("./store")).viewOf(parent.sessionId).coordinator!.ask!;
  await answerCoordinator(parent, ask.id, "yes");
  assert.deepEqual(log.sites, ["https://third.test"]);
});

test("only the user's own words vouch for an address: a message does, a pass-on from the main chat doesn't", async () => {
  await started(runWith(2, 3));
  const named = (o: string) => (JSON.parse(readFileSync(join(agentDir, "design", parent.sessionId, "coordinator.json"), "utf8")) as { named: string[] }).named.includes(o);
  await tellCoordinator(parent, "see https://from-main.test/a", "k1");
  assert.equal(named("https://from-main.test"), false);
  await messageCoordinator(parent, "see https://from-me.test/a", "k2");
  assert.equal(named("https://from-me.test"), true);
});

test("a call that didn't come from the page delivers, but vouches for nothing", async () => {
  await started(runWith(2, 3));
  await messageCoordinator(parent, "see https://script.test/a", "k5", false);
  assert.equal(JSON.parse(readFileSync(join(agentDir, "design", parent.sessionId, "coordinator.json"), "utf8")).named.includes("https://script.test"), false);
});

test("addresses in a person's text are found exactly", () => {
  assert.deepEqual(originsIn("go to https://a.test/x, or http://b.test:8080. Also localhost:3000 and 127.0.0.1:9000/y"), ["https://a.test", "http://b.test:8080", "http://localhost:3000", "http://127.0.0.1:9000"]);
  assert.deepEqual(originsIn("no address: foo.bar or ftp://x.test"), []);
});

test("design_new in one turn is one launch: the 13th asks, the 25th stops, a new message starts over", async () => {
  const t = await started(runWith(2, 3));
  const one = () => t.design_new({ parents: ["A"], instructions: "mix", model: "zai/m0" });
  for (let i = 0; i < 12; i++) assert.equal((await one()).details.label, "G");
  assert.match(textOf(await one()), /Asked the user/);
  assert.equal(log.news.length, 12);
  const ask = (await import("./store")).viewOf(parent.sessionId).coordinator!.ask!;
  assert.equal(ask.kind, "spend");
  await answerCoordinator(parent, ask.id, "yes");
  for (let i = 0; i < 12; i++) assert.equal((await one()).details.label, "G");
  refused(await one());
  assert.equal(log.news.length, 24);
  await messageCoordinator(parent, "another", "k9");
  assert.equal((await one()).details.label, "G");
});

test("design_new calls side by side can't pass the same check", async () => {
  const t = await started(runWith(2, 3));
  const out = await Promise.all(Array.from({ length: 30 }, () => t.design_new({ parents: ["A"], instructions: "mix", model: "zai/m0" })));
  assert.equal(log.news.length, 12);
  assert.equal(out.filter((r) => r.details.asked).length, 1);
});

test("a hand-in wakes nothing and reaches the coordinator with its next message; it never carries a page", async () => {
  await started(runWith(2, 3));
  noteHandIn(parent.sessionId, { label: "A", version: 1, note: { layout: "grid", sections: "hero", type: "serif", color: "green" } });
  assert.equal(log.sends.length, 0);
  await tellCoordinator(parent, "hello", "k3");
  assert.match(log.sends[0]!.text, /^Since your last turn:\nA handed in\. Layout: grid/);
  assert.match(log.sends[0]!.text, /hello$/);
  await tellCoordinator(parent, "again", "k4");
  assert.equal(log.sends[1]!.text, "again");
});

test("design_status holds metadata only", async () => {
  const t = await started(runWith(2, 3));
  const out = textOf(await t.design_status({}));
  assert.match(out, /"label": "A"/);
  assert.doesNotMatch(out, /html|chars/i);
});

test("a look at a design gives pictures, never its text", async () => {
  const t = await started(runWith(2, 3));
  const r = await t.design_browse({ label: "A" });
  assert.deepEqual(r.content.map((b: { type: string }) => b.type), ["text", "image"]);
});

test("a coordinator with no vision gets the outline and no pictures", async () => {
  const run = runWith(2, 3);
  run.setup.models[0]!.vision = false;
  const t = await started(run);
  const r = await t.design_browse({ url: "http://127.0.0.1:4810/" });
  assert.deepEqual(r.content.map((b: { type: string }) => b.type), ["text"]);
  assert.match(textOf(r), /OUTLINE/);
});

test("the card is replaced whole, with a new revision, and has a size limit", async () => {
  const t = await started(runWith(2, 3));
  await t.coordinator_card({ text: "One" });
  await t.coordinator_card({ text: "Two" });
  assert.deepEqual(coordinatorCard(parent.sessionId), { card: "Two", revision: 2 });
  refused(await t.coordinator_card({ text: "x".repeat(20_001) }));
});

test("while alive the same session takes a new run", async () => {
  const first = runWith(2, 3);
  await started(first);
  const second = runWith(2, 3);
  changeDesigns(parent.sessionId, (s) => void s.runs.push(second));
  await startCoordinator(parent, second, "/cwd");
  assert.match(log.sends.at(-1)!.text, /A landing page/);
});

test("a session that ended for good is started again from its card and the designs' metadata, never a page", async () => {
  const t = await started(runWith(2, 3));
  await t.coordinator_card({ text: "Three made so far." });
  workerState = "ended";
  await messageCoordinator(parent, "make it darker", "k-revive");
  assert.equal(log.sends.length, 0);
  assert.match(lastTask, /Three made so far\./);
  assert.match(lastTask, /"label":"A"/);
  assert.match(lastTask, /make it darker$/);
});

test("a brief from an earlier run that named an address doesn't hold up a later new idea", async () => {
  const first = runWith(2, 3);
  first.setup.brief = "Redesign https://example.test/x";
  await started(first);
  const second = runWith(2, 3);
  changeDesigns(parent.sessionId, (s) => void s.runs.push(second));
  await startCoordinator(parent, second, "/cwd");
  const t = Object.fromEntries(coordinatorTools(parent.sessionId).map((x) => [x.name, x])) as Record<string, ToolSpec>;
  await t.design_launch!.execute("c", { briefFinal: "x" }, undefined, undefined, undefined as never);
  assert.equal(log.launches.length, 1);
});

test("a sign-in answer never reaches the session's text", async () => {
  const t = await started(runWith(2, 3));
  nextBrowse = { kind: "needs-sign-in", origin: "https://app.test", fields: ["username", "password"] };
  await t.design_browse({ url: "https://app.test/" });
  const ask = (await import("./store")).viewOf(parent.sessionId).coordinator!.ask!;
  await answerCoordinator(parent, ask.id, { username: "tester", password: "hunter2-secret" });
  assert.doesNotMatch(JSON.stringify(log.sends), /hunter2-secret/);
});

test("the card's yes is the person's: a chat's key or the token in a header is refused", async () => {
  const { Hono } = await import("hono");
  const { mountCoordinatorRoutes } = await import("./coordinator-routes");
  const app = new Hono();
  mountCoordinatorRoutes(app);
  for (const path of ["/api/design/coordinator/answer?path=x", "/api/design/runs/r/confirm?path=x"]) {
    for (const headers of [{ "x-sova-caller": "k" }, { "x-sova-token": "t" }, {} as Record<string, string>]) {
      const r = await app.request(path, { method: "POST", headers, body: "{}" });
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
  }
});

test("a coordinator's process is served its tools and no others, and has no built-in tools at all", async () => {
  const { workerServed } = await import("../chat-host");
  const decls = workerServed({ kind: "design-coordinator", parent: { sessionId: "p", path: "/p.jsonl", workerId: "design-coordinator" } }, "/w.jsonl");
  assert.deepEqual(decls.map((d) => d.name).sort(), ["coordinator_card", "design_browse", "design_confirm", "design_launch", "design_new", "design_send", "design_status", "project_verbs"]);
  // After a restart its mirror names only the parent's id: the same tools come back.
  assert.equal(workerServed({ kind: "design-coordinator", parentSessionId: "p" }, "/w2.jsonl").length, decls.length);
  const spec = (await import("./coordinator")).realCoordinatorSpec({ sessionId: "p", path: "/p.jsonl" }, "/cwd", "zai/glm-5.3-flash", "P");
  assert.deepEqual(spec.builtins, []);
  assert.equal(spec.kind, "design-coordinator");
  assert.equal(spec.appendSystemPrompt, "P");
});
