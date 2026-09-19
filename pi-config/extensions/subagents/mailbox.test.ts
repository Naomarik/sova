import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MAX_INBOX_RECORDS,
	appendInbox,
	awaitResponse,
	decodeMemberContext,
	decodeRequest,
	decodeResponse,
	encodeMemberContext,
	initMemberDir,
	memberPaths,
	readInbox,
	requestId,
	scanMailboxRoot,
	takeRequests,
	takeResponse,
	writeRequest,
	writeResponse,
	type MailboxRequest,
	type MemberContext,
} from "./mailbox.ts";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-mailbox-test-"));
const ctx = (dir: string, extra: Partial<MemberContext> = {}): MemberContext => ({
	version: 1, teamId: "team_01", teamName: "Crew", workerId: "ag_02", role: "dev", orchestrator: false, dir, ...extra,
});
const req = (extra: Partial<MailboxRequest> = {}): MailboxRequest => ({ version: 1, id: requestId(), type: "message", at: Date.now(), to: "lead", message: "hi", ...extra });

test("member context round-trips and decodes strictly", () => {
	const dir = path.join(os.tmpdir(), "x");
	const me = ctx(dir, { orchestrator: true });
	assert.deepEqual(decodeMemberContext(encodeMemberContext(me)), me);
	for (const bad of [
		undefined, "", "{", "[]", JSON.stringify({ ...me, version: 2 }), JSON.stringify({ ...me, teamId: "01" }),
		JSON.stringify({ ...me, workerId: "dev" }), JSON.stringify({ ...me, role: "a\u0007" }), JSON.stringify({ ...me, role: "x".repeat(65) }),
		JSON.stringify({ ...me, orchestrator: "true" }), JSON.stringify({ ...me, dir: "relative/dir" }), JSON.stringify({ ...me, teamName: " " }),
	]) assert.equal(decodeMemberContext(bad), undefined, String(bad));
});

test("requests and responses decode strictly; ids are safe file names", () => {
	assert.match(requestId(), /^[a-z0-9]{6,32}$/);
	const good = req({ mode: "followUp" });
	assert.deepEqual(decodeRequest(good), good);
	assert.equal(decodeRequest({ ...good, to: "  lead " })!.to, "lead", "recipient is trimmed");
	for (const bad of [
		null, [], { ...good, version: 0 }, { ...good, id: "../x" }, { ...good, id: "UPPER1" }, { ...good, type: "spawn" }, { ...good, type: "kill" },
		{ ...good, at: "now" }, { ...good, to: "a\nb" }, { ...good, to: "x".repeat(65) }, { ...good, message: "m".repeat(8001) }, { ...good, mode: "interrupt" },
	]) assert.equal(decodeRequest(bad), undefined, JSON.stringify(bad));
	const minimal = decodeRequest({ version: 1, id: "abcdef", type: "roster", at: 1 })!;
	assert.deepEqual(minimal, { version: 1, id: "abcdef", type: "roster", at: 1 });
	assert.deepEqual(decodeResponse({ version: 1, id: "abcdef", ok: true, text: "t", details: { a: 1 } }), { version: 1, id: "abcdef", ok: true, text: "t", details: { a: 1 } });
	assert.equal(decodeResponse({ version: 1, id: "abcdef", ok: "yes", text: "t" }), undefined);
	assert.equal(decodeResponse({ version: 1, id: "abcdef", ok: true }), undefined);
});

