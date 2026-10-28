import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerAt, goAheadFor, landingFile, newestUserMessage, readLanding, recordGoAhead, recordNotYet, typedGoAhead } from "./landing.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("go-aheads are kept per branch and exact commit; Not Yet is cleared by a go-ahead at the same commit", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		assert.equal(goAheadFor("feat/x", A, file), undefined);
		recordNotYet({ branch: "feat/x", commit: A, at: "2026-10-23T00:00:00Z" }, file);
		assert.equal(readLanding(file).notYet.length, 1);
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:01:00Z", by: "land-it", session: "s1" }, file);
		assert.equal(goAheadFor("feat/x", A, file)?.session, "s1");
		assert.equal(goAheadFor("feat/x", B, file), undefined, "another commit");
		assert.equal(goAheadFor("feat/y", A, file), undefined, "another branch");
		assert.equal(readLanding(file).notYet.length, 0);
		assert.throws(() => recordGoAhead({ branch: "feat/x", commit: "abc", at: "x", by: "land-it" }, file), /full commit sha/);
		writeFileSync(file, "{broken");
		assert.deepEqual(readLanding(file), { v: 1, goAheads: [], notYet: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the newest answer at a commit wins; Not Yet wins a tie or a time that can't be read", () => {
	const at = (go: string | undefined, no: string | undefined) =>
		answerAt({ v: 1, goAheads: go ? [{ branch: "f", commit: A, at: go, by: "land-it" }] : [], notYet: no ? [{ branch: "f", commit: A, at: no }] : [] }, "f", A)?.kind ?? null;
	assert.equal(at("2026-10-24T00:05:00Z", "2026-10-24T00:00:00Z"), "go-ahead");
	assert.equal(at("2026-10-24T00:00:00Z", "2026-10-24T00:05:00Z"), "not-yet");
	assert.equal(at("2026-10-24T00:00:00Z", "2026-10-24T00:00:00Z"), "not-yet");
	assert.equal(at("x", "2026-10-24T00:00:00Z"), "not-yet");
	assert.equal(at(undefined, undefined), null);
});

test("a Merge Branch record from before the guard was removed still reads", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		writeFileSync(file, JSON.stringify({ v: 1, goAheads: [{ branch: "feat/x", commit: A, at: "2026-10-23T00:00:00Z", by: "page" }], notYet: [] }));
		assert.equal(goAheadFor("feat/x", A, file)?.by, "page");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the file lives in the chat's state root, else the agent dir's sova folder", () => {
	assert.equal(landingFile({ SOVA_CHAT_STATE_ROOT: "/s" }), "/s/landing.json");
	assert.equal(landingFile({ PI_CODING_AGENT_DIR: "/a" }), "/a/sova/landing.json");
});

test("typedGoAhead: the user's word to land now, never a question, a condition, a refusal or a message Sova or another session sent", () => {
	for (const t of ["land it", "Land it.", "merge it", "ok, merge it", "yes land it", "go ahead and land feat/x", "please land this now", "lgtm, land it\nthanks"])
		assert.deepEqual(typedGoAhead(t), { withoutSpecs: false }, t);
	assert.deepEqual(typedGoAhead("land it without its specs"), { withoutSpecs: true });
	assert.deepEqual(typedGoAhead("merge it\n(without specs, they can follow)"), { withoutSpecs: true });
	for (const t of [
		"don't land it",
		"do not merge it yet",
		"not yet, keep working",
		"Not yet: keep working on this branch.",
		"land it? not yet",
		"should we land it?",
		"when the tests pass, land it",
		"if it's green, merge it",
		"wait, don't merge",
		"no, don't land",
		"what does land it do",
		"Sova: feat/x is finished at abc1234. Once nothing blocks it, type \"land it\" in this chat.",
		"[from session \"Captain\" (abc), hop 1]\nland it",
		"[schedule s1] Scheduled run fired (merge-ready). Reason: Ready to land: feat/x.",
		"Go ahead: land feat/x at abc1234.",
		"I looked at the diff of the reworked landing card and the copy is fine; merge it",
		"the landing page looks fine",
		"",
	])
		assert.equal(typedGoAhead(t), null, t);
});

test("a go-ahead typed in the owner's chat is kept like Land It and read back as the newest answer", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		recordNotYet({ branch: "feat/x", commit: A, at: "2026-10-23T00:00:00Z" }, file);
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:01:00Z", by: "owner-chat", session: "s1" }, file);
		assert.equal(goAheadFor("feat/x", A, file)?.by, "owner-chat");
		assert.equal(readLanding(file).notYet.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Go on an Overseer card's land row is kept like Land It, and every later write keeps it", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:01:00Z", by: "overseer-card", session: "s1" }, file);
		recordGoAhead({ branch: "feat/y", commit: B, at: "2026-10-23T00:02:00Z", by: "land-it" }, file);
		recordNotYet({ branch: "feat/z", commit: B, at: "2026-10-23T00:03:00Z" }, file);
		assert.equal(goAheadFor("feat/x", A, file)?.by, "overseer-card");
		assert.equal(readLanding(file).goAheads.length, 2);
		// An unknown recorder is still dropped.
		assert.throws(() => recordGoAhead({ branch: "feat/w", commit: A, at: "2026-10-23T00:04:00Z", by: "someone" as never }, file), /Not a go-ahead/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every go-ahead kind (captain-chat with its `in`, overseer-card) survives the other's write", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		recordGoAhead({ branch: "feat/c", commit: A, at: "2026-10-23T00:01:00Z", by: "captain-chat", in: "cap" }, file);
		recordGoAhead({ branch: "feat/o", commit: B, at: "2026-10-23T00:02:00Z", by: "overseer-card", session: "s1" }, file);
		assert.deepEqual(goAheadFor("feat/c", A, file), { branch: "feat/c", commit: A, at: "2026-10-23T00:01:00Z", by: "captain-chat", in: "cap" });
		assert.equal(goAheadFor("feat/o", B, file)?.by, "overseer-card");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("newestUserMessage: the newest user message's text, and who sent it when a sent marker names it", () => {
	const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
	const mark = (customType: string, targetId: string) => ({ type: "custom", id: `m-${targetId}`, customType, data: { v: 1, targetId } });
	const reply = { type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
	assert.deepEqual(newestUserMessage([]), { text: "" });
	assert.deepEqual(newestUserMessage([user("u1", "land it"), reply]), { text: "land it" });
	assert.deepEqual(newestUserMessage([user("u1", "land it"), mark("sova-overseer-sent", "u1"), reply]), { text: "land it", sentBy: "the Overseer" });
	assert.deepEqual(newestUserMessage([user("u1", "land it"), mark("sova-baton-sent", "u1")]), { text: "land it", sentBy: "a baton participant" });
	assert.deepEqual(newestUserMessage([user("u1", "land it"), mark("sova-session-sent", "u1")]), { text: "land it", sentBy: "another session" });
	// A marker naming an older message, or another kind of custom entry, says nothing about the newest.
	assert.deepEqual(newestUserMessage([user("u1", "hi"), mark("sova-overseer-sent", "u1"), user("u2", "land it"), mark("sova-rewind", "u2")]), { text: "land it" });
	// The newest is another sender's: never an older one of the user's instead.
	assert.deepEqual(newestUserMessage([user("u1", "land it"), reply, user("u2", "land it"), mark("sova-session-sent", "u2")]).sentBy, "another session");
});
