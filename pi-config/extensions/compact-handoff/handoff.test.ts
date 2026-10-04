import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	agentDir,
	ago,
	type BranchEntry,
	extractHandoff,
	forkTask,
	HANDOFF_ENTRY,
	handoffPath,
	isNothingNote,
	latestHandoff,
	NOTHING_NOTE,
	noteInKeptTail,
	restoreText,
	runsRoot,
	writeNoteFile,
} from "./handoff.ts";
import { readRunData, runLine, stillRunning } from "./run.ts";

const reply = (entryId: string, text: string, stopReason = "stop"): BranchEntry => ({
	type: "message", id: entryId, message: { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "<handoff>thought</handoff>" }, { type: "text", text }] },
});
const user = (entryId: string, text: string): BranchEntry => ({ type: "message", id: entryId, message: { role: "user", content: text } });
const handoffEntry = (entryId: string, note: string, at = "2026-10-03T10:00:00.000Z"): BranchEntry => ({
	type: "custom", id: entryId, customType: HANDOFF_ENTRY, data: { v: 1, path: "/a/compact-handoffs/s.md", note, at, leafId: "x" },
});

test("extractHandoff takes the last non-empty block, trimmed", () => {
	assert.equal(extractHandoff("no block"), undefined);
	assert.equal(extractHandoff("<handoff>  </handoff>"), undefined);
	assert.equal(extractHandoff("a <handoff>\nfirst\n</handoff> b <handoff>second</handoff> <handoff> </handoff>"), "second");
});

test("handoffPath stays under <agent dir>/compact-handoffs and refuses ids that could leave it", () => {
	assert.equal(handoffPath("/agent", "019a-b_c.d"), path.join("/agent", "compact-handoffs", "019a-b_c.d.md"));
	for (const bad of ["../x", "a/b", "", ".hidden", "a b"]) assert.throws(() => handoffPath("/agent", bad), /Unusable session id/);
});

test("agentDir follows PI_CODING_AGENT_DIR as pi does", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/a" }), path.join(os.homedir(), "a"));
	assert.equal(agentDir({}), path.join(os.homedir(), ".pi", "agent"));
});

