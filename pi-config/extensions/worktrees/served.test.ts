import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { landingFile } from "./landing.ts";
import { readServed, SERVED_FILE_NAME, servedFile, servedRoot } from "./served.ts";

test("the served file sits beside landing.json: under SOVA_CHAT_STATE_ROOT, else <agent dir>/sova", () => {
	assert.equal(servedFile({ SOVA_CHAT_STATE_ROOT: "/state" }), join("/state", SERVED_FILE_NAME));
	assert.equal(servedFile({ PI_CODING_AGENT_DIR: "/agent" }), join("/agent", "sova", "merge-served.json"));
	for (const env of [{ SOVA_CHAT_STATE_ROOT: "/state" }, { PI_CODING_AGENT_DIR: "/agent" }]) assert.equal(join(servedFile(env), ".."), join(landingFile(env), ".."));
});

test("a repo is served only when the file lists its main-checkout root; an absent or damaged file reads as unknown", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "served-")));
	const file = join(dir, SERVED_FILE_NAME);
	try {
		const repo = join(dir, "repo");
		const other = join(dir, "other");
		mkdirSync(repo);
		mkdirSync(other);
		symlinkSync(repo, join(dir, "link"));
		assert.equal(readServed(file), null);
		assert.equal(servedRoot(repo, file), "unknown", "absent");
		writeFileSync(file, "{broken");
		assert.equal(servedRoot(repo, file), "unknown", "not JSON");
		writeFileSync(file, JSON.stringify({ v: 2, at: "t", roots: [] }));
		assert.equal(servedRoot(repo, file), "unknown", "another version");
		writeFileSync(file, JSON.stringify({ v: 1, at: "t", roots: [{ root: "relative", target: "master" }] }));
		assert.equal(servedRoot(repo, file), "unknown", "a malformed root damages the whole file");
		writeFileSync(file, JSON.stringify({ v: 1, at: "2026-11-03T12:00:00.000Z", roots: [{ root: repo, target: "master" }] }));
		assert.deepEqual(readServed(file), { v: 1, at: "2026-11-03T12:00:00.000Z", roots: [{ root: repo, target: "master" }] });
		assert.deepEqual(servedRoot(repo, file), { root: repo, target: "master" });
		assert.deepEqual(servedRoot(`${repo}/`, file), { root: repo, target: "master" }, "trailing slash");
		assert.deepEqual(servedRoot(join(dir, "link"), file), { root: repo, target: "master" }, "through a symlink");
		assert.equal(servedRoot(other, file), null, "not listed: not served");
		writeFileSync(file, JSON.stringify({ v: 1, at: "t", roots: [] }));
		assert.equal(servedRoot(repo, file), null, "an empty list serves nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
