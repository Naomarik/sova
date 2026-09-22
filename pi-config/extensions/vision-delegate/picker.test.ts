import assert from "node:assert/strict";
import test from "node:test";
import { bucketUsedPct, describeSkipped, parseRef, pickVisionModel, readUsage } from "./picker.ts";
import { DEFAULT_SETTINGS, type VisionSettings } from "./settings.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seer = (provider: string, id: string) => ({ provider, id, name: id, input: ["text", "image"] });
const blind = (provider: string, id: string) => ({ provider, id, name: id, input: ["text"] });

/** Registry over a fixed set of models, keyed the way modelRegistry.find is called. */
function registry(models: { provider: string; id: string; input: string[] }[]) {
	return (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id);
}

const settings = (fallbacks: string[], overrides: Partial<VisionSettings> = {}): VisionSettings => ({
	...DEFAULT_SETTINGS,
	fallbacks,
	...overrides,
});

test("references split at the first slash so nested model ids survive", () => {
	assert.deepEqual(parseRef("zai/glm-5.3-flash"), { provider: "zai", id: "glm-5.3-flash" });
	assert.deepEqual(parseRef("fireworks/accounts/fireworks/models/inkling"), { provider: "fireworks", id: "accounts/fireworks/models/inkling" });
	for (const bad of ["glm-5.3-flash", "/leading", "trailing/", ""]) assert.equal(parseRef(bad), undefined);
});