test("request/response files round-trip atomically and are consumed exactly once", async () => {
	const root = tmpRoot();
	try {
		const dir = path.join(root, "team_01", "ag_02");
		initMemberDir(dir);
		const p = memberPaths(dir);
		assert.ok(fs.statSync(p.requests).isDirectory() && fs.statSync(p.responses).isDirectory());
		const a = req();
		const b = req({ type: "question", message: "why?" });
		writeRequest(dir, a);
		writeRequest(dir, b);
		fs.writeFileSync(path.join(p.requests, "zz-broken.json"), "{not json");
		fs.writeFileSync(path.join(p.requests, "zz-wrong.json"), JSON.stringify({ version: 1, id: "abcdef", type: "kill", at: 1 }));
		fs.writeFileSync(path.join(p.requests, "ignored.txt"), "x");
		assert.ok(!fs.readdirSync(p.requests).some((n) => n.endsWith(".tmp")), "no temp files remain after atomic writes");
		const taken = takeRequests(dir);
		assert.deepEqual(new Set(taken.flatMap((t) => (t.request ? [t.request.id] : []))), new Set([a.id, b.id]));
		assert.equal(taken.length, 4);
		assert.equal(taken.filter((t) => !t.request).length, 2, "malformed and wrong-typed files are reported without a request");
		assert.deepEqual(fs.readdirSync(p.requests), ["ignored.txt"], "every .json request was removed on take");
		assert.deepEqual(takeRequests(dir), [], "a request is never handled twice");
		// Responses: absent until written, then consumed once.
		assert.equal(takeResponse(dir, a.id), undefined);
		writeResponse(dir, { version: 1, id: a.id, ok: true, text: "done", details: { n: 1 } });
		assert.deepEqual(takeResponse(dir, a.id), { version: 1, id: a.id, ok: true, text: "done", details: { n: 1 } });
		assert.equal(takeResponse(dir, a.id), undefined);
		assert.deepEqual(fs.readdirSync(p.responses), []);
		// awaitResponse: resolves when the file appears; undefined on timeout; undefined on abort.
		const pending = awaitResponse(dir, b.id, 2000, undefined, 5);
		setTimeout(() => writeResponse(dir, { version: 1, id: b.id, ok: false, text: "nope" }), 20);
		assert.deepEqual(await pending, { version: 1, id: b.id, ok: false, text: "nope" });
		const started = Date.now();
		assert.equal(await awaitResponse(dir, "missing1", 40, undefined, 5), undefined);
		assert.ok(Date.now() - started >= 35);
		const controller = new AbortController();
		const aborted = awaitResponse(dir, "missing2", 5000, controller.signal, 5);
		controller.abort();
		assert.equal(await aborted, undefined);
		assert.equal(await awaitResponse(dir, "missing3", 5000, AbortSignal.abort(), 5), undefined, "pre-aborted returns at once");
		// Missing directories never throw.
		assert.deepEqual(takeRequests(path.join(root, "nope")), []);
		assert.equal(takeResponse(path.join(root, "nope"), "abcdef"), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("inbox appends, reads bounded newest-last and skips torn lines", () => {
	const root = tmpRoot();
	try {
		const dir = path.join(root, "team_01", "ag_02");
		initMemberDir(dir);
		assert.deepEqual(readInbox(dir), []);
		for (let i = 0; i < MAX_INBOX_RECORDS + 5; i++) appendInbox(dir, { at: i, kind: i % 2 ? "instruction" : "message", from: "lead", fromId: "ag_01", text: `m${i}` });
		fs.appendFileSync(memberPaths(dir).inbox, "{torn\n" + JSON.stringify({ at: 1, kind: "spawn", from: "x", fromId: "y", text: "z" }) + "\n");
		const all = readInbox(dir);
		assert.equal(all.length, MAX_INBOX_RECORDS);
		assert.equal(all.at(-1)!.text, `m${MAX_INBOX_RECORDS + 4}`);
		assert.deepEqual(readInbox(dir, 2).map((r) => r.text), [`m${MAX_INBOX_RECORDS + 3}`, `m${MAX_INBOX_RECORDS + 4}`]);
		assert.ok(all.every((r) => r.kind === "message" || r.kind === "instruction"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("scanning the root keys requests by their directory and ignores foreign entries", () => {
	const root = tmpRoot();
	try {
		const a = path.join(root, "team_01", "ag_01");
		const b = path.join(root, "team_02", "ag_05");
		initMemberDir(a);
		initMemberDir(b);
		fs.mkdirSync(path.join(root, "team_01", "not-a-worker", "requests"), { recursive: true });
		fs.mkdirSync(path.join(root, "notes", "ag_09", "requests"), { recursive: true });
		fs.writeFileSync(path.join(root, "team_01", "not-a-worker", "requests", "x.json"), JSON.stringify(req()));
		fs.writeFileSync(path.join(root, "notes", "ag_09", "requests", "x.json"), JSON.stringify(req()));
		const ra = req({ type: "roster" });
		const rb = req({ type: "message", to: "all", message: "hello" });
		writeRequest(a, ra);
		writeRequest(b, rb);
		const found = scanMailboxRoot(root).sort((x, y) => x.workerId.localeCompare(y.workerId));
		assert.deepEqual(found.map((f) => [f.teamId, f.workerId, f.dir, f.request?.id]), [["team_01", "ag_01", a, ra.id], ["team_02", "ag_05", b, rb.id]]);
		assert.deepEqual(scanMailboxRoot(root), []);
		assert.deepEqual(scanMailboxRoot(path.join(root, "missing")), []);
		assert.ok(fs.existsSync(path.join(root, "team_01", "not-a-worker", "requests", "x.json")), "entries outside the naming scheme are never read or removed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
