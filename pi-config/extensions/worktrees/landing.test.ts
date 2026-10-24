import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerAt, goAheadFor, landingFile, readLanding, recordGoAhead, recordNotYet } from "./landing.ts";

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
