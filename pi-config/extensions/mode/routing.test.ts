import assert from "node:assert/strict";
import test from "node:test";
import { delegateDefaults, type DelegateSettings, type WorkerChoice } from "./delegate.ts";
import { assess, fromBackendModels, backendsOf, routeAll, routeNotice, routeProfile, usable, type Discovery } from "./routing.ts";

const fable: WorkerChoice = { backend: "claude-code", model: "claude-fable-5-1[1m]", effort: "medium" };
const opusHigh: WorkerChoice = { backend: "claude-code", model: "opus[1m]", effort: "high" };
const glm: WorkerChoice = { backend: "pi", model: "zai/glm-5.3", effort: "high" };
const claude = (...ids: string[]): Discovery => ({ models: ids.map((id) => ({ id, efforts: ["low", "medium", "high", "xhigh", "max"] })) });

test("assess: discovery failure is not absence", () => {
	assert.equal(assess(fable, undefined, null).availability, "unverified", "not probed yet");
	const failed = assess(fable, { error: "Claude model discovery timed out" }, null);
	assert.equal(failed.availability, "unverified");
	assert.match(failed.reason ?? "", /discovery failed: Claude model discovery timed out/);
	assert.ok(usable(failed), "an unverified tuple stays in use");
	// A backend that is not loaded at all is authoritative: agent_spawn would refuse it.
	const missing = assess(fable, { error: "the claude-code backend is not loaded", missing: true }, null);
	assert.equal(missing.availability, "absent");
	assert.ok(!usable(missing));
});

test("assess: a successful discovery decides model and effort", () => {
	assert.equal(assess(fable, claude("claude-fable-5-1[1m]"), null).availability, "ok");
	const absent = assess(fable, claude("opus[1m]"), null);
	assert.equal(absent.availability, "absent");
	assert.equal(absent.reason, "claude-fable-5-1[1m] is not offered by claude-code");
	assert.equal(assess(fable, { models: [] }, null).availability, "absent", "an empty list is an answer");
	const effort = assess(fable, { models: [{ id: "claude-fable-5-1[1m]", efforts: ["low", "high"] }] }, null);
	assert.equal(effort.availability, "effort");
	assert.match(effort.reason ?? "", /does not support effort "medium" \(supports: low, high\)/);
	assert.equal(assess(fable, { models: [{ id: "claude-fable-5-1[1m]" }] }, null).availability, "ok", "no reported efforts: nothing to check against");
	assert.equal(assess(glm, { models: [{ id: "zai/glm-5.3", efforts: ["off"] }] }, null).availability, "effort", "a non-reasoning pi model supports only off");
});

test("assess: an empty or unusable reported effort list constrains nothing (as Sova's options read it)", () => {
	for (const efforts of [[], ["new-effort"]]) {
		assert.equal(assess(fable, { models: [{ id: "claude-fable-5-1[1m]", efforts }] }, null).availability, "ok", JSON.stringify(efforts));
	}
	const cut = assess(fable, { models: [{ id: "claude-fable-5-1[1m]", efforts: ["low", "new-effort"] }] }, null);
	assert.equal(cut.availability, "effort");
	assert.match(cut.reason ?? "", /\(supports: low\)$/, "the reason lists what the backend would accept");
});

test("assess: policy denial wins over everything and carries its reason", () => {
	const denied = assess(fable, claude("claude-fable-5-1[1m]"), "Backend claude-code is disabled for subagents by user settings.");
	assert.equal(denied.availability, "denied");
	assert.match(denied.reason ?? "", /disabled for subagents/);
	assert.equal(assess(fable, undefined, "nope").availability, "denied", "even unprobed");
});

