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

test("with the brief open: designers, efforts and styles change, the brief's version goes up and its estimate is redone; words, images, skills and the Creative Director go to tell", async () => {
  const c = chat({ phase: "brief", brief: { rev: 4, textRev: 1, summary: "s", prompt: "p", promptBy: "coordinator", writing: null, conflict: null, questions: [], looks: {}, estimateUsd: 123 } });
  const rev = c.now().brief!.rev;
  const r = await c.call({ op: "edit", removeModels: ["glm-5.3"], efforts: { all: "high" }, brief: "something else", coordinator: "glm-5.3", removeImages: ["img-1"], removeSkills: ["brand"] });
  const run = c.now();
  assert.equal(run.brief!.rev, rev + 1);
  assert.notEqual(run.brief!.estimateUsd, 123, "the estimate is redone");
  assert.ok(typeof run.brief!.estimateUsd === "number" && run.brief!.estimateUsd > 0);
  assert.deepEqual(run.setup.models.filter((m) => m.design).map((m) => [m.ref, m.effort]), [["anthropic/claude-sonnet-4-5", "high"]]);
  assert.equal(run.setup.brief, "A pricing page");
  assert.equal(run.setup.models.find((m) => m.coordinator)!.ref, "anthropic/claude-sonnet-4-5");
  for (const what of [/request's words go to the Creative Director now/, /Creative Director is already at work/, /Images go to the Creative Director now/, /Skills go to the Creative Director now/]) assert.match(r.text, what);
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
