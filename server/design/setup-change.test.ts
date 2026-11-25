import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DesignModelChoice, DesignRun } from "../../shared/design";

// The one way an open Setup card changes: the user's whole-card save and the main chat's edit both go through commitSetup.
const agentDir = mkdtempSync(join(tmpdir(), "sova-setup-change-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
const { mainDesignTools } = await import("./tools");
const { changeDesigns, runOf } = await import("./store");
const { commitSetup, hideSection, SetupRefused } = await import("./setup-change");
const { readHiddenSections } = await import("./standing");

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const row = (ref: string, extra: Partial<DesignModelChoice> = {}): DesignModelChoice => ({ ref, name: ref.slice(ref.indexOf("/") + 1), design: false, coordinator: false, vision: true, route: "tool", efforts: LEVELS, ...extra });
let n = 0;
/** A chat with one run on its card, as the main chat's start leaves it. */
function chat(extra: Partial<DesignRun> = {}) {
  n++;
  const sessionId = `01a1c2a9-c0c7-7016-a44a-66741a8${String(n).padStart(5, "0")}`;
  const parent = { sessionId, path: join(agentDir, `main${n}.jsonl`) };
  const run: DesignRun = {
    id: `r${n}`,
    setup: {
      brief: "A pricing page",
      models: [row("anthropic/claude-sonnet-4-5", { design: true, coordinator: true }), row("zai/glm-5.3", { design: true }), row("openai-codex/gpt-6-luna"), row("deepseek/deepseek-v4-pro")],
      directions: [{ name: "Minimalist", on: true }, { name: "Brutalist", on: true }, { name: "Heritage", on: false }],
      layouts: [{ name: "Bento", on: false }, { name: "Compact", on: false }],
      combine: "pair",
      links: [],
    },
    phase: "setup",
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
  changeDesigns(sessionId, (s) => {
    s.runs.push(run);
    s.parentPath = parent.path;
  });
  const tool = mainDesignTools(() => parent, () => agentDir).find((t) => t.name === "lookbook")!;
  const call = async (params: Record<string, unknown>) => {
    const r = await tool.execute("call", params as never, undefined, undefined, undefined as never);
    return { text: (r.content[0] as { text: string }).text, details: r.details as { designCard?: { runId: string } } };
  };
  return { sessionId, parent, run, call, now: () => runOf(sessionId, run.id)! };
}

test("edit changes only what it names, answers with what the card holds, and moves the card under it", async () => {
  const c = chat();
  const r = await c.call({ op: "edit", models: ["gpt-6-luna"], removeModels: ["glm-5.3"], efforts: { "anthropic/claude-sonnet-4-5": "high" }, directions: ["heritage"], removeDirections: ["Brutalist"], layouts: ["Bento"], combine: "every" });
  const run = c.now();
  assert.deepEqual(run.setup.models.filter((m) => m.design).map((m) => [m.ref, m.effort]), [["anthropic/claude-sonnet-4-5", "high"], ["openai-codex/gpt-6-luna", undefined]]);
  assert.deepEqual(run.setup.directions.map((d) => [d.name, d.on]), [["Minimalist", true], ["Brutalist", false], ["Heritage", true]]);
  assert.deepEqual([run.setup.layouts!.find((d) => d.on)?.name, run.setup.combine, run.setup.brief], ["Bento", "every", "A pricing page"]);
  assert.match(r.text, /Designers \(2\): anthropic\/claude-sonnet-4-5 · high, openai-codex\/gpt-6-luna · low\./);
  assert.match(r.text, /Styles \(2\): Minimalist, Heritage\./);
  assert.match(r.text, /Designs: 4\./);
  assert.doesNotMatch(r.text, /Not changed/);
  assert.deepEqual(r.details.designCard, { runId: c.run.id }, "its result names the card, so the card moves down to it");
});

test("what can't apply is named with why, and the rest still applies", async () => {
  const c = chat({ hiddenSections: ["deepseek"], leftOut: [{ section: "ollama", name: "Ollama on this computer", why: "not-running" }] });
  const r = await c.call({ op: "edit", models: ["nope-1", "deepseek-v4-pro", "ollama"], efforts: { "zai/glm-5.3": "max" }, directions: ["Vaporwave"], layouts: ["Compact"] });
  assert.match(r.text, /nope-1: there's no such model on this card\./);
  assert.match(r.text, /deepseek-v4-pro: DeepSeek is hidden on this card; the user can bring it back with Show/);
  assert.match(r.text, /ollama: Ollama on this computer isn't on this card \(it isn't running\)\./);
  assert.match(r.text, /zai\/glm-5.3 doesn't take the effort max; it takes minimal, low, medium, high, xhigh\./);
  assert.match(r.text, /Vaporwave: there's no style by that name/);
  assert.equal(c.now().setup.layouts!.find((d) => d.name === "Compact")!.on, true, "the rest applied");
  assert.equal(c.now().setup.models.find((m) => m.ref === "deepseek/deepseek-v4-pro")!.design, false);
});

test("edit never opens a second card, needs something to change, and refuses once the designs have started", async () => {
  const c = chat();
  await assert.rejects(c.call({ op: "edit" }), /edit needs what to change/);
  changeDesigns(c.sessionId, (s) => void (s.runs[0]!.phase = "generating"));
  await assert.rejects(c.call({ op: "edit", models: ["gpt-6-luna"] }), /has started its designs, so its Setup can't change/);
  changeDesigns(c.sessionId, (s) => void (s.runs[0]!.phase = "setup"));
  await c.call({ op: "edit", models: ["gpt-6-luna"] });
  assert.equal(changeDesigns(c.sessionId, (s) => s.runs.length), 1);
});

test("the request's words change before Start Creative Director, and its links are read again", async () => {
  const c = chat();
  await c.call({ op: "edit", brief: "A pricing page like https://example.test/pricing" });
  assert.equal(c.now().setup.brief, "A pricing page like https://example.test/pricing");
  assert.deepEqual(c.now().setup.links, [{ url: "https://example.test/pricing", use: null }]);
});

test("with the brief open: designers, efforts and styles change, the brief's version goes up and its estimate is redone; words, images and the Creative Director go to tell", async () => {
  const c = chat({ phase: "brief", brief: { rev: 4, textRev: 1, summary: "s", prompt: "p", promptBy: "coordinator", writing: null, conflict: null, questions: [], looks: {}, estimateUsd: 123 } });
  const rev = c.now().brief!.rev;
  const r = await c.call({ op: "edit", removeModels: ["glm-5.3"], efforts: { all: "high" }, brief: "something else", coordinator: "glm-5.3", removeImages: ["img-1"] });
  const run = c.now();
  assert.equal(run.brief!.rev, rev + 1);
  assert.notEqual(run.brief!.estimateUsd, 123, "the estimate is redone");
  assert.ok(typeof run.brief!.estimateUsd === "number" && run.brief!.estimateUsd > 0);
  assert.deepEqual(run.setup.models.filter((m) => m.design).map((m) => [m.ref, m.effort]), [["anthropic/claude-sonnet-4-5", "high"]]);
  assert.equal(run.setup.brief, "A pricing page");
  assert.equal(run.setup.models.find((m) => m.coordinator)!.ref, "anthropic/claude-sonnet-4-5");
  for (const what of [/request's words go to the Creative Director now/, /Creative Director is already at work/, /Images go to the Creative Director now/]) assert.match(r.text, what);
  assert.equal(run.brief!.writing, null, "no skills changed, so Start waits on nothing new");
  // An effort change alone raises the price, against the same designers.
  const low = run.brief!.estimateUsd!;
  await c.call({ op: "edit", efforts: { all: "low" } });
  assert.ok(c.now().brief!.estimateUsd! < low, "low costs less than high");
});

test("a user's save goes through the same change: the latest wins the whole card, and with the brief open its version rises", () => {
  const c = chat({ phase: "brief", brief: { rev: 1, textRev: 1, summary: "s", prompt: "p", promptBy: "coordinator", writing: null, conflict: null, questions: [], looks: {} } });
  const card = c.now().setup;
  commitSetup(c.sessionId, c.run.id, () => ({ setup: { ...card, models: card.models.map((m) => ({ ...m, design: m.ref === "zai/glm-5.3", effort: m.ref === "zai/glm-5.3" ? "medium" : undefined })) } }));
  assert.deepEqual(c.now().setup.models.filter((m) => m.design).map((m) => [m.ref, m.effort]), [["zai/glm-5.3", "medium"]]);
  assert.equal(c.now().brief!.rev, 2);
  assert.throws(() => commitSetup(c.sessionId, c.run.id, () => ({ setup: { ...card, models: [{ ...card.models[0]!, effort: "max" }] } })), (e: unknown) => e instanceof SetupRefused && /doesn't take the effort max/.test(e.message));
  assert.throws(() => commitSetup(c.sessionId, "nope", () => ({ setup: card })), (e: unknown) => e instanceof SetupRefused && e.status === 404);
});

test("read without a label, while the newest card is in Setup, returns what it holds (ticked only)", async () => {
  const c = chat();
  const r = await c.call({ op: "read" });
  assert.match(r.text, /The Setup card \(run r\d+, waiting for Start Creative Director\) holds:/);
  assert.match(r.text, /Designers \(2\): anthropic\/claude-sonnet-4-5 · low, zai\/glm-5.3 · low\./);
  assert.doesNotMatch(r.text, /gpt-6-luna|deepseek/, "only what is ticked");
  assert.match(r.text, /Creative Director: anthropic\/claude-sonnet-4-5\./);
});

test("Hide takes a provider off the card and every later card; the Creative Director moves; the last one stays; Show brings it back", () => {
  const c = chat({ hiddenAsked: ["glm-5.3"] });
  hideSection(c.sessionId, c.run.id, "claude", true);
  let run = c.now();
  assert.deepEqual(run.hiddenSections, ["claude"]);
  assert.equal(run.setup.models.find((m) => m.ref === "anthropic/claude-sonnet-4-5")!.design, false, "unticked, its row kept");
  assert.equal(run.setup.models.find((m) => m.coordinator)!.ref, "zai/glm-5.3", "the Creative Director moves to the first ticked shown model");
  assert.deepEqual(readHiddenSections(), ["claude"], "remembered for later cards");
  // A save from a draft made before the Hide (its hidden row still ticked, the Creative Director still on it) goes through:
  // the hidden row stays as the server has it, and so does the seat.
  const stale = c.now().setup.models.map((m) => ({ ...m, design: m.ref.startsWith("anthropic/") || m.design, coordinator: m.ref.startsWith("anthropic/") }));
  commitSetup(c.sessionId, c.run.id, (r) => ({ setup: { ...r.setup, models: stale } }));
  assert.equal(c.now().setup.models.find((m) => m.ref.startsWith("anthropic/"))!.design, false);
  assert.equal(c.now().setup.models.find((m) => m.coordinator)!.ref, "zai/glm-5.3");
  hideSection(c.sessionId, c.run.id, "zai", true);
  hideSection(c.sessionId, c.run.id, "gpt", true);
  assert.throws(() => hideSection(c.sessionId, c.run.id, "deepseek", true), /Keep at least one provider on the card/);
  assert.throws(() => hideSection(c.sessionId, c.run.id, "ollama", true), /isn't on this card/);
  hideSection(c.sessionId, c.run.id, "zai", false);
  run = c.now();
  assert.deepEqual(run.hiddenSections, ["claude", "gpt"]);
  assert.equal(run.hiddenAsked, undefined, "a name asked for in it no longer reads as hidden");
  assert.deepEqual(readHiddenSections(), ["claude", "gpt"]);
  hideSection(c.sessionId, c.run.id, "claude", false);
  hideSection(c.sessionId, c.run.id, "gpt", false);
  assert.deepEqual(readHiddenSections(), []);
});

test("the routes: a whole-card save and Hide go through the same change, and answer its refusals with their status", async () => {
  const { Hono } = await import("hono");
  const { mountDesignRoutes } = await import("./routes");
  const { SESSIONS_DIR } = await import("../paths");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const c = chat({ phase: "brief", brief: { rev: 1, textRev: 1, summary: "s", prompt: "p", promptBy: "coordinator", writing: null, conflict: null, questions: [], looks: {}, estimateUsd: 1 } });
  const dir = join(SESSIONS_DIR, "--work--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${c.sessionId}.jsonl`);
  writeFileSync(file, "");
  const app = new Hono();
  mountDesignRoutes(app);
  const q = `?path=${encodeURIComponent(file)}`;
  const send = (method: string, url: string, body: unknown) => app.request(url + q, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const card = c.now().setup;
  // The user unticks a designer with the brief open: the version rises and the estimate is redone.
  const saved = await send("PATCH", `/api/design/runs/${c.run.id}/setup`, { ...card, models: card.models.map((m) => ({ ref: m.ref, design: m.ref === "anthropic/claude-sonnet-4-5", coordinator: m.coordinator })) });
  assert.equal(saved.status, 200);
  assert.equal(c.now().brief!.rev, 2);
  assert.notEqual(c.now().brief!.estimateUsd, 1);
  const bad = await send("PATCH", `/api/design/runs/${c.run.id}/setup`, { ...card, models: [{ ref: "zai/glm-5.3", design: true, coordinator: false, effort: "max" }] });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /doesn't take the effort max/);
  assert.equal((await send("PATCH", `/api/design/runs/nope/setup`, card)).status, 404);
  const hid = await send("POST", `/api/design/runs/${c.run.id}/hidden`, { section: "deepseek", hidden: true });
  assert.equal(hid.status, 200);
  assert.deepEqual(c.now().hiddenSections, ["deepseek"]);
  assert.equal((await send("POST", `/api/design/runs/${c.run.id}/hidden`, { section: "deepseek" })).status, 400);
  assert.equal((await send("POST", `/api/design/runs/${c.run.id}/hidden`, { section: "deepseek", hidden: false })).status, 200);
  changeDesigns(c.sessionId, (s) => void (s.runs.find((r) => r.id === c.run.id)!.phase = "generating"));
  assert.equal((await send("PATCH", `/api/design/runs/${c.run.id}/setup`, card)).status, 409);
  assert.equal((await send("POST", `/api/design/runs/${c.run.id}/hidden`, { section: "deepseek", hidden: true })).status, 409);
});

test("skills: edit adds one by its folder and takes one off by name before Start Creative Director; one not found is named with why", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const c = chat();
  const dir = join(agentDir, "kits", "acme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: acme\ndescription: The Acme house look.\n---\nUse --acme.");
  const added = await c.call({ op: "edit", skills: [dir, join(agentDir, "kits", "nowhere")] });
  assert.deepEqual(c.now().skills!.map((k) => [k.name, k.dir]), [["acme", dir]]);
  assert.match(added.text, /Skills: acme, .*nowhere \(not found\)\./);
  assert.match(added.text, /nowhere: There is no such folder\./);
  const removed = await c.call({ op: "edit", removeSkills: ["acme", "brand"] });
  assert.deepEqual(c.now().skills ?? [], []);
  assert.match(removed.text, /brand: there's no skill by that name on this card\./);
});

test("a save from a card older than the newest change is refused, and the run is unchanged; one from the current card applies", async () => {
  const { Hono } = await import("hono");
  const { mountDesignRoutes } = await import("./routes");
  const { SESSIONS_DIR } = await import("../paths");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const c = chat();
  const dir = join(SESSIONS_DIR, "--work--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${c.sessionId}.jsonl`);
  writeFileSync(file, "");
  const app = new Hono();
  mountDesignRoutes(app);
  const patch = (body: unknown) => app.request(`/api/design/runs/${c.run.id}/setup?path=${encodeURIComponent(file)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // The user's draft took the card as it was; then the chat adds a designer within the save's delay.
  const seen = structuredClone(c.now());
  const base = seen.setupAt ?? seen.createdAt;
  await c.call({ op: "edit", models: ["gpt-6-luna"] });
  const after = structuredClone(c.now());
  const userDraft = { ...seen.setup, directions: seen.setup.directions.map((d) => ({ ...d, on: d.name === "Minimalist" })) };
  const stale = await patch({ ...userDraft, baseSetupAt: base });
  assert.equal(stale.status, 409);
  const body = (await stale.json()) as { stale?: boolean; run?: { id: string; setup: { models: { ref: string; design: boolean }[] } }; view?: { runs: { id: string; setupAt?: string }[] } };
  assert.equal(body.stale, true);
  assert.equal(body.view!.runs.find((r) => r.id === c.run.id)!.setupAt, after.setupAt, "and the whole view, to draw at once");
  assert.equal(body.run!.id, c.run.id);
  assert.ok(body.run!.setup.models.find((m) => m.ref === "openai-codex/gpt-6-luna")!.design, "the answer carries the card as the server has it");
  assert.deepEqual(c.now(), after, "the run is unchanged: the chat's later change stands");
  // From the current card it applies, and the stamp moves on.
  const fresh = await patch({ ...after.setup, directions: after.setup.directions.map((d) => ({ ...d, on: d.name === "Minimalist" })), baseSetupAt: after.setupAt });
  assert.equal(fresh.status, 200);
  assert.deepEqual(c.now().setup.directions.filter((d) => d.on).map((d) => d.name), ["Minimalist"]);
  assert.ok(c.now().setupAt! > after.setupAt!, "a new stamp for the next save's base");
  // No base (a script): applies as before.
  assert.equal((await patch({ ...c.now().setup })).status, 200);
});

// ---- skills until Start on the brief -------------------------------------------------------------

/** A skill folder on disk, as the edit names one, and as a run holds it. */
async function kit(name: string, body = `Use --${name}.`) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = join(agentDir, "kits", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} rules.\n---\n${body}`);
  return { name, description: `The ${name} rules.`, dir, from: "named" as const };
}
const openBrief = (over: Record<string, unknown> = {}) => ({ rev: 4, textRev: 2, summary: "s", prompt: "p", promptBy: "coordinator" as const, writing: null, conflict: null, questions: [], looks: {}, estimateUsd: 123, ...over });

test("skills on each stage: added, taken off and not found until Start on the brief; not found is recorded only before Start Creative Director; after Start nothing changes", async () => {
  const brand = await kit("brand");
  const tokens = await kit("tokens");
  const stages: { stage: string; run: Partial<DesignRun>; records: boolean }[] = [
    { stage: "Setup", run: {}, records: true },
    { stage: "preparing", run: { phase: "researching" }, records: false },
    { stage: "brief open", run: { phase: "brief", brief: openBrief() }, records: false },
  ];
  for (const { stage, run, records } of stages) {
    const c = chat({ ...run, skills: [brand] });
    const added = await c.call({ op: "edit", skills: [tokens.dir] });
    assert.deepEqual(c.now().skills!.map((k) => k.name), ["brand", "tokens"], `${stage}: added`);
    assert.doesNotMatch(added.text, /Not changed/, stage);
    const missing = await c.call({ op: "edit", skills: [join(agentDir, "kits", "nowhere")] });
    assert.match(missing.text, /nowhere: There is no such folder\./, `${stage}: named in the result at once`);
    assert.deepEqual(c.now().skillsMissing?.map((m) => m.asked.endsWith("nowhere")) ?? [], records ? [true] : [], `${stage}: recorded for the brief to ask only before Start Creative Director`);
    await c.call({ op: "edit", removeSkills: ["brand"] });
    assert.deepEqual(c.now().skills!.map((k) => k.name), ["tokens"], `${stage}: taken off`);
  }
  const started = chat({ phase: "generating", skills: [brand], brief: openBrief({ startedRev: 4 }) });
  for (const edit of [{ skills: [tokens.dir] }, { removeSkills: ["brand"] }]) await assert.rejects(started.call({ op: "edit", ...edit }), /has started its designs, so its Setup can't change any more, its skills included/);
  assert.deepEqual(started.now().skills!.map((k) => k.name), ["brand"]);
});

test("past Setup a skill not found leaves the run and its brief as they were", async () => {
  const c = chat({ phase: "brief", skills: [await kit("brand")], brief: openBrief() });
  const before = structuredClone(c.now());
  const r = await c.call({ op: "edit", skills: ["no-such-skill-anywhere"] });
  assert.match(r.text, /Not changed:\n- no-such-skill-anywhere: /);
  assert.deepEqual(c.now(), before, "nothing recorded, the brief's version unmoved");
});

test("a skill added with the brief open joins the Creative Director's pick, the estimate moves, and Start waits for its turn", async () => {
  const c = chat({ phase: "brief", skills: [await kit("brand"), await kit("playwright")], brief: openBrief({ skills: ["brand"] }) });
  const tokens = await kit("tokens", "x".repeat(40_000));
  const { designerSkills, designBriefBlock } = await import("../../shared/design");
  assert.equal(designBriefBlock(c.now()), null, "Start could go before the change");
  await c.call({ op: "edit", skills: [tokens.dir] });
  const run = c.now();
  assert.deepEqual(designerSkills(run).map((k) => k.name), ["brand", "tokens"], "added late, it goes to the designers by default; the one left out stays out");
  assert.notEqual(run.brief!.estimateUsd, 123, "what each designer reads is in the estimate");
  assert.equal(designBriefBlock(run)?.label, "Writing the Full Prompt", "Start waits for the Creative Director's next turn");
  assert.deepEqual(run.brief!.writing, { cause: "told" });
});

test("a skill taken off leaves the pick (none when the run has no skills left); with the user's own Full Prompt the brief asks Keep My Prompt or Rewrite It", async () => {
  const c = chat({ phase: "brief", skills: [await kit("brand"), await kit("playwright")], brief: openBrief({ promptBy: "user", skills: ["brand", "playwright"] }) });
  await c.call({ op: "edit", removeSkills: ["playwright"] });
  assert.deepEqual(c.now().brief!.skills, ["brand"]);
  assert.deepEqual(c.now().brief!.conflict, { cause: "told" });
  assert.equal(c.now().brief!.prompt, "p", "the user's prompt stands");
  await c.call({ op: "edit", removeSkills: ["brand"] });
  assert.equal(c.now().skills, undefined);
  assert.equal(c.now().brief!.skills, undefined, "no skills left: no pick");
});
