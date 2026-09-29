#!/usr/bin/env node
// Prove a test command never writes into the directories it inherits: HOME, PI_CODING_AGENT_DIR and
// CLAUDE_CONFIG_DIR point at a sentinel copy of a real host's layout (a phase-1 registry with two
// logins, one of them the directory CLAUDE_CONFIG_DIR names — as in a session that runs on an added
// login — mesh on, synthetic credentials), the command runs, and every file there must be exactly
// as it was. Exit 1 on any difference, else the command's own exit code.
//
//   node scripts/test-sentinel.mjs -- <command> [args…]
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sep = process.argv.indexOf("--");
const command = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);
if (!command.length) {
	console.error("usage: node scripts/test-sentinel.mjs -- <command> [args…]");
	process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sova-sentinel-"));
const home = path.join(root, "home");
const agent = path.join(root, "agent");
const claude = path.join(home, ".claude");
const write = (file, value) => {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
};
const creds = (n) => ({ claudeAiOauth: { accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`, expiresAt: 4102444800000, scopes: ["user:inference"], subscriptionType: "max" } });
const identity = (n) => ({ accountUuid: `acct-sentinel-${n}`, email: `sentinel${n}@example.com`, orgUuid: "org-sentinel", orgName: "Sentinel", plan: "max" });
const logins = ["l-5e471001", "l-5e471002"];

write(path.join(claude, ".credentials.json"), creds(0));
write(path.join(claude, "settings.json"), {});
fs.mkdirSync(path.join(claude, "projects"), { recursive: true });
write(path.join(home, ".claude.json"), { oauthAccount: { emailAddress: "sentinel0@example.com", accountUuid: "acct-sentinel-0" } });
write(path.join(agent, "claude-accounts.json"), {
	version: 1,
	logins: logins.map((id, i) => ({ id, addedAt: 1_700_000_000_000 + i, enabled: true, device: i === 0 ? "local" : "sentinel-desk", identity: identity(i + 1) })),
	devices: { "sentinel-desk": { order: [logins[0], "default", logins[1]] } },
});
write(path.join(agent, "sova", "peers.json"), { version: 1, self: { id: "sentinel-desk", label: "desk" }, peers: [{ id: "sentinel-peer", label: "peer", url: "http://127.0.0.1:9" }] });
for (const [i, id] of logins.entries()) {
	const dir = path.join(agent, "claude-accounts", id);
	write(path.join(dir, ".credentials.json"), creds(i + 1));
	write(path.join(dir, ".claude.json"), { oauthAccount: { emailAddress: identity(i + 1).email, accountUuid: identity(i + 1).accountUuid } });
	fs.symlinkSync(path.join(claude, "projects"), path.join(dir, "projects"));
	fs.symlinkSync(path.join(claude, "settings.json"), path.join(dir, "settings.json"));
}

function snapshot() {
	const out = new Map();
	const walk = (dir) => {
		for (const name of fs.readdirSync(dir)) {
			const file = path.join(dir, name);
			const st = fs.lstatSync(file);
			const rel = path.relative(root, file);
			if (st.isSymbolicLink()) out.set(rel, `link ${fs.readlinkSync(file)}`);
			else if (st.isDirectory()) { out.set(rel, `dir ${(st.mode & 0o777).toString(8)}`); walk(file); }
			else out.set(rel, `file ${(st.mode & 0o777).toString(8)} ${st.mtimeMs} ${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`);
		}
	};
	walk(root);
	return out;
}

// Resolve the Pi package with the real environment: `npm root -g` may depend on the real HOME's npmrc.
let piPackage = process.env.PI_PACKAGE_DIR;
if (!piPackage) {
	try { piPackage = path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"); } catch { /* the command resolves it */ }
}

const before = snapshot();
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, CLAUDE_CONFIG_DIR: path.join(agent, "claude-accounts", logins[0]), ...(piPackage ? { PI_PACKAGE_DIR: piPackage } : {}) };
console.error(`[sentinel] ${root}\n[sentinel] running: ${command.join(" ")}`);
const run = spawnSync(command[0], command.slice(1), { stdio: "inherit", env });
const after = snapshot();
if (run.error) console.error(`[sentinel] could not run the command: ${run.error.message}`);

const changes = [];
for (const [rel, sig] of after) if (before.get(rel) !== sig) changes.push(`${before.has(rel) ? "changed" : "added"} ${rel}`);
for (const rel of before.keys()) if (!after.has(rel)) changes.push(`removed ${rel}`);
if (changes.length) {
	console.error(`[sentinel] FAIL: the command wrote into the inherited directories (${changes.length}):`);
	for (const line of changes.slice(0, 50)) console.error(`  ${line}`);
	console.error(`[sentinel] left in place for inspection: ${root}`);
	process.exit(1);
}
fs.rmSync(root, { recursive: true, force: true });
console.error(`[sentinel] PASS: nothing under the inherited HOME / PI_CODING_AGENT_DIR / CLAUDE_CONFIG_DIR changed (command exit ${run.status ?? run.signal})`);
process.exit(run.status ?? 1);
