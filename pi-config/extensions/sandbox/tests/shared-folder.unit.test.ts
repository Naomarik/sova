import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isWithin, narrowScope, parentScopeOf, parseParentScope, type PolicyFile, resolvePolicy, validatePolicyFile, writeDenial, writeOnlyScope } from "../policy.ts";
import { resolveSessionPolicy, sessionSharedFolder } from "../session-policy.ts";
import { chatSharedFolder, ensureSharedFolder, memberNoteDir, removeChatSharedFolder, SHARED_DIR_ENV, sharedFolderOf, sharedTeamsDir } from "../shared-folder.ts";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "sandbox-policy", "linux", "policy.json");
const template = (): PolicyFile => {
	const v = validatePolicyFile(JSON.parse(readFileSync(TEMPLATE, "utf8")));
	assert.ok(v.ok);
	return v.value;
};

/** A home, an agent dir with the linux template, a live checkout and a worktree, and the chat's shared folder. */
function world() {
	const ws = realpathSync(mkdtempSync(join(tmpdir(), "sbx-shared-")));
	const home = join(ws, "home");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
	writeFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), JSON.stringify(template()));
	const live = join(ws, "live");
	const wt = join(ws, "wt");
	mkdirSync(live);
	mkdirSync(join(wt, ".agent"), { recursive: true });
	const shared = chatSharedFolder("0199aaaa-1111-7000-8000-000000000001", home);
	ensureSharedFolder(shared);
	return { ws, home, agentDir, live, wt, shared, done: () => rmSync(ws, { recursive: true, force: true }) };
}

test("the shared folder sits outside the agent dir and every repo, one per chat", () => {
	const w = world();
	assert.equal(w.shared, join(w.home, ".local", "state", "sova", "shared", "0199aaaa-1111-7000-8000-000000000001"));
	assert.ok(!isWithin(w.shared, w.agentDir), "never in the agent dir, which is read-only to every confined agent");
	assert.ok(!isWithin(w.shared, join(w.home, ".pi")));
	assert.notEqual(chatSharedFolder("other", w.home), w.shared);
	assert.equal(chatSharedFolder("../../x", w.home), join(w.home, ".local", "state", "sova", "shared", "x"), "a key never climbs out");
	assert.throws(() => chatSharedFolder("..", w.home), /needs a session key/);
	w.done();
});

test("b1: file tools may write <shared>/brief.md for an On chat, its On worker, a Subagents-only worker, and both narrowed to the branch", () => {
	const w = world();
	const brief = join(w.shared, "brief.md");
	// The On chat itself (its session id names its folder).
	const chat = resolveSessionPolicy({ agentDir: w.agentDir, cwd: w.live, sessionId: "0199aaaa-1111-7000-8000-000000000001", tmpDir: join(w.ws, "t"), home: w.home, platform: "linux", worktreeRoots: [w.wt] });
	assert.ok(chat.ok, chat.ok ? "" : chat.error);
	assert.equal(chat.value.shared, w.shared);
	assert.equal(writeDenial(chat.value, brief, { creating: true }), undefined, "the On chat");
	// Its worker: the scope carries the folder as `shared`, not as a writable root of its own.
	const on = parseParentScope(JSON.stringify(parentScopeOf(chat.value)));
	assert.ok(on.ok);
	assert.equal(on.value.shared, w.shared);
	assert.ok(!on.value.writable.some((r) => isWithin(r, w.shared)));
	const subagentsOnly = writeOnlyScope(w.wt, { shared: w.shared });
	const scopes = [
		["On worker", on.value, w.live],
		["On worker narrowed to the branch", narrowScope(on.value, w.wt), w.wt],
		["Subagents-only worker", subagentsOnly, w.wt],
		["Subagents-only worker, parsed", parseParentScope(JSON.stringify(subagentsOnly)).ok ? subagentsOnly : undefined, w.wt],
	] as const;
	for (const [name, parent, cwd] of scopes) {
		assert.ok(parent, name);
		const r = resolvePolicy({ agentDir: w.agentDir, cwd, tmpDir: join(w.ws, "t2"), home: w.home, platform: "linux", parent });
		assert.ok(r.ok, `${name}: ${r.ok ? "" : r.error}`);
		assert.equal(r.value.outsideParent, undefined, name);
		assert.equal(writeDenial(r.value, brief, { creating: true }), undefined, `${name}: may write the brief`);
		assert.equal(writeDenial(r.value, join(w.shared, "reports", "r.md"), { creating: true }), undefined, `${name}: and below it`);
		assert.match(writeDenial(r.value, join(w.agentDir, "brief.md"), { creating: true }) ?? "", /read-only|outside/, `${name}: the agent dir stays closed`);
	}
	w.done();
});