test("fallback order wins and every skipped candidate reports why", () => {
	const resolve = registry([blind("zai", "glm-5.3"), seer("anthropic", "claude-haiku-4-5")]);
	const pick = pickVisionModel(settings(["nonsense", "zai/missing", "zai/glm-5.3", "anthropic/claude-haiku-4-5"]), resolve, undefined);
	assert.equal(pick.model?.id, "claude-haiku-4-5");
	assert.equal(pick.overBudget, false);
	assert.deepEqual(pick.skipped.map(s => s.ref), ["nonsense", "zai/missing", "zai/glm-5.3"]);
	assert.match(describeSkipped(pick.skipped), /nonsense \(not a provider\/model reference\), zai\/missing \(not in this session's model registry\), zai\/glm-5\.3 \(does not accept image input\)/);
});

test("the first usable candidate wins even when a later one is cheaper", () => {
	const resolve = registry([seer("zai", "glm-5.3-flash"), seer("anthropic", "claude-haiku-4-5")]);
	const usage = { zai: { state: "ok", fiveHour: { pct: 60 } }, claude: { state: "ok", limits: [{ label: "5h", pct: 1 }] } };
	const pick = pickVisionModel(settings(["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"]), resolve, usage);
	assert.equal(pick.model?.provider, "zai");
	assert.equal(pick.usedPct, 60);
	assert.deepEqual(pick.skipped, []);
});

test("exhausted providers are skipped and the threshold is inclusive", () => {
	const resolve = registry([seer("zai", "glm-5.3-flash"), seer("anthropic", "claude-haiku-4-5")]);
	const usage = { zai: { state: "ok", fiveHour: { pct: 90 } }, claude: { state: "ok", limits: [{ label: "7d", pct: 89 }] } };
	const pick = pickVisionModel(settings(["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"]), resolve, usage);
	assert.equal(pick.model?.provider, "anthropic");
	assert.deepEqual(pick.skipped, [{ ref: "zai/glm-5.3-flash", reason: "subscription usage at 90%" }]);
	// A higher tolerance keeps the first candidate.
	const lenient = pickVisionModel(settings(["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"], { exhaustedAbovePct: 95 }), resolve, usage);
	assert.equal(lenient.model?.provider, "zai");
});

test("all exhausted degrades to the first vision candidate and flags it", () => {
	const resolve = registry([blind("zai", "glm-5.3"), seer("zai", "glm-5.3-flash"), seer("anthropic", "claude-haiku-4-5")]);
	const usage = { zai: { state: "ok", fiveHour: { pct: 99 } }, claude: { state: "ok", limits: [{ label: "7d", pct: 97 }] } };
	const pick = pickVisionModel(settings(["zai/glm-5.3", "zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"]), resolve, usage);
	assert.equal(pick.model?.id, "glm-5.3-flash");
	assert.equal(pick.overBudget, true);
	assert.equal(pick.usedPct, 99);
	// The report is complete: the non-vision entry and both exhausted ones.
	assert.deepEqual(pick.skipped.map(s => s.ref), ["zai/glm-5.3", "zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"]);
});

test("nothing resolvable yields no model rather than an unusable one", () => {
	const pick = pickVisionModel(settings(["zai/glm-5.3"]), registry([blind("zai", "glm-5.3")]), undefined);
	assert.equal(pick.model, undefined);
	assert.deepEqual(pick.skipped.map(s => s.reason), ["does not accept image input"]);
	assert.deepEqual(pickVisionModel(settings([]), registry([]), undefined), { skipped: [] });
});

test("missing, stale-shaped or failed usage leaves every provider usable", () => {
	const resolve = registry([seer("zai", "glm-5.3-flash")]);
	for (const usage of [undefined, {}, { zai: { state: "badkey" } }, { zai: { state: "ok" } }, { zai: { state: "ok", fiveHour: { pct: "high" } } }]) {
		const pick = pickVisionModel(settings(["zai/glm-5.3-flash"]), resolve, usage as any);
		assert.equal(pick.model?.id, "glm-5.3-flash", JSON.stringify(usage));
		assert.equal(pick.overBudget, false);
		assert.equal(pick.usedPct, undefined);
	}
});

test("usage buckets read every window and providers outside the map have no known limit", () => {
	const usage = {
		ollama: { state: "ok", usedPct: 85.3 },
		zai: { state: "ok", fiveHour: { pct: 5 } },
		openai: { state: "ok", windows: [{ label: "5h", pct: 12 }, { label: "7d", pct: 95 }] },
		claude: { state: "ok", fiveHour: { pct: 8 }, sevenDay: { pct: 70 }, limits: [{ label: "5h", pct: 8, active: false }, { label: "7d scoped", pct: 74, active: true }] },
	};
	assert.equal(bucketUsedPct(usage, "ollama-cloud"), 85.3);
	assert.equal(bucketUsedPct(usage, "zai"), 5);
	assert.equal(bucketUsedPct(usage, "openai-codex"), 95);
	// Inactive windows still count: a 7d limit binds even when 5h is the live one.
	assert.equal(bucketUsedPct(usage, "anthropic"), 74);
	assert.equal(bucketUsedPct({ claude: { state: "ok", fiveHour: { pct: 8 }, sevenDay: { pct: 70 } } }, "anthropic"), 70);
	// limitReached without a matching window is still exhaustion.
	assert.equal(bucketUsedPct({ openai: { state: "ok", limitReached: true, windows: [] } }, "openai-codex"), 100);
	for (const provider of ["fireworks", "opencode", "opencode-go", "ollama", "unknown"]) {
		assert.equal(bucketUsedPct(usage, provider), undefined, provider);
	}
});

test("the usage cache is optional and corruption is not an error", () => {
	const dir = mkdtempSync(join(tmpdir(), "vision-usage-"));
	assert.equal(readUsage(join(dir, "absent.json")), undefined);
	const broken = join(dir, "broken.json");
	writeFileSync(broken, "{not json");
	assert.equal(readUsage(broken), undefined);
	const good = join(dir, "good.json");
	writeFileSync(good, JSON.stringify({ zai: { state: "ok", fiveHour: { pct: 3 } } }));
	assert.equal(bucketUsedPct(readUsage(good), "zai"), 3);
});

test("a model turned off in Settings → Models is never a fallback, and says so", () => {
	const resolve = registry([seer("zai", "glm-5.3-flash"), seer("anthropic", "claude-haiku-4-5")]);
	const allowed = (ref: string) => ref !== "zai/glm-5.3-flash";
	const pick = pickVisionModel(settings(["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"]), resolve, undefined, allowed);
	assert.equal(pick.model?.id, "claude-haiku-4-5");
	assert.deepEqual(pick.skipped, [{ ref: "zai/glm-5.3-flash", reason: "turned off in Settings → Models" }]);
	// Everything off is a miss, not a degraded answer: an off model is not "over budget".
	const none = pickVisionModel(settings(["zai/glm-5.3-flash"]), resolve, undefined, () => false);
	assert.equal(none.model, undefined);
	assert.equal(none.overBudget, undefined);
});
