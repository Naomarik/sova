import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import { runGit } from "./git.ts";
import { CARRY_MAX, cleanMergeParent, goAheadFor, landingFile, mainMergesOn, profileIdOf, readLanding, recordGoAhead, recordNotYet } from "./landing.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("go-aheads are kept per branch and exact commit; Not Yet is cleared by a go-ahead at the same commit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		assert.equal(await goAheadFor("feat/x", A, file), undefined);
		recordNotYet({ branch: "feat/x", commit: A, at: "2026-10-23T00:00:00Z" }, file);
		assert.equal(readLanding(file).notYet.length, 1);
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:01:00Z", by: "land-it", session: "s1" }, file);
		assert.equal((await goAheadFor("feat/x", A, file))?.session, "s1");
		assert.equal(await goAheadFor("feat/x", B, file), undefined, "another commit");
		assert.equal(await goAheadFor("feat/y", A, file), undefined, "another branch");
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

// A go-ahead survives a clean master merge, and only that (§chat.worktrees/merge-guard): a real repository.
describe("a go-ahead carried over a clean master merge", () => {
	let dir = "";
	let repo = "";
	let file = "";
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" } }).trim();
	const tryGit = (...args: string[]) => {
		try {
			git(...args);
			return 0;
		} catch {
			return 1;
		}
	};
	const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
	const commit = (name: string, text: string, msg: string) => {
		write(name, text);
		git("add", "-A");
		git("commit", "-q", "-m", msg);
		return git("rev-parse", "HEAD");
	};
	const carry = () => ({ git: runGit, cwd: repo, target: "master" });
	const pressAt = (commit: string) => recordGoAhead({ branch: "feat", commit, at: "2026-10-24T00:00:00Z", by: "land-it", session: "s1" }, file);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "landing-carry-"));
		repo = join(dir, "repo");
		file = join(dir, "landing.json");
		execFileSync("git", ["init", "-q", "-b", "master", repo]);
		commit("a.txt", "one\ntwo\nthree\n", "base");
		git("checkout", "-q", "-b", "feat");
		commit("b.txt", "feature\n", "feature");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const masterMoves = (name = "c.txt", text = "master\n") => {
		git("checkout", "-q", "master");
		commit(name, text, `master ${name}`);
		git("checkout", "-q", "feat");
	};

	test("a clean auto-merge of master carries the press at its first parent, through a chain of them", async () => {
		const P = git("rev-parse", "HEAD");
		pressAt(P);
		masterMoves();
		git("merge", "--no-edit", "-q", "master");
		const M = git("rev-parse", "HEAD");
		assert.equal(await cleanMergeParent(runGit, repo, M, "master"), P);
		assert.equal((await goAheadFor("feat", M, file, carry()))?.commit, P);
		assert.equal(await goAheadFor("feat", M, file), undefined, "without carry: exact commits only");
		masterMoves("d.txt");
		git("merge", "--no-edit", "-q", "master");
		const M2 = git("rev-parse", "HEAD");
		assert.equal((await goAheadFor("feat", M2, file, carry()))?.commit, P, "master merged in again after it moved");
		assert.ok(CARRY_MAX >= 2);
	});

	test("an evil merge (one line edited beyond the merge) does NOT carry it", async () => {
		const P = git("rev-parse", "HEAD");
		pressAt(P);
		masterMoves();
		git("merge", "--no-edit", "--no-commit", "-q", "master");
		write("b.txt", "feature, edited in the merge\n");
		git("add", "-A");
		git("commit", "-q", "--no-edit");
		const M = git("rev-parse", "HEAD");
		assert.equal(git("rev-list", "--parents", "-n", "1", M).split(" ").length, 3, "still a two-parent merge");
		assert.equal(await cleanMergeParent(runGit, repo, M, "master"), undefined);
		assert.equal(await goAheadFor("feat", M, file, carry()), undefined);
	});

	test("a merge whose conflicts were resolved does NOT carry it", async () => {
		commit("a.txt", "one\nTWO on feat\nthree\n", "feat edits two");
		const P = git("rev-parse", "HEAD");
		pressAt(P);
		masterMoves("a.txt", "one\nTWO on master\nthree\n");
		assert.equal(tryGit("merge", "--no-edit", "-q", "master"), 1, "it conflicts");
		write("a.txt", "one\nTWO on both\nthree\n");
		git("add", "-A");
		git("commit", "-q", "--no-edit");
		const M = git("rev-parse", "HEAD");
		assert.equal(await goAheadFor("feat", M, file, carry()), undefined);
	});

	test("a merge with three parents does NOT carry it, nor a clean merge of a branch that isn't master", async () => {
		const P = git("rev-parse", "HEAD");
		pressAt(P);
		masterMoves();
		git("checkout", "-q", "-b", "other", "master~1");
		commit("o.txt", "other\n", "other");
		git("checkout", "-q", "feat");
		git("merge", "--no-edit", "-q", "master", "other");
		const M = git("rev-parse", "HEAD");
		assert.equal(git("rev-list", "--parents", "-n", "1", M).split(" ").length, 4);
		assert.equal(await goAheadFor("feat", M, file, carry()), undefined);
		git("reset", "-q", "--hard", P);
		git("merge", "--no-edit", "-q", "other");
		assert.equal(await goAheadFor("feat", git("rev-parse", "HEAD"), file, carry()), undefined, "its second parent is on no master");
	});

	/** A on feat, B a clean master merge on A, C a clean master merge on B. */
	const chain = () => {
		const A = git("rev-parse", "HEAD");
		masterMoves("c.txt");
		git("merge", "--no-edit", "-q", "master");
		const B = git("rev-parse", "HEAD");
		masterMoves("d.txt");
		git("merge", "--no-edit", "-q", "master");
		const C = git("rev-parse", "HEAD");
		return { A, B, C };
	};
	const notYetAt = (commit: string, at: string) => recordNotYet({ branch: "feat", commit, at, session: "s1" }, file);
	const goAt = (commit: string, at: string) => recordGoAhead({ branch: "feat", commit, at, by: "land-it", session: "s1" }, file);

	test("a later Not Yet stops the carry: Land It at A, Not Yet at B, and neither B nor C lands", async () => {
		const { A, B, C } = chain();
		goAt(A, "2026-10-24T00:00:00Z");
		assert.equal((await goAheadFor("feat", C, file, carry()))?.commit, A, "carried before the Not Yet");
		notYetAt(B, "2026-10-24T00:05:00Z");
		assert.equal(await goAheadFor("feat", B, file, carry()), undefined);
		assert.equal(await goAheadFor("feat", C, file, carry()), undefined);
		assert.equal((await goAheadFor("feat", A, file, carry()))?.commit, A, "A itself still has its go-ahead");
	});

	test("a Not Yet at A after its go-ahead: the newer answer wins, at A and through the carry", async () => {
		const { A, B, C } = chain();
		goAt(A, "2026-10-24T00:00:00Z");
		notYetAt(A, "2026-10-24T00:05:00Z");
		assert.deepEqual(readLanding(file).goAheads.map((g) => g.commit), [A], "both are on record");
		assert.equal(await goAheadFor("feat", A, file, carry()), undefined);
		assert.equal(await goAheadFor("feat", B, file, carry()), undefined);
		assert.equal(await goAheadFor("feat", C, file, carry()), undefined);
	});

	test("a go-ahead at B after a Not Yet at B lands, at B and carried to C", async () => {
		const { A, B, C } = chain();
		goAt(A, "2026-10-24T00:00:00Z");
		notYetAt(B, "2026-10-24T00:05:00Z");
		goAt(B, "2026-10-24T00:10:00Z");
		assert.equal((await goAheadFor("feat", B, file, carry()))?.commit, B);
		assert.equal((await goAheadFor("feat", C, file, carry()))?.commit, B);
		// Both on record at B (as an older file may hold them): the later time decides, Not Yet a tie.
		const both = (go: string, no: string) =>
			writeFileSync(file, JSON.stringify({ v: 1, goAheads: [{ branch: "feat", commit: B, at: go, by: "land-it" }], notYet: [{ branch: "feat", commit: B, at: no }] }));
		both("2026-10-24T00:10:00Z", "2026-10-24T00:05:00Z");
		assert.equal((await goAheadFor("feat", C, file, carry()))?.commit, B, "go-ahead newer");
		both("2026-10-24T00:05:00Z", "2026-10-24T00:10:00Z");
		assert.equal(await goAheadFor("feat", C, file, carry()), undefined, "Not Yet newer");
		both("2026-10-24T00:05:00Z", "2026-10-24T00:05:00Z");
		assert.equal(await goAheadFor("feat", C, file, carry()), undefined, "a tie is Not Yet");
	});

	test("a plain commit after the press never carries it", async () => {
		const P = git("rev-parse", "HEAD");
		pressAt(P);
		const Q = commit("b.txt", "more\n", "more work");
		assert.equal(await goAheadFor("feat", Q, file, carry()), undefined);
	});
});