test("a member writes only its own handover note: never another member's, and never hands its note folder on", () => {
	const w = world();
	const a = memberNoteDir(w.shared, "chat", "team_01", "builder");
	const b = memberNoteDir(w.shared, "chat", "team_01", "reviewer");
	ensureSharedFolder(w.shared, a);
	ensureSharedFolder(w.shared, b);
	for (const [name, scope] of [
		["Subagents-only member", writeOnlyScope(w.wt, { shared: w.shared, note: a })],
		["On member", { ...narrowScope(parentScopeOf({ level: "workspace-write", workspaceRoot: w.live, writable: [w.live, w.wt, "/t"], tmpDir: "/t", shared: w.shared }), w.wt), note: a }],
	] as const) {
		const parsed = parseParentScope(JSON.stringify(scope));
		assert.ok(parsed.ok, name);
		const r = resolvePolicy({ agentDir: w.agentDir, cwd: w.wt, tmpDir: join(w.ws, "t"), home: w.home, platform: "linux", parent: parsed.value });
		assert.ok(r.ok, name);
		assert.equal(writeDenial(r.value, join(a, "handover.md"), { creating: true }), undefined, `${name}: its own note`);
		assert.match(writeDenial(r.value, join(b, "handover.md"), { creating: true }) ?? "", /read-only/, `${name}: B's note, which would start B's successor`);
		assert.match(writeDenial(r.value, join(memberNoteDir(w.shared, "chat", "team_01", "new-role"), "handover.md"), { creating: true }) ?? "", /read-only/, `${name}: no folder of a role not yet there`);
		assert.match(writeDenial(r.value, join(sharedTeamsDir(w.shared), "x.md"), { creating: true }) ?? "", /read-only/, `${name}: teams/ itself`);
		// What it hands its own workers: the folder, never its note folder.
		assert.equal(narrowScope(parsed.value, w.wt).note, undefined, `${name}: narrowed`);
		const down = parentScopeOf(r.value);
		assert.equal(down.note, undefined, `${name}: handed on`);
		assert.ok(!down.writable.some((p) => isWithin(p, w.shared)), `${name}: nothing in the folder as a root`);
		assert.equal(down.shared, w.shared);
	}
	// A note folder outside teams/ could only widen the scope: it is ignored.
	const wide = resolvePolicy({ agentDir: w.agentDir, cwd: w.wt, tmpDir: join(w.ws, "t"), home: w.home, platform: "linux", parent: writeOnlyScope(w.wt, { shared: w.shared, note: w.live }) });
	assert.ok(wide.ok);
	assert.match(writeDenial(wide.value, join(w.live, "x"), { creating: true }) ?? "", /outside/);
	w.done();
});

test("the scope's shared folder parses fail closed, and read-only and no-id sessions get none", () => {
	const w = world();
	const wo = writeOnlyScope(w.wt, { shared: w.shared, note: memberNoteDir(w.shared, "c", "team_01", "x") });
	assert.deepEqual(parseParentScope(JSON.stringify(wo)), { ok: true, value: wo });
	assert.equal(parseParentScope(JSON.stringify({ ...wo, shared: "rel" })).ok, false);
	assert.equal(parseParentScope(JSON.stringify({ ...wo, shared: 3 })).ok, false);
	const { shared: _s, ...noteOnly } = wo;
	assert.equal(parseParentScope(JSON.stringify(noteOnly)).ok, false, "a note needs its shared folder");
	assert.equal(writeOnlyScope(w.wt, { note: "/x" }).note, undefined);
	const ro = resolveSessionPolicy({ agentDir: w.agentDir, cwd: w.live, sessionId: "s1", tmpDir: join(w.ws, "t"), home: w.home, platform: "linux", readOnly: true });
	assert.ok(ro.ok);
	assert.equal(ro.value.shared, undefined, "read-only writes only its tmp");
	assert.equal(parentScopeOf(ro.value).shared, undefined);
	assert.equal(sessionSharedFolder({ sessionId: "", home: w.home }), undefined);
	assert.equal(sessionSharedFolder({ sessionId: "s1", home: w.home, shared: "/inherited" }), "/inherited");
	assert.equal(sessionSharedFolder({ sessionId: "s1", home: w.home, parent: wo }), w.shared, "a worker's is its parent's");
	w.done();
});

test("sharedFolderOf: a worker's inherited folder, else the chat's own", () => {
	const home = "/h";
	const scope = JSON.stringify(writeOnlyScope("/wt", { shared: "/h/.local/state/sova/shared/root" }));
	assert.equal(sharedFolderOf({ sessionId: "w1", workerFlags: { sandbox: "on", "sandbox-parent": scope }, home }), "/h/.local/state/sova/shared/root");
	assert.equal(sharedFolderOf({ sessionId: "w1", env: { [SHARED_DIR_ENV]: "/env/shared" }, home }), "/env/shared");
	assert.equal(sharedFolderOf({ sessionId: "c1", home }), "/h/.local/state/sova/shared/c1");
	assert.equal(sharedFolderOf({ sessionId: "w1", workerFlags: { sandbox: "on", "sandbox-parent": JSON.stringify(writeOnlyScope("/wt")) }, home }), undefined, "a confined worker never guesses its own");
	assert.equal(sharedFolderOf({ sessionId: "", home }), undefined);
});

test("archiving removes the chat's folder and nothing else", () => {
	const w = world();
	const other = chatSharedFolder("other", w.home);
	ensureSharedFolder(other);
	writeFileSync(join(w.shared, "brief.md"), "x");
	assert.equal(removeChatSharedFolder("0199aaaa-1111-7000-8000-000000000001", w.home), true);
	assert.equal(existsSync(w.shared), false);
	assert.equal(existsSync(other), true);
	assert.equal(removeChatSharedFolder("..", w.home), true, "an empty key removes nothing");
	assert.equal(existsSync(join(w.home, ".local", "state", "sova", "shared")), true);
	w.done();
});
