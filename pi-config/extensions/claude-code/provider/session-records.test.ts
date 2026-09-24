import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	claudeProjectSlug, claudeProjectsRoot, claudeSessionId, listBridgeSessionRecords, nextFreeLaunch,
} from "./session-records.ts";

function projects(): string {
	return mkdtempSync(join(tmpdir(), "pi-claude-records-"));
}

function plant(root: string, cwd: string, pi: string, launches: Iterable<number>): string {
	const dir = join(root, claudeProjectSlug(cwd));
	mkdirSync(dir, { recursive: true });
	for (const n of launches) writeFileSync(join(dir, `${claudeSessionId(pi, n)}.jsonl`), "{}\n");
	return dir;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("the slug is the CLI's: every non-alphanumeric becomes a dash", () => {
	assert.equal(claudeProjectSlug("/home/u/webapps/sova"), "-home-u-webapps-sova");
	assert.equal(claudeProjectSlug("/home/u/.pi/agent"), "-home-u--pi-agent");
	assert.equal(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: "/x/claude" }), "/x/claude/projects");
});

test("43 records on disk: the next launch is 43, found by stat alone", () => {
	const root = projects();
	plant(root, "/w/sova", "pi-1", range(0, 42));
	const records = listBridgeSessionRecords("pi-1", { cwd: "/w/sova", projectsRoot: root });
	assert.deepEqual(records.map((r) => r.launch), range(0, 42));
	assert.equal(records[42].sessionId, claudeSessionId("pi-1", 42));
	assert.equal(nextFreeLaunch("pi-1", { cwd: "/w/sova", projectsRoot: root }), 43);
	// Another pi session in the same directory is not counted.
	assert.equal(nextFreeLaunch("pi-2", { cwd: "/w/sova", projectsRoot: root }), 0);
});

test("a launch that left no record does not end the walk; maxGap misses do", () => {
	const root = projects();
	plant(root, "/w/sova", "pi-1", [...range(0, 9), ...range(15, 20), 60]);
	const opts = { cwd: "/w/sova", projectsRoot: root };
	assert.equal(nextFreeLaunch("pi-1", opts), 21, "39 misses after 20 end the walk before 60");
	assert.equal(nextFreeLaunch("pi-1", { ...opts, maxGap: 40 }), 61);
	assert.equal(nextFreeLaunch("pi-1", { ...opts, from: 25 }), 25, "25..56 are all missing");
	assert.equal(nextFreeLaunch("pi-1", { ...opts, from: 5 }), 21);
});

test("without a cwd every project dir is searched; with one only its own", () => {
	const root = projects();
	plant(root, "/w/a", "pi-1", range(0, 3));
	plant(root, "/w/b", "pi-1", range(4, 6));
	assert.deepEqual(listBridgeSessionRecords("pi-1", { projectsRoot: root }).map((r) => r.launch), range(0, 6));
	assert.equal(nextFreeLaunch("pi-1", { cwd: "/w/a", projectsRoot: root }), 4);
	assert.equal(nextFreeLaunch("pi-1", { cwd: "/w/c", projectsRoot: root }), 0);
	assert.equal(nextFreeLaunch("pi-1", { projectsRoot: join(root, "missing") }), 0);
});

test("a cwd whose slug exceeds the CLI's limit matches the hash-suffixed dir", () => {
	const root = projects();
	const cwd = `/w/${"deep/".repeat(50)}repo`;
	const dir = join(root, `${claudeProjectSlug(cwd).slice(0, 200)}-abc123`);
	mkdirSync(dir);
	for (const n of range(0, 2)) writeFileSync(join(dir, `${claudeSessionId("pi-1", n)}.jsonl`), "{}\n");
	assert.equal(nextFreeLaunch("pi-1", { cwd, projectsRoot: root }), 3);
});
