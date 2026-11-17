import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo, ModelPolicy } from "../../shared/protocol";
import type { DesignModelChoice, DesignSetup } from "../../shared/design";
import { cleanSetup, estimateUsd, resolveDesignModel, setupCardModels, setupModels } from "./setup";
import { modelStanding, probeLocalOllama, type StandingReadings } from "./standing";

const open: ModelPolicy = { disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] };
const info = (ref: string, favorite = false): ModelInfo => ({ ref, provider: ref.slice(0, ref.indexOf("/")), id: ref.slice(ref.indexOf("/") + 1), favorite, thinkingLevels: [] });
const LISTED = [
  "ollama/gemma3:270m",
  "ollama-cloud/glm-5.3",
  "ollama-cloud/kimi-k3",
  "ollama-cloud/old-retired",
  "zai/glm-4.7",
  "zai/glm-5.3",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-6-luna",
  "claude-code-cli/claude-opus-5",
  "claude-code-cli/claude-opus-5-5",
  "deepseek/deepseek-v4-pro",
].map((r) => info(r));
const NONE = new Set<string>();

test("never offered: claude-opus-5, Codex Spark on a ChatGPT sign-in, retired Ollama models, and what Settings turns off", () => {
  const policy: ModelPolicy = { ...open, disabledModels: ["deepseek/deepseek-v4-pro"], subagentDisabledModels: ["ollama-cloud/kimi-k3"] };
  const refs = setupModels(LISTED, policy, new Set(["ollama-cloud/old-retired"]), {}).map((m) => m.ref);
  for (const gone of ["claude-code-cli/claude-opus-5", "openai-codex/gpt-5.3-codex-spark", "ollama-cloud/old-retired", "deepseek/deepseek-v4-pro", "ollama-cloud/kimi-k3"]) assert.ok(!refs.includes(gone), gone);
  assert.ok(refs.includes("claude-code-cli/claude-opus-5-5"));
  const offProvider = setupModels(LISTED, { ...open, subagentDisabledProviders: ["zai"] }, NONE, {}).map((m) => m.ref);
  assert.ok(!offProvider.some((r) => r.startsWith("zai/")), "a provider turned off for helpers is gone");
});

test("the main chat asking for GLM models ticks Z.ai's, and only those", () => {
  const ticked = setupModels(LISTED, open, NONE, { modelGroups: ["GLM models"] }).filter((m) => m.design).map((m) => m.ref);
  assert.deepEqual(ticked, ["zai/glm-5.3", "zai/glm-4.7"]);
});

test("asking for Ollama Cloud never ticks a local Ollama model, and the word ollama alone ticks only local ones", () => {
  assert.deepEqual(setupModels(LISTED, open, NONE, { modelGroups: ["ollama-cloud"] }).filter((m) => m.design).map((m) => m.ref), ["ollama-cloud/kimi-k3", "ollama-cloud/glm-5.3", "ollama-cloud/old-retired"]);
  assert.deepEqual(setupModels(LISTED, open, NONE, { modelGroups: ["ollama"] }).filter((m) => m.design).map((m) => m.ref), ["ollama/gemma3:270m"]);
});

test("rows come best first per provider, favorites leading their own section", () => {
  const listed = [...LISTED.filter((m) => m.ref !== "zai/glm-4.7"), info("zai/glm-4.7", true)];
  const refs = setupModels(listed, open, NONE, {}).map((m) => m.ref);
  assert.deepEqual(refs.slice(0, 4), ["claude-code-cli/claude-opus-5-5", "openai-codex/gpt-6-luna", "zai/glm-4.7", "zai/glm-5.3"]);
  assert.equal(refs.at(-1), "ollama/gemma3:270m", "this computer's Ollama comes last");
  assert.equal(setupModels(listed, open, NONE, {}).find((m) => m.ref === "zai/glm-4.7")?.favorite, true);
});

