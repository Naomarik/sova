// The shared folder under the real backend: what bash (not only the file tools) may do in it.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backendFor, type Policy } from "../backend.ts";
import { scrubEnv } from "../env.ts";
import { narrowScope, type ParentScope, parentScopeOf, resolvePolicy, type ResolvedPolicy, writeOnlyScope } from "../policy.ts";
import { chatSharedFolder, ensureSharedFolder, memberNoteDir, sharedTeamsDir } from "../shared-folder.ts";
import { confinedDefinitions, type Snapshot } from "../tools.ts";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "sandbox-policy");
const bwrap = process.platform === "linux" && existsSync("/usr/bin/bwrap");

function world() {
	// Not under /tmp: inside, /tmp is the session tmp.
	const root = realpathSync(mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : tmpdir(), "sbx-shared-bwrap-")));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "sandbox-policy"), { recursive: true });
	cpSync(TEMPLATE_DIR, join(agentDir, "sandbox-policy"), { recursive: true });
	const ws = join(root, "wt");
	mkdirSync(join(ws, ".agent"), { recursive: true });
	const tmpDir = join(root, "sessiontmp");
	mkdirSync(tmpDir);
	const shared = chatSharedFolder("chat-1", home);
	const a = memberNoteDir(shared, "chat-1", "team_01", "builder");
	const b = memberNoteDir(shared, "chat-1", "team_01", "reviewer");
	ensureSharedFolder(shared, a);
	ensureSharedFolder(shared, b);
	return { root, home, agentDir, ws, tmpDir, shared, a, b, teams: sharedTeamsDir(shared), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function backendPolicy(p: ResolvedPolicy, network: Policy["network"]): Policy {
	return { level: p.level, workspaceRoot: p.workspaceRoot, writable: p.writable, readOnlyWithinWritable: p.readOnlyWithinWritable, hidden: p.hidden, tmpDir: p.tmpDir, shadowed: p.shadowed, network, env: p.writeOnly ? { PATH: process.env.PATH! } : scrubEnv(process.env, p.envAllow), sessionId: "unit" };
}

async function bashUnder(w: ReturnType<typeof world>, parent: ParentScope, network: Policy["network"]) {
	const r = resolvePolicy({ agentDir: w.agentDir, cwd: w.ws, tmpDir: w.tmpDir, platform: "linux", home: w.home, parent });
	assert.ok(r.ok, r.ok ? "" : r.error);
	const backend = backendFor("linux");
	const bp = backendPolicy(r.value, network);
	const probe = await backend.probe(bp);
	assert.ok(probe.ok, probe.ok ? "" : probe.reason);
	const snap = async (): Promise<Snapshot> => ({ ok: true, policy: r.value, backendPolicy: bp, backend, enforcement: probe.enforcement });
	const bash = confinedDefinitions(w.ws, {}, { snapshot: snap }).find((d) => d.name === "bash")!;
	return async (command: string) => {
		const res = await bash.execute("id", { command }, undefined, undefined, { cwd: w.ws, sessionManager: { getSessionId: () => "unit", getSessionFile: () => undefined } } as never);
		return { ok: !(res as { isError?: boolean }).isError, text: res.content.map((c: { text?: string }) => c.text ?? "").join("") };
	};
}

/** Member A (note folder `a`): its own note and the folder, nothing of B's or of teams/. */
async function assertMemberA(w: ReturnType<typeof world>, sh: (c: string) => Promise<{ ok: boolean; text: string }>, name: string) {
	assert.ok((await sh(`echo mine > ${join(w.a, "handover.md")}`)).ok, `${name}: A writes its own note`);
	assert.equal(readFileSync(join(w.a, "handover.md"), "utf8"), "mine\n");
	assert.equal((await sh(`echo forged > ${join(w.b, "handover.md")}`)).ok, false, `${name}: A can't write B's note`);
	assert.equal(existsSync(join(w.b, "handover.md")), false, `${name}: B's note was never planted`);
	assert.equal((await sh(`echo x > ${join(w.teams, "x")}`)).ok, false, `${name}: teams/ itself is read-only`);
	assert.equal((await sh(`mkdir ${join(w.teams, "chat-1", "team_01", "new")}`)).ok, false, `${name}: no folder for a role not yet there`);
	assert.equal(existsSync(join(w.teams, "chat-1", "team_01", "new")), false);
	assert.equal((await sh(`mv ${w.teams} ${join(w.shared, "t2")}`)).ok, false, `${name}: the read-only teams/ can't be renamed away`);
	assert.ok(existsSync(w.teams) && !existsSync(join(w.shared, "t2")));
	assert.ok((await sh(`echo brief > ${join(w.shared, "brief.md")}`)).ok, `${name}: the shared folder is writable`);
	assert.equal(readFileSync(join(w.shared, "brief.md"), "utf8"), "brief\n");
}

test("bash in a Subagents-only member: its own note and the shared folder, never another member's note or teams/", { skip: !bwrap }, async () => {
	const w = world();
	try {
		const sh = await bashUnder(w, writeOnlyScope(w.ws, { shared: w.shared, note: w.a }), { mode: "host" });
		await assertMemberA(w, sh, "write-only");
	} finally {
		w.cleanup();
	}
});

test("bash in an On member (the parent's scope narrowed to the branch, plus its note folder): the same", { skip: !bwrap }, async () => {
	const w = world();
	try {
		const chat = resolvePolicy({ agentDir: w.agentDir, cwd: w.root, tmpDir: join(w.root, "chattmp"), platform: "linux", home: w.home, extraWritable: [w.ws], extraReadOnly: [join(w.ws, ".agent")], shared: w.shared });
		assert.ok(chat.ok, chat.ok ? "" : chat.error);
		const scope: ParentScope = { ...narrowScope(parentScopeOf(chat.value), w.ws), note: w.a };
		const sh = await bashUnder(w, scope, { mode: "none" });
		await assertMemberA(w, sh, "On");
	} finally {
		w.cleanup();
	}
});
