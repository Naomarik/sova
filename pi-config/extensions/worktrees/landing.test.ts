import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("Sova's go-aheads and the merge round's docs entries, written at once from many processes, never drop each other (one lock)", async () => {
	const { spawn } = await import("node:child_process");
	const { existsSync, utimesSync } = await import("node:fs");
	const dir = mkdtempSync(join(tmpdir(), "landing-lock-"));
	const file = join(dir, "landing.json");
	const landingTs = join(import.meta.dirname, "landing.ts");
	const roundMjs = join(import.meta.dirname, "..", "..", "..", ".sova", "playbooks", "merge-round", "scripts", "round.mjs");
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
		jobs.push(run(`import { appendDocsEntry } from ${JSON.stringify(roundMjs)}; for (let i = 0; i < ${N}; i++) appendDocsEntry(${JSON.stringify(file)}, { branch: "b", sha: "${hex(w, 0).slice(0, 4)}" + String(i).padStart(4, "0") + "c".repeat(32), parent: "d".repeat(40), at: new Date().toISOString(), drafts: [] });`));
	}
	try {
		assert.deepEqual(await Promise.all(jobs), Array(8).fill(0), "every writer finished");
		const d = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(d.goAheads.length, 4 * N, "no go-ahead was dropped");
		assert.equal(d.docsEntries.length, 4 * N, "no docs entry was dropped");
		assert.equal(readLanding(file).docsEntries?.length, 4 * N, "landing.ts reads them back");
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