test("writeNoteFile: 0700 directory, 0600 file, replaced whole, no temp left", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "compact-handoff-"));
	try {
		const file = handoffPath(root, "s1");
		writeNoteFile(file, "one");
		writeNoteFile(file, "two");
		assert.equal(fs.readFileSync(file, "utf8"), "two");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["s1.md"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("latestHandoff: the newest readable entry on the branch", () => {
	const branch = [handoffEntry("h1", "older"), { type: "custom", id: "bad", customType: HANDOFF_ENTRY, data: { v: 2, note: "x" } }, handoffEntry("h2", "newer"), { type: "custom", id: "junk", customType: HANDOFF_ENTRY, data: null }];
	assert.equal(latestHandoff(branch)?.note, "newer");
	assert.equal(latestHandoff([user("u", "hi")]), undefined);
});

test("noteInKeptTail: only an exact block between firstKeptEntryId and the compaction", () => {
	const branch = [reply("a0", "<handoff>N</handoff>"), user("u1", "x"), reply("a1", "<handoff>other</handoff>"), handoffEntry("h", "N"), { type: "compaction", id: "c" }];
	assert.equal(noteInKeptTail(branch, "u1", "c", "N"), false);
	assert.equal(noteInKeptTail(branch, "a0", "c", "N"), true);
	assert.equal(noteInKeptTail(branch, null, "c", "N"), false);
	assert.equal(noteInKeptTail(branch, "missing", "c", "N"), false);
});

test("restoreText names the age and path, and carries the note unless the reply is still kept", () => {
	const data = { v: 1 as const, path: "/a/compact-handoffs/s.md", note: "the NOTE body", at: "2026-10-03T10:00:00.000Z", leafId: null };
	const now = Date.parse("2026-10-03T12:30:00.000Z");
	const full = restoreText(data, now, false);
	assert.match(full, /written 2026-10-03T10:00:00\.000Z \(2 hours ago\)/);
	assert.match(full, /saved at \/a\/compact-handoffs\/s\.md/);
	assert.match(full, /Check it against the summary/);
	assert.match(full, /Verify what it marks unverified before relying on it\./);
	assert.doesNotMatch(full, /Re-read the files/);
	assert.match(full, /<handoff>\nthe NOTE body\n<\/handoff>$/);
	const short = restoreText(data, now, true);
	assert.doesNotMatch(short, /the NOTE body/);
	assert.match(short, /saved at \/a\/compact-handoffs\/s\.md/);
});

test("ago", () => {
	assert.equal(ago(0, 30_000), "just now");
	assert.equal(ago(0, 60_000), "1 minute ago");
	assert.equal(ago(0, 3 * 3_600_000), "3 hours ago");
	assert.equal(ago(0, 2 * 86_400_000), "2 days ago");
});

test("the fork's task: read-only, nuance only, never restating the summary, a <handoff> block, the nothing sentinel, the focus when given", () => {
	const plain = forkTask("");
	assert.match(plain, /read-only copy/);
	assert.match(plain, /nothing reaches the session except your note/);
	assert.match(plain, /Do not restate any of that: no current state, no task list/);
	assert.match(plain, /claims you have not verified, and how to verify each/);
	assert.doesNotMatch(plain, /Anything durable/);
	assert.ok(plain.includes(`If nothing qualifies, write <handoff>${NOTHING_NOTE}</handoff>.`));
	assert.match(plain, /<handoff>…<\/handoff>/);
	assert.doesNotMatch(plain, /focus/);
	assert.match(forkTask("keep the API decisions"), /focus for this handoff and the summary: keep the API decisions/);
});

test("isNothingNote: the sentinel, trimmed, case and a final period ignored; nothing else", () => {
	assert.equal(NOTHING_NOTE, "Nothing beyond the summary.");
	for (const n of ["Nothing beyond the summary.", "  nothing beyond the summary\n", "NOTHING BEYOND THE SUMMARY."]) assert.equal(isNothingNote(n), true, n);
	for (const n of ["Nothing beyond the summary. But: X", "Nothing", ""]) assert.equal(isNothingNote(n), false, n);
});

test("runsRoot sits beside the notes under a dot name no session id can take", () => {
	assert.equal(runsRoot("/agent"), path.join("/agent", "compact-handoffs", ".runs"));
	assert.throws(() => handoffPath("/agent", ".runs"), /Unusable session id/);
});

test("run rows: strict read, the ids still running (newest per id), and their one line", () => {
	const row = (id: string, data: unknown): BranchEntry => ({ type: "custom", id, customType: "compact-handoff-run", data });
	const at = "2026-10-03T10:00:00.000Z";
	assert.equal(readRunData({ v: 1, id: "r", status: "done", at }), undefined);
	assert.equal(readRunData({ v: 2, id: "r", status: "running", at }), undefined);
	assert.deepEqual(readRunData({ v: 1, id: "r", status: "saved", at, path: "/p", error: "" }), { v: 1, id: "r", status: "saved", at, path: "/p" });
	const branch = [
		row("e1", { v: 1, id: "a", status: "running", at }),
		row("e2", { v: 1, id: "b", status: "running", at, focus: "f" }),
		row("e3", { v: 1, id: "a", status: "saved", at, path: "/p" }),
		row("e4", { v: 1, id: "c", status: "running", at }),
		row("e5", { v: 1, id: "c", status: "failed", at, error: "x" }),
	];
	assert.deepEqual(stillRunning(branch).map((d) => d.id), ["b"]);
	assert.equal(runLine({ v: 1, id: "b", status: "running", at, focus: "f" }), "Writing a handoff note: f");
	assert.equal(runLine({ v: 1, id: "a", status: "saved", at, path: "/p" }), "Handoff note saved: /p");
	assert.equal(runLine({ v: 1, id: "c", status: "failed", at, error: "x" }), "Handoff note failed: x");
});