test("exactly one coordinator, which need not design", () => {
  const models = setupModels(LISTED, open, NONE, { modelGroups: ["glm"], coordinator: "gpt-6-luna" });
  assert.deepEqual(models.filter((m) => m.coordinator).map((m) => [m.ref, m.design]), [["openai-codex/gpt-6-luna", false]]);
  const setup = { brief: "x", models, directions: [] };
  const two = { ...setup, models: models.map((m) => ({ ...m, coordinator: m.ref === "openai-codex/gpt-6-luna" || m.ref === "zai/glm-5.3" })) };
  assert.equal(cleanSetup(setup, two), "Only one model can be the Creative Director.");
  const moved = { ...setup, models: models.map((m) => ({ ...m, coordinator: m.ref === "zai/glm-5.3" })) };
  const kept = cleanSetup(setup, moved);
  assert.ok(typeof kept !== "string");
  assert.deepEqual(kept.models.filter((m) => m.coordinator).map((m) => m.ref), ["zai/glm-5.3"]);
});

test("Setup keeps only the layouts it offered, and the combine choice and seed it can read", () => {
  const prev = { brief: "x", models: [], directions: [{ name: "Minimalist", on: true }], layouts: [{ name: "Bento", on: false }, { name: "Compact", on: false }], combine: "pair" as const };
  const ok = cleanSetup(prev, { brief: "x", models: [], directions: [], layouts: [{ name: "Bento", on: true }], combine: "every", pairSeed: 7 });
  assert.ok(typeof ok !== "string");
  assert.deepEqual(ok.layouts!.map((d) => [d.name, d.on]), [["Bento", true], ["Compact", false]]);
  assert.equal(ok.combine, "every");
  assert.equal(ok.pairSeed, 7);
  assert.equal(cleanSetup(prev, { brief: "x", models: [], directions: [], layouts: [{ name: "Hexagon", on: true }] }), "That layout isn't on this card.");
  assert.match(cleanSetup(prev, { brief: "x", models: [], directions: [], combine: "all" }) as string, /combine/);
  assert.match(cleanSetup(prev, { brief: "x", models: [], directions: [], pairSeed: -1 }) as string, /pairSeed/);
  // Change on the brief: the layouts and how they combine change with the models and styles.
  const open = cleanSetup(prev, { brief: "other", models: [], directions: [], layouts: [{ name: "Compact", on: true }], combine: "every" }, true);
  assert.ok(typeof open !== "string");
  assert.equal(open.brief, "x");
  assert.deepEqual(open.layouts!.filter((d) => d.on).map((d) => d.name), ["Compact"]);
  assert.equal(open.combine, "every");
  // A run made before layouts offers none, and stays without them.
  const old = cleanSetup({ brief: "x", models: [], directions: [] }, { brief: "x", models: [], directions: [], layouts: [{ name: "Bento", on: true }] });
  assert.equal(old, "That layout isn't on this card.");
  const oldPlain = cleanSetup({ brief: "x", models: [], directions: [] }, { brief: "x", models: [], directions: [] });
  assert.ok(typeof oldPlain !== "string" && oldPlain.layouts === undefined);
});

