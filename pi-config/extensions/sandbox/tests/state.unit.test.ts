import assert from "node:assert/strict";
import test from "node:test";
import { describeActive, markerText, normalizeActive, parseOnOff, restoreActive, SANDBOX_ENTRY_TYPE, type SandboxActive } from "../state.ts";

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
	assert.equal(describeActive({ ...on, on: false }), "Sandbox off");
	assert.equal(markerText(on), "Sandbox → on · workspace-write · full enforcement");
	assert.equal(markerText({ ...on, enforcement: "partial", reasons: ["no socat"] }), "Sandbox → on · workspace-write · partial enforcement · no socat");
	assert.equal(markerText({ ...on, on: false }), "Sandbox → off");
	assert.match(describeActive({ ...on, enforcement: "unavailable", reasons: ["bwrap missing"] }), /unavailable: bwrap missing \(tools refuse\)/);
	// On under a remote target: enforced nowhere, and the line says why.
	assert.equal(describeActive({ ...on, enforcement: "none", reasons: ["not enforced on remote"] }), "Sandbox on · not enforced on remote");
	assert.equal(describeActive({ ...on, enforcement: "none" }), "Sandbox on · not enforced");
	assert.doesNotMatch(describeActive({ ...on, enforcement: "none" }), /none enforcement/);
	assert.equal(markerText({ ...on, enforcement: "none", reasons: ["not enforced on remote"] }), "Sandbox → on · not enforced on remote");
});
