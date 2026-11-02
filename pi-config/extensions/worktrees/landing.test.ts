import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { landingFile, newestUserMessage, readLanding, recordGoAhead, typedGoAhead } from "./landing.ts";


const A = "a".repeat(40);
const B = "b".repeat(40);
/** The go-ahead recorded for this branch at exactly this commit (the merge queue's ingest reads the same records). */
const goAheadFor = (branch: string, commit: string, file: string) => readLanding(file).goAheads.filter((g) => g.branch === branch && g.commit === commit).at(-1);

test("go-aheads are kept per branch and exact commit; an older file's Not Yet and docs lists are ignored and dropped", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		assert.equal(goAheadFor("feat/x", A, file), undefined);
		writeFileSync(file, JSON.stringify({ v: 1, goAheads: [], notYet: [{ branch: "feat/x", commit: A, at: "2026-10-23T00:00:00Z" }], docsEntries: [{ branch: "feat/x", sha: B, parent: A, at: "t", drafts: [] }] }));
		assert.deepEqual(readLanding(file), { v: 1, goAheads: [] });
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:01:00Z", by: "land-it", session: "s1" }, file);
		assert.equal(goAheadFor("feat/x", A, file)?.session, "s1");
		assert.equal(goAheadFor("feat/x", B, file), undefined, "another commit");
		assert.equal(goAheadFor("feat/y", A, file), undefined, "another branch");
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["v", "goAheads"], "the next write drops the old lists");
		assert.throws(() => recordGoAhead({ branch: "feat/x", commit: "abc", at: "x", by: "land-it" }, file), /full commit sha/);
		writeFileSync(file, "{broken");
		assert.deepEqual(readLanding(file), { v: 1, goAheads: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
		assert.deepEqual(typedGoAhead(t), { withoutSpecs: false, withoutReview: false }, t);
	assert.deepEqual(typedGoAhead("land it without its specs"), { withoutSpecs: true, withoutReview: false });
	assert.deepEqual(typedGoAhead("merge it\n(without specs, they can follow)"), { withoutSpecs: true, withoutReview: false });
	for (const t of ["land it, skip review", "land it, skip the review", "land it without review", "merge it, no review needed"])
		assert.deepEqual(typedGoAhead(t), { withoutSpecs: false, withoutReview: true }, t);
	assert.deepEqual(typedGoAhead("land it without specs, skip review"), { withoutSpecs: true, withoutReview: true });
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
		"[merge-queue] feat/x didn't land: unit failed.",
		"[merge-queue] The user sent feat/x back: merge master into it.",
		"[merge-queue] feat/land-it is finished at abc1234, but it can't be queued to land yet",
		"[overseer-brief] land it",
		"[from session \"Captain\" (abc), hop 1]\nland it",
		"[schedule s1] Scheduled run fired (merge-ready). Reason: Ready to land: feat/x.",
		"Go ahead: land feat/x at abc1234.",
		"I looked at the diff of the reworked landing card and the copy is fine; merge it",
		"the landing page looks fine",
		"",
	])
		assert.equal(typedGoAhead(t), null, t);
});

test("a go-ahead typed in the owner's chat is kept, and a newer one at the same commit replaces it", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:00:00Z", by: "owner-chat", session: "s1" }, file);
		recordGoAhead({ branch: "feat/x", commit: A, at: "2026-10-23T00:01:00Z", by: "owner-chat", session: "s1", withoutReview: true }, file);
		assert.equal(goAheadFor("feat/x", A, file)?.withoutReview, true);
		assert.equal(readLanding(file).goAheads.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("older go-ahead kinds (captain-chat with its `in`, overseer-card) still read, and survive a new write; an unknown kind is refused", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-"));
	const file = join(dir, "landing.json");
	try {
		recordGoAhead({ branch: "feat/c", commit: A, at: "2026-10-23T00:01:00Z", by: "captain-chat", in: "cap" }, file);
		recordGoAhead({ branch: "feat/o", commit: B, at: "2026-10-23T00:02:00Z", by: "overseer-card", session: "s1" }, file);
		assert.deepEqual(goAheadFor("feat/c", A, file), { branch: "feat/c", commit: A, at: "2026-10-23T00:01:00Z", by: "captain-chat", in: "cap" });
		assert.equal(goAheadFor("feat/o", B, file)?.by, "overseer-card");
		assert.throws(() => recordGoAhead({ branch: "feat/w", commit: A, at: "2026-10-23T00:04:00Z", by: "someone" as never }, file), /Not a go-ahead/);
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

test("go-aheads written at once from many processes never drop each other (one lock)", async () => {
	const { spawn } = await import("node:child_process");
	const { existsSync, utimesSync } = await import("node:fs");
	const dir = mkdtempSync(join(tmpdir(), "landing-lock-"));
	const file = join(dir, "landing.json");
	const landingTs = join(import.meta.dirname, "landing.ts");
	const hex = (n: number, k: number) => `${n.toString(16).padStart(4, "0")}${k.toString(16).padStart(4, "0")}`.padEnd(40, "a");
	const run = (code: string) =>
		new Promise<number>((done) => {
			const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
			p.on("exit", (c) => done(c ?? 1));
		});
	const N = 15;
	const jobs: Promise<number>[] = [];
	for (let w = 0; w < 4; w++) {
		jobs.push(run(`import { recordGoAhead } from ${JSON.stringify(landingTs)}; for (let i = 0; i < ${N}; i++) recordGoAhead({ branch: "b", commit: ${JSON.stringify("")} + "${hex(w, 0).slice(0, 8)}".slice(0, 4) + String(i).padStart(4, "0") + "b".repeat(32), at: new Date().toISOString(), by: "land-it" }, ${JSON.stringify(file)});`));
		jobs.push(run(`import { recordGoAhead } from ${JSON.stringify(landingTs)}; for (let i = 0; i < ${N}; i++) recordGoAhead({ branch: "c", commit: "${hex(w, 1).slice(0, 4)}" + String(i).padStart(4, "0") + "c".repeat(32), at: new Date().toISOString(), by: "owner-chat" }, ${JSON.stringify(file)});`));
	}
	try {
		assert.deepEqual(await Promise.all(jobs), Array(8).fill(0), "every writer finished");
		const d = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(d.goAheads.length, 8 * N, "no go-ahead was dropped");
		assert.equal(readLanding(file).goAheads.length, 8 * N, "landing.ts reads them back");
		assert.ok(!existsSync(`${file}.lock`), "the lock is gone");
		// A lock left behind by a writer that died is taken over once stale; a fresh one is waited for.
		writeFileSync(`${file}.lock`, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${file}.lock`, old, old);
		recordGoAhead({ branch: "b", commit: "e".repeat(40), at: new Date().toISOString(), by: "land-it" }, file);
		assert.ok(goAheadFor("b", "e".repeat(40), file), "a stale lock is taken over");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