test("a bare model id ticks one model, never the same id under two providers", () => {
  const designing = (models: string[], chatModel?: string, extra: { modelGroups?: string[] } = {}) =>
    setupModels(LISTED, open, NONE, { models, ...extra }, chatModel ? { chatModel } : {}).filter((m) => m.design).map((m) => m.ref);
  // glm-5.3 is under both Z.ai and Ollama Cloud: the chat's own provider decides.
  assert.deepEqual(designing(["glm-5.3"], "zai/glm-5.3-flash"), ["zai/glm-5.3"]);
  assert.deepEqual(designing(["glm-5.3"], "ollama-cloud/kimi-k3"), ["ollama-cloud/glm-5.3"]);
  // A provider named in the same request leads the chat's own.
  assert.deepEqual(designing(["glm-5.3", "ollama-cloud/kimi-k3"], "zai/glm-5.3-flash").sort(), ["ollama-cloud/glm-5.3", "ollama-cloud/kimi-k3"]);
  // An exact provider/id wins over everything, and stays alone.
  assert.deepEqual(designing(["ollama-cloud/glm-5.3"], "zai/glm-5.3-flash"), ["ollama-cloud/glm-5.3"]);
  assert.deepEqual(designing(["zai/glm-5.3", "glm-5.3"], "ollama-cloud/kimi-k3"), ["zai/glm-5.3"], "the bare id is the model already named");
  // Over every chat provider, with or without one: each bare id ticks at most one model.
  for (const chat of [undefined, "zai/x", "ollama-cloud/x", "claude-code-cli/x", "ollama/x"])
    for (const id of ["glm-5.3", "kimi-k3", "glm-4.7", "nope"]) {
      const got = designing([id], chat);
      assert.ok(got.length <= 1 && got.every((r) => r.endsWith(`/${id}`)), `${id} from ${chat}: ${got}`);
      if (id !== "nope") assert.equal(got.length, 1, `${id} from ${chat}`);
    }
  // A whole group still ticks the whole section.
  assert.deepEqual(designing(["glm-5.3"], "zai/x", { modelGroups: ["ollama-cloud"] }).sort(), ["ollama-cloud/glm-5.3", "ollama-cloud/kimi-k3", "ollama-cloud/old-retired"]);
});

test("a bare coordinator id resolves the same way, to one model", () => {
  const coord = (coordinator: string, chatModel?: string) => setupModels(LISTED, open, NONE, { coordinator }, chatModel ? { chatModel } : {}).filter((m) => m.coordinator).map((m) => m.ref);
  assert.deepEqual(coord("glm-5.3", "ollama-cloud/kimi-k3"), ["ollama-cloud/glm-5.3"]);
  assert.deepEqual(coord("glm-5.3", "zai/x"), ["zai/glm-5.3"]);
  assert.deepEqual(coord("ollama-cloud/glm-5.3", "zai/x"), ["ollama-cloud/glm-5.3"]);
});

test("the estimate before Start counts what each design reads of the run's skills", () => {
  const setup = { brief: "b", models: [{ ref: "anthropic/claude-sonnet-4-5", name: "s", design: true, coordinator: true, vision: true, route: "tool" as const }], directions: [{ name: "Minimalist", on: true }, { name: "Heritage", on: true }] };
  const plain = estimateUsd(setup);
  assert.ok(plain !== null, "the seed table prices it");
  const reading = estimateUsd(setup, Date.now(), 20_000)!;
  assert.ok(reading > plain, `${reading} > ${plain}`);
  assert.equal(estimateUsd(setup, Date.now(), 0), plain);
});

// ---- effort ------------------------------------------------------------------------------------

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const row = (ref: string, extra: Partial<DesignModelChoice> = {}): DesignModelChoice => ({ ref, name: ref.slice(ref.indexOf("/") + 1), design: true, coordinator: false, vision: true, route: "tool", efforts: LEVELS, ...extra });

test("a new card's rows carry the levels each model offers, and no effort until one is picked (low)", () => {
  const listed = [{ ...info("zai/glm-5.3"), thinkingLevels: LEVELS }, info("ollama/gemma3:270m")];
  const rows = setupModels(listed, open, NONE, { models: ["zai/glm-5.3"] });
  assert.deepEqual(rows.map((m) => [m.ref, m.efforts, m.effort]), [["zai/glm-5.3", LEVELS, undefined], ["ollama/gemma3:270m", [], undefined]]);
});

