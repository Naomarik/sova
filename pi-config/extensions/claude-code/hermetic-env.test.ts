/**
 * The runner's throwaway home took effect: whatever this process inherited (a session on an added
 * Claude login has CLAUDE_CONFIG_DIR = that login's real directory), everything a test reaches
 * through the host's defaults — hostLogins(), leases, the state file — lands in a temp dir.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ClaudeLogins, LEASES_DIR_NAME, defaultAgentDir, defaultClaudeDir, hostLogins, loginDir, writeAccounts } from "./accounts.ts";

const inside = (dir: string, root: string) => !path.relative(root, dir).startsWith("..") && !path.isAbsolute(path.relative(root, dir));

test("tests run in a throwaway home: the agent dir and Claude's directory resolve inside it", () => {
	const root = process.env.SOVA_TEST_HOME;
	assert.ok(root, "the runner did not import tests/hermetic-env.mjs first");
	assert.ok(inside(fs.realpathSync(root), fs.realpathSync(os.tmpdir())), `${root} is not a temp dir`);
	assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
	assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
	for (const dir of [os.homedir(), defaultAgentDir(), defaultClaudeDir(), hostLogins().agentDir, new ClaudeLogins().defaultDir]) {
		assert.ok(inside(dir, root), `${dir} is outside ${root}`);
	}
});

test("a lease taken through the host's resolver is written under the throwaway home", () => {
	const logins = hostLogins();
	const id = "l-7e570001";
	writeAccounts(logins.agentDir, { version: 1, logins: [{ id, addedAt: 1, enabled: true, device: "local", identity: null }], devices: {} });
	fs.mkdirSync(loginDir(logins.agentDir, id), { recursive: true });
	const lease = logins.track(id, { busy: () => true, release: () => {}, pid: () => 4242 });
	try {
		const file = path.join(loginDir(logins.agentDir, id), LEASES_DIR_NAME, `${process.pid}.json`);
		assert.ok(fs.existsSync(file));
		assert.ok(inside(file, process.env.SOVA_TEST_HOME!));
	} finally {
		lease.done();
		fs.rmSync(path.join(logins.agentDir, "claude-accounts.json"), { force: true });
		fs.rmSync(path.join(logins.agentDir, "claude-accounts"), { recursive: true, force: true });
	}
});
