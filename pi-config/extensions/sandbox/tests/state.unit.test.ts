import assert from "node:assert/strict";
import test from "node:test";
import { describeActive, markerText, normalizeActive, parseOnOff, parseState, restoreActive, SANDBOX_ENTRY_TYPE, type SandboxActive, STATES, stateOf, stateRank } from "../state.ts";

const on: SandboxActive = { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "full" };
const entry = (data: unknown, customType = SANDBOX_ENTRY_TYPE) => ({ type: "custom", customType, data });

test("parseOnOff reads on/off and nothing else", () => {
	for (const v of ["on", "ON", " true", "1", "yes", true]) assert.equal(parseOnOff(v), true, String(v));
	for (const v of ["off", "false", "0", "no", false]) assert.equal(parseOnOff(v), false, String(v));
	for (const v of ["", "maybe", undefined, null, 1, {}]) assert.equal(parseOnOff(v), undefined, String(v));
});

test("normalizeActive rejects what this version does not understand", () => {
	assert.deepEqual(normalizeActive(on), on);
	assert.equal(normalizeActive({ ...on, version: 2 }), undefined);
	assert.equal(normalizeActive({ ...on, on: "yes" }), undefined);
	assert.equal(normalizeActive({ ...on, level: "full" }), undefined);
	assert.equal(normalizeActive(null), undefined);
	assert.equal(normalizeActive([on]), undefined);
	// A garbled enforcement on an ON entry reads as unavailable, never as full.
	assert.equal(normalizeActive({ ...on, enforcement: "total" })?.enforcement, "unavailable");
	assert.deepEqual(normalizeActive({ ...on, reasons: ["a", 3, "b"] })?.reasons, ["a", "b"]);
});

test("restoreActive takes the newest usable sandbox entry on the branch", () => {
	const off = { ...on, on: false, backend: "none", enforcement: "none" };
	assert.equal(restoreActive([]), undefined);
	assert.equal(restoreActive([entry(on, "mode")]), undefined);
	assert.deepEqual(restoreActive([entry(on), entry(off)]), off);
	assert.deepEqual(restoreActive([entry(off), entry(on), entry({ junk: 1 })]), on);
	assert.equal(restoreActive("nope" as never), undefined);
});

test("status and marker copy", () => {
	assert.equal(describeActive(on), "Sandbox on · workspace-write · full enforcement");
	assert.equal(describeActive({ ...on, on: false }), "Sandbox subagents only · workers in tracked worktrees write only there");
	assert.equal(describeActive({ ...on, on: false, workers: "off" }), "Sandbox off · workers unconfined");
	assert.equal(markerText(on), "Sandbox → on · workspace-write · full enforcement");
	assert.equal(markerText({ ...on, enforcement: "partial", reasons: ["no socat"] }), "Sandbox → on · workspace-write · partial enforcement · no socat");
	assert.equal(markerText({ ...on, on: false }), "Sandbox → subagents only");
	assert.equal(markerText({ ...on, on: false, workers: "off" }), "Sandbox → off");
	// On with a stray workers field still reads as On.
	assert.equal(describeActive({ ...on, workers: "off" }), "Sandbox on · workspace-write · full enforcement");
	assert.match(describeActive({ ...on, enforcement: "unavailable", reasons: ["bwrap missing"] }), /unavailable: bwrap missing \(tools refuse\)/);
	// On under a remote target: enforced nowhere, and the line says why.
	assert.equal(describeActive({ ...on, enforcement: "none", reasons: ["not enforced on remote"] }), "Sandbox on · not enforced on remote");
	assert.equal(describeActive({ ...on, enforcement: "none" }), "Sandbox on · not enforced");
	assert.doesNotMatch(describeActive({ ...on, enforcement: "none" }), /none enforcement/);
	assert.equal(markerText({ ...on, enforcement: "none", reasons: ["not enforced on remote"] }), "Sandbox → on · not enforced on remote");
});

test("three states (§chat.sandbox/states): the entry's optional workers field, failing closed", () => {
	const sub = { ...on, on: false, backend: "none", enforcement: "none" as const };
	const offE = { ...sub, workers: "off" as const };
	// An entry from before the third state has no workers field: off then meant Subagents only.
	assert.equal(stateOf(normalizeActive(sub)!), "subagents");
	assert.deepEqual(normalizeActive(offE), offE);
	assert.equal(stateOf(normalizeActive(offE)!), "off");
	assert.equal(stateOf(normalizeActive(on)!), "on");
	// On with workers off is On: the field is dropped, never the confinement.
	assert.deepEqual(normalizeActive({ ...on, workers: "off" }), on);
	assert.equal(stateOf(normalizeActive({ ...on, workers: "off" })!), "on");
	// Anything but the exact "off" leaves the workers confined.
	for (const w of ["OFF", "none", true, 0, null, "on"]) assert.equal(stateOf(normalizeActive({ ...sub, workers: w })!), "subagents", String(w));
	// The newest entry wins across states, and a branch moves with it.
	assert.equal(stateOf(restoreActive([entry(on), entry(offE)])!), "off");
	assert.equal(stateOf(restoreActive([entry(offE), entry(sub)])!), "subagents");
	assert.equal(stateOf(restoreActive([entry(offE), entry(on)])!), "on");
});

test("parseState reads on, subagents and off; ranks run loosest first", () => {
	assert.equal(parseState("on"), "on");
	assert.equal(parseState(" Subagents "), "subagents");
	assert.equal(parseState("off"), "off");
	assert.equal(parseState(true), "on");
	assert.equal(parseState(false), "off");
	for (const v of ["", "sub", "subagent", "all", undefined, null, 1]) assert.equal(parseState(v), undefined, String(v));
	assert.deepEqual([...STATES], ["off", "subagents", "on"]);
	assert.ok(stateRank("off") < stateRank("subagents") && stateRank("subagents") < stateRank("on"));
});