test("the card's save sets each row's effort only to a level it offers; null puts it back to low", () => {
  const prev: DesignSetup = { brief: "b", models: [row("zai/a", { coordinator: true }), row("zai/b", { efforts: ["off"] })], directions: [{ name: "D", on: true }] };
  const send = (effort: unknown, ref = "zai/a") => cleanSetup(prev, { brief: "b", models: [{ ref, design: true, coordinator: ref === "zai/a", effort }], directions: [] });
  assert.equal((send("high") as DesignSetup).models[0]!.effort, "high");
  assert.equal((send("low") as DesignSetup).models[0]!.effort, undefined, "low is the default, stored as none");
  assert.equal(send("max"), "zai/a doesn't take the effort max; it takes minimal, low, medium, high, xhigh.");
  assert.equal(send("high", "zai/b"), "zai/b has no effort to pick.");
  const set = cleanSetup({ ...prev, models: [row("zai/a", { coordinator: true, effort: "high" })] }, { brief: "b", models: [{ ref: "zai/a", design: true, coordinator: true, effort: null }], directions: [] }) as DesignSetup;
  assert.equal(set.models[0]!.effort, undefined);
  const kept = cleanSetup({ ...prev, models: [row("zai/a", { coordinator: true, effort: "high" })] }, { brief: "b", models: [{ ref: "zai/a", design: true, coordinator: true }], directions: [] }) as DesignSetup;
  assert.equal(kept.models[0]!.effort, "high", "a save that names no effort keeps the row's");
  assert.equal((cleanSetup(prev, { brief: "b", models: [{ ref: "zai/a", design: true, coordinator: false, effort: "medium" }], directions: [] }, true) as DesignSetup).models[0]!.effort, "medium", "with the brief open too");
});

test("a design the Creative Director adds on a Setup model runs at that row's effort unless it names one", () => {
  const listed = [{ ...info("zai/a"), thinkingLevels: LEVELS }, { ...info("zai/b"), thinkingLevels: ["off"] }, { ...info("openai/x"), thinkingLevels: LEVELS }];
  const setup = { models: [row("zai/a", { effort: "high" }), row("zai/b", { efforts: ["off"] })] };
  const at = (asked: string, effort?: string) => { const r = resolveDesignModel(listed, open, NONE, setup, asked, effort); return typeof r === "string" ? r : r.effort; };
  assert.equal(at("zai/a"), "high");
  assert.equal(at("zai/a", "medium"), "medium", "a level the user named wins");
  assert.equal(at("zai/b"), null, "no level to pick: the model's own");
  assert.equal(at("openai/x"), null, "not on the card: the model's own");
  const low = resolveDesignModel(listed, open, NONE, { models: [row("zai/a")] }, "zai/a");
  assert.ok(typeof low !== "string" && !("effort" in low), "low: recorded as none, as Setup's designs are");
});

test("the estimate before Start prices each design at its row's effort", () => {
  const base = (effort?: string): DesignSetup => ({ brief: "b", models: [{ ...row("anthropic/claude-sonnet-4-5", { coordinator: true }), ...(effort ? { effort } : {}) }], directions: [{ name: "Minimalist", on: true }] });
  const low = estimateUsd(base())!;
  const high = estimateUsd(base("high"))!;
  assert.ok(low > 0 && high > low, `${high} > ${low}`);
  assert.equal(estimateUsd(base("low")), low);
  const old = estimateUsd({ ...base(), models: [{ ref: "anthropic/claude-sonnet-4-5", name: "s", design: true, coordinator: true, vision: true, route: "tool" }] });
  assert.equal(old, low, "a row from before efforts is priced at low");
});

// ---- which providers a card lists ----------------------------------------------------------------

const usage = (providers: StandingReadings["usage"] extends infer U ? (U extends { providers: infer P } ? P : never) : never, extra: Record<string, unknown> = {}): StandingReadings["usage"] => ({ available: true, stale: false, providers, ...extra }) as StandingReadings["usage"];
const reading = (id: string, state: string, auth?: Record<string, unknown>) => ({ id, state, windows: [], ...(auth ? { auth } : {}) }) as never;

