import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { goAheadFor, landingFile, mainMergesOn, profileIdOf, readLanding, recordGoAhead, recordNotYet } from "./landing.ts";

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

test("the file lives in the chat's state root, else the agent dir's sova folder", () => {
	assert.equal(landingFile({ SOVA_CHAT_STATE_ROOT: "/s" }), "/s/landing.json");
	assert.equal(landingFile({ PI_CODING_AGENT_DIR: "/a" }), "/a/sova/landing.json");
});

test("mainMerges: only the exact value turns the guard on", () => {
	assert.equal(mainMergesOn(JSON.stringify({ version: 1, offers: {}, mainMerges: "go-ahead" })), true);
	assert.equal(mainMergesOn(JSON.stringify({ version: 1, offers: {} })), false);
	assert.equal(mainMergesOn(JSON.stringify({ version: 1, offers: {}, mainMerges: "yes" })), false);
	assert.equal(mainMergesOn(null), false);
	assert.equal(mainMergesOn("{nope"), false);
});

test("the profile is the newest sova-profile entry on the branch", () => {
	const e = (id: string | null) => ({ type: "custom", customType: "sova-profile", data: { v: 1, profile: id ? { id } : null } });
	assert.equal(profileIdOf([]), null);
	assert.equal(profileIdOf([e("merge-captain")]), "merge-captain");
	assert.equal(profileIdOf([e("merge-captain"), { type: "message" }, e(null)]), null);
	assert.equal(profileIdOf([e(null), e("merge-captain")]), "merge-captain");
});