test("routeProfile: primary, else disclosed fallback, else ask — never an arbitrary model", () => {
	const settings = delegateDefaults();
	const offered = (d: Discovery) => (choice: WorkerChoice) => assess(choice, d, null);

	const onPrimary = routeProfile("planning", settings, offered(claude("claude-fable-5-1[1m]", "opus[1m]")));
	assert.equal(onPrimary.via, "primary");
	assert.deepEqual(onPrimary.use, fable);
	assert.equal(onPrimary.fallback?.availability, "ok");

	const onFallback = routeProfile("planning", settings, offered(claude("opus[1m]")));
	assert.equal(onFallback.via, "fallback");
	assert.deepEqual(onFallback.use, opusHigh);
	assert.equal(onFallback.primary.availability, "absent");

	const nothing = routeProfile("planning", settings, offered(claude("sonnet", "haiku")));
	assert.equal(nothing.via, "none");
	assert.equal(nothing.use, null, "offered models that were never configured are not used");

	const noFallback = routeProfile("routine", settings, offered(claude("sonnet")));
	assert.equal(noFallback.via, "none");
	assert.equal(noFallback.fallback, null);

	// Unverified primary is used as is: failure to discover is not a reason to reroute.
	const unverified = routeProfile("planning", settings, (choice) => assess(choice, { error: "timeout" }, null));
	assert.equal(unverified.via, "primary");
	assert.deepEqual(unverified.use, fable);
});

test("routeAll: policy reroutes to the configured fallback, disclosed, and never further", () => {
	const settings = delegateDefaults();
	const denyFable = (choice: WorkerChoice) => (choice.model === "claude-fable-5-1[1m]" ? "claude-fable-5-1[1m] is disabled as a subagent model by user settings." : null);
	const routes = routeAll(settings, { "claude-code": claude("claude-fable-5-1[1m]", "opus[1m]") }, denyFable);
	const planning = routes.find((r) => r.profile === "planning")!;
	assert.equal(planning.via, "fallback");
	assert.deepEqual(planning.use, opusHigh);
	assert.equal(planning.primary.availability, "denied");
	assert.match(routeNotice(planning) ?? "", /^Planning & specs: fallback claude-code · opus\[1m\] · high \(claude-fable-5-1\[1m\] is disabled as a subagent model by user settings\.\)$/);

	const denyAllClaude = () => "Backend claude-code is disabled for subagents by user settings.";
	const blocked = routeAll(settings, { "claude-code": claude("claude-fable-5-1[1m]", "opus[1m]") }, denyAllClaude);
	assert.deepEqual(blocked.map((r) => r.via), ["none", "none", "none", "none"], "a denied provider is not routed around to another one");
	assert.match(routeNotice(blocked[2]!) ?? "", /^Routine implementation: no available worker — Backend claude-code is disabled .*, and no fallback is set; the orchestrator will ask/);
	assert.equal(routeNotice(routes.find((r) => r.profile === "routine")!), undefined, "nothing to say about a primary in use");
});

test("routeAll assesses each tuple against its own backend", () => {
	const settings: DelegateSettings = delegateDefaults();
	settings.profiles.investigation = { primary: glm, fallback: fable };
	const routes = routeAll(settings, { pi: { models: [{ id: "zai/glm-5.3", efforts: ["low", "medium", "high"] }] }, "claude-code": claude("opus[1m]") }, () => null);
	const investigation = routes.find((r) => r.profile === "investigation")!;
	assert.equal(investigation.via, "primary");
	assert.equal(investigation.primary.availability, "ok");
	assert.equal(investigation.fallback?.availability, "absent", "the claude fallback checked against claude discovery");
	// pi not probed: its tuple is unverified, not absent.
	const unprobedPi = routeAll(settings, { "claude-code": claude("opus[1m]") }, () => null).find((r) => r.profile === "investigation")!;
	assert.equal(unprobedPi.primary.availability, "unverified");
	assert.equal(unprobedPi.via, "primary");
});

test("backendsOf lists every backend the routing names, fallbacks included", () => {
	assert.deepEqual(backendsOf(delegateDefaults()), ["claude-code"]);
	const settings = delegateDefaults();
	settings.profiles.complex.fallback = glm;
	assert.deepEqual(backendsOf(settings).sort(), ["claude-code", "pi"]);
});

test("fromBackendModels keeps ids and reported efforts, nothing invented", () => {
	assert.deepEqual(
		fromBackendModels([
			{ id: "opus[1m]", name: "Opus", efforts: ["low", "high"], resolvedModel: "claude-opus-5" },
			{ id: "haiku", name: "Haiku" },
		]),
		{ models: [{ id: "opus[1m]", efforts: ["low", "high"] }, { id: "haiku" }] },
	);
});