test("a provider is left out only when a reading says it can't run: one case per reason", () => {
  const off = (ref: string, r: StandingReadings) => modelStanding(ref, r);
  const ollamaUp: StandingReadings = { usage: null, ollama: { state: "running", names: ["gemma3:270m"] } };
  assert.equal(off("ollama/gemma3:270m", ollamaUp), null);
  assert.equal(off("ollama/qwen3:4b", ollamaUp), "not-downloaded");
  assert.equal(off("ollama/gemma3:270m", { usage: null, ollama: { state: "not-running" } }), "not-running");
  assert.equal(off("openai-codex/gpt-6-luna", { usage: usage([reading("openai", "expired")]), ollama: null }), "signed-out");
  assert.equal(off("openai-codex/gpt-6-luna", { usage: usage([reading("openai", "nologin")]), ollama: null }), "signed-out");
  assert.equal(off("openai-codex/gpt-6-luna", { usage: usage([reading("openai", "ok", { kind: "oauth", refreshExpired: true })]), ollama: null }), "signed-out");
  assert.equal(off("openai-codex/gpt-6-luna", { usage: usage([reading("openai", "expired", { kind: "oauth", source: "pi", expiresAt: Date.now() - 60_000, refreshExpiresAt: Date.now() - 1 })]), ollama: null }), "signed-out", "its renewal ran out too");
  assert.equal(off("zai/glm-5.3", { usage: usage([reading("zai", "badkey")]), ollama: null }), "bad-key");
  assert.equal(off("deepseek/deepseek-v4-pro", { usage: usage([reading("deepseek", "nokey")]), ollama: null }), "no-key");
  assert.equal(off("ollama-cloud/kimi-k3", { usage: usage([reading("ollama", "badkey")]), ollama: null }), "bad-key");
  const login = (standing: string, signedIn = true) => ({ id: "default", enabled: true, signedIn, standing: { state: standing }, inUse: true, usage: reading("claude", "ok") });
  assert.equal(off("claude-code-cli/claude-opus-5-5", { usage: usage([], { claudeLogins: [login("auth"), { ...login("ready", false), id: "l-1" }] }), ollama: null }), "signed-out");
  assert.equal(off("claude-code-cli/claude-opus-5-5", { usage: usage([], { claudeLogins: [login("auth"), { ...login("ready"), id: "l-1" }] }), ollama: null }), null, "one login still works");
});

test("unknown never hides: a stale or missing reading, an unread state, can't tell, an expired token that renews", () => {
  const off = (ref: string, r: StandingReadings) => modelStanding(ref, r);
  assert.equal(off("zai/glm-5.3", { usage: usage([reading("zai", "badkey")], { stale: true }), ollama: null }), null);
  assert.equal(off("zai/glm-5.3", { usage: { available: false, stale: false, providers: [] } as never, ollama: null }), null);
  assert.equal(off("zai/glm-5.3", { usage: null, ollama: null }), null);
  for (const state of ["ok", "na", "error"]) assert.equal(off("zai/glm-5.3", { usage: usage([reading("zai", state)]), ollama: null }), null, state);
  const past = Date.now() - 60_000;
  assert.equal(off("openai-codex/gpt-6-luna", { usage: usage([reading("openai", "expired", { kind: "oauth", source: "pi", expiresAt: past })]), ollama: null }), null, "a token that only timed out renews by itself");
  assert.equal(off("openai-codex/gpt-6-luna", { usage: usage([reading("openai", "expired", { kind: "oauth", source: "codex-cli", expiresAt: past, refreshExpired: true })]), ollama: null }), null, "the Codex app's own sign-in says nothing about pi's");
  assert.equal(off("ollama/gemma3:270m", { usage: null, ollama: { state: "unknown" } }), null);
  assert.equal(off("anthropic/claude-sonnet-4-5", { usage: usage([reading("claude", "nologin")]), ollama: null }), null, "no reading speaks for it");
  assert.equal(off("claude-code-cli/claude-opus-5-5", { usage: usage([]), ollama: null }), null, "no logins listed");
});

test("the card leaves out a provider that can't run, naming what the chat asked for in it, and keeps hidden sections' rows unticked", () => {
  const readings: StandingReadings = { usage: usage([reading("zai", "badkey")]), ollama: { state: "not-running" } };
  const card = setupCardModels(LISTED, open, NONE, { models: ["glm-4.7", "gpt-6-luna", "deepseek-v4-pro"], modelGroups: ["ollama"] }, {}, { readings, hidden: ["deepseek"] });
  assert.deepEqual(card.leftOut, [{ section: "ollama", name: "Ollama on this computer", why: "not-running", models: ["ollama"] }, { section: "zai", name: "Z.ai", why: "bad-key", models: ["glm-4.7"] }]);
  assert.ok(!card.models.some((m) => m.ref.startsWith("zai/") || m.ref.startsWith("ollama/")));
  assert.deepEqual(card.hiddenSections, ["deepseek"]);
  assert.deepEqual(card.hiddenAsked, ["deepseek-v4-pro"]);
  const deep = card.models.find((m) => m.ref === "deepseek/deepseek-v4-pro")!;
  assert.equal(deep.design, false, "a hidden section's row stays, unticked");
  assert.deepEqual(card.models.filter((m) => m.design).map((m) => m.ref), ["openai-codex/gpt-6-luna"]);
  const cd = setupCardModels(LISTED, open, NONE, { coordinator: "deepseek-v4-pro" }, {}, { hidden: ["deepseek"] }).models.find((m) => m.coordinator)!;
  assert.notEqual(cd.ref, "deepseek/deepseek-v4-pro", "the Creative Director never sits in a hidden section");
  const all = [...new Set(LISTED.map((m) => m.provider))];
  const none = setupCardModels(LISTED, open, NONE, {}, {}, { hidden: ["claude", "gpt", "zai", "deepseek", "ollama-cloud", "ollama", ...all] });
  assert.deepEqual(none.hiddenSections, [], "hiding every section would leave nothing: all are shown");
  const partial = setupCardModels([...LISTED, info("ollama/qwen3:4b")], open, NONE, { models: ["qwen3:4b"] }, {}, { readings: { usage: null, ollama: { state: "running", names: ["gemma3:270m"] } } });
  assert.deepEqual(partial.leftOut, [{ section: "ollama", name: "Ollama on this computer", why: "not-downloaded", models: ["qwen3:4b"] }]);
  assert.ok(partial.models.some((m) => m.ref === "ollama/gemma3:270m"), "the downloaded one stays");
});

test("local Ollama's probe: refused is not running, a slow or odd answer can't tell, a list is what it has", async () => {
  const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
  assert.deepEqual(await probeLocalOllama("http://127.0.0.1:1", 50, (async () => { throw refused; }) as never), { state: "not-running" });
  assert.deepEqual(await probeLocalOllama("http://127.0.0.1:1", 50, (async () => { throw new TypeError("fetch failed", { cause: refused }); }) as never), { state: "not-running" });
  const slow = (async (_u: string, init: { signal: AbortSignal }) => new Promise((_r, fail) => init.signal.addEventListener("abort", () => fail(init.signal.reason)))) as never;
  const t0 = Date.now();
  assert.deepEqual(await probeLocalOllama("http://127.0.0.1:1", 50, slow), { state: "unknown" });
  assert.ok(Date.now() - t0 < 1000, "it waits under a second");
  assert.deepEqual(await probeLocalOllama("http://x", 50, (async () => ({ ok: false })) as never), { state: "unknown" });
  assert.deepEqual(await probeLocalOllama("http://x", 50, (async () => ({ ok: true, json: async () => ({ models: [{ name: "gemma3:270m", model: "gemma3:270m" }] }) })) as never), { state: "running", names: ["gemma3:270m"] });
});
