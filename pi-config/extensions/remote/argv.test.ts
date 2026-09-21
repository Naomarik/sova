import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildListDirsArgv,
	buildTargetArgv,
	DEFAULT_SSH_OPTIONS,
	parseListDirsOutput,
	parseTargetsFile,
	placeholderDir,
	placeholderRoot,
	shJoin,
	shQuote,
	toRemotePath,
	validateTarget,
	type Target,
} from "./argv.ts";

const prod: Target = {
	name: "acme-prod",
	label: "acme prod",
	kind: "ssh",
	ssh: { user: "deploy", host: "192.0.2.10", port: 22, key: "~/.ssh/id_rsa", options: ["ControlPersist=1h"] },
	cwd: "/home/deploy/acme-site",
};

/** Run argv locally with no shell, the way every caller must. */
const run = (argv: string[], input?: string) => spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", input });

/** Values of every `-o` option in an ssh argv. */
const sshOptions = (argv: string[]) => argv.flatMap((w, i) => (argv[i - 1] === "-o" ? [w] : []));

// ---------------------------------------------------------------------------
// quoting

test("shQuote round-trips hostile strings through sh as one word", () => {
	for (const v of ["plain", "it's", "$(touch /tmp/x)", "`id`", 'a"b', "a\\b", "new\nline", "*", "-n", "", "'''", "~/x"]) {
		const r = run(["sh", "-c", `printf %s ${shQuote(v)}`]);
		assert.equal(r.stdout, v);
	}
	assert.throws(() => shQuote("a\0b"));
});

test("shJoin rebuilds the exact argv in a shell", () => {
	const argv = ["printf", "%s|", "a b", "it's", "$HOME", "", "x=y"];
	assert.equal(run(["sh", "-c", shJoin(argv)]).stdout, "a b|it's|$HOME||x=y|");
});

// ---------------------------------------------------------------------------
// ssh transport

test("ssh: batch mode, ControlMaster defaults after the entry's own options, key expanded, far command last", () => {
	const argv = buildTargetArgv(prod, { command: "hostname" });
	assert.deepEqual(argv.slice(0, 4), ["ssh", "-T", "-o", "BatchMode=yes"]);
	const opts = sshOptions(argv);
	assert.equal(opts[0], "BatchMode=yes");
	assert.ok(opts.indexOf("ControlPersist=1h") < opts.indexOf("ControlPersist=10m"), "entry options precede defaults (ssh keeps the first)");
	for (const o of ["ControlMaster=auto", "ControlPath=~/.ssh/cm-%C", "ConnectTimeout=10"]) assert.ok(opts.includes(o), o);
	assert.ok(DEFAULT_SSH_OPTIONS.includes("ControlMaster=auto"));
	assert.deepEqual(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2), ["-p", "22"]);
	assert.equal(argv[argv.indexOf("-i") + 1], join(homedir(), ".ssh/id_rsa"));
	assert.equal(argv.at(-2), "deploy@192.0.2.10");
	assert.equal(argv.at(-3), "--");
	// The far login shell parses the last word back into `sh -c <script>`.
	const far = run(["sh", "-c", `printf '%s\\n' ${argv.at(-1)}`]).stdout.split("\n");
	assert.deepEqual(far.slice(0, 2), ["sh", "-c"]);
	assert.equal(far.slice(2).join("\n").trimEnd(), "cd -- '/home/deploy/acme-site' || exit 1\nhostname");
});

test("root is allowed", () => {
	const t: Target = { ...prod, ssh: { ...prod.ssh!, user: "root" } };
	assert.deepEqual(validateTarget(t), []);
	assert.equal(buildTargetArgv(t, { command: "true" }).at(-2), "root@192.0.2.10");
});

test("aws-ssm proxy adds exactly one ProxyCommand, replacing any from the entry", () => {
	const t: Target = {
		...prod,
		ssh: { user: "ec2-user", host: "i-0abc", key: "~/.ssh/k", options: ["ProxyCommand=nc %h %p"] },
		proxy: { type: "aws-ssm", profile: "p", region: "eu-central-1", pushKey: "ec2-instance-connect" },
	};
	const pc = sshOptions(buildTargetArgv(t, { command: "true" })).filter((o) => o.startsWith("ProxyCommand="));
	assert.equal(pc.length, 1);
	const cmd = pc[0]!;
	assert.match(cmd, /aws ssm start-session --document-name AWS-StartSSHSession --profile p --region eu-central-1/);
	assert.match(cmd, /ec2-instance-connect send-ssh-public-key/);
	assert.match(cmd, / sh %h %r %p /);
	assert.ok(cmd.includes(`${homedir()}/.ssh/k.pub`));
	// Without an entry-level ProxyCommand the count is still one; without proxy there is none.
	assert.equal(sshOptions(buildTargetArgv({ ...t, ssh: { ...t.ssh!, options: [] } }, { command: "true" })).filter((o) => o.startsWith("ProxyCommand=")).length, 1);
	assert.equal(sshOptions(buildTargetArgv(prod, { command: "true" })).filter((o) => o.startsWith("ProxyCommand=")).length, 0);
});

test("aws-ssm ProxyCommand runs the right aws argv once ssh expands %h %r %p", () => {
	const t: Target = { ...prod, ssh: { user: "ec2-user", host: "i-0abc", key: "/k" }, proxy: { type: "aws-ssm", profile: "it's", pushKey: "ec2-instance-connect" } };
	const cmd = sshOptions(buildTargetArgv(t, { command: "true" })).find((o) => o.startsWith("ProxyCommand="))!.slice("ProxyCommand=".length);
	const expanded = cmd.replace(/%h/g, "i-0abc").replace(/%r/g, "ec2-user").replace(/%p/g, "22").replace(/%%/g, "%");
	// Stub `aws` to print its argv to stderr (the push's stdout is discarded), one call per line.
	const bin = mkdtempSync(join(tmpdir(), "remote-aws-"));
	try {
		writeFileSync(join(bin, "aws"), `#!/bin/sh\nfor a; do printf "[%s]" "$a" >&2; done; echo >&2\n`, { mode: 0o755 });
		const r = spawnSync("sh", ["-c", `exec ${expanded}`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
		const lines = r.stderr.trim().split("\n");
		assert.equal(lines[0], "[ec2-instance-connect][send-ssh-public-key][--profile][it's][--instance-id][i-0abc][--instance-os-user][ec2-user][--ssh-public-key][file:///k.pub]");
		assert.equal(lines[1], "[ssm][start-session][--document-name][AWS-StartSSHSession][--profile][it's][--target][i-0abc][--parameters][portNumber=22]");
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// environments

test("incus cell: sudo, sandbox, nested exec with uid/gid/cwd, ending in sh -c", () => {
	const t: Target = { name: "cell", kind: "incus-cell", incus: { sudo: true, sandbox: "foldai-sandbox", cell: "foldai-cell-abc", uid: 70000, gid: 70000 }, cwd: "/work" };
	const argv = buildTargetArgv(t, { command: "ls" });
	assert.deepEqual(argv.slice(0, -1), [
		"sudo", "-n", "incus", "exec", "foldai-sandbox", "--",
		"incus", "exec", "foldai-cell-abc", "--user", "70000", "--group", "70000", "--cwd", "/work", "--",
		"sh", "-c",
	]);
	assert.equal(argv.at(-1), "cd -- '/work' || exit 1\nls");
	// Without a sandbox the cell is a direct instance.
	assert.deepEqual(buildTargetArgv({ ...t, incus: { cell: "c" }, cwd: undefined }, { command: "ls" }), ["incus", "exec", "c", "--", "sh", "-c", "ls"]);
});

test("docker: exec -i with user, env via env(1)", () => {
	const t: Target = { name: "web", kind: "docker", docker: { container: "web", user: "app" }, env: { TERM: "dumb" } };
	assert.deepEqual(buildTargetArgv(t, { command: "id" }), ["docker", "exec", "-i", "-u", "app", "web", "env", "TERM=dumb", "sh", "-c", "id"]);
});

test("via: the inner chain rides inside the outer target's sh -c; cycles and missing targets throw", () => {
	const web: Target = { name: "web", kind: "docker", docker: { container: "web" }, via: "acme-prod", cwd: "/app" };
	const argv = buildTargetArgv(web, { command: "pwd", registry: [prod, web] });
	assert.equal(argv[0], "ssh");
	assert.equal(argv.at(-2), "deploy@192.0.2.10");
	// Peel the two shell layers the far side applies: login shell, then the outer sh -c.
	const outer = run(["sh", "-c", `printf '%s\\n' ${argv.at(-1)}`]).stdout.split("\n");
	assert.deepEqual(outer.slice(0, 2), ["sh", "-c"]);
	const outerScript = outer.slice(2).join("\n").trimEnd();
	assert.ok(!outerScript.includes("acme-site"), "the outer target's cwd is not applied to the via hop");
	const inner = run(["sh", "-c", outerScript.replace(/^docker exec -i web /, "printf '%s\\n' ")]).stdout;
	assert.equal(inner, "sh\n-c\ncd -- '/app' || exit 1\npwd\n");
	assert.throws(() => buildTargetArgv(web, { command: "x", registry: [web] }), /not found/);
	const a: Target = { name: "a", kind: "docker", docker: { container: "a" }, via: "b" };
	const b: Target = { name: "b", kind: "docker", docker: { container: "b" }, via: "a" };
	assert.throws(() => buildTargetArgv(a, { command: "x", registry: [a, b] }), /cycle/);
});

// ---------------------------------------------------------------------------
// the folder browser path is user input: it must stay data

test("a hostile folder path is passed as data (local, and through a simulated ssh login shell)", () => {
	const root = mkdtempSync(join(tmpdir(), "remote-quote-"));
	const pwned = join(root, "pwned");
	const hostile = join(root, `it's`, `$(touch ${pwned})`);
	try {
		mkdirSync(join(hostile, "child dir"), { recursive: true });
		const local: Target = { name: "here", kind: "docker", docker: { container: "unused" } };
		// "Local" transport: strip the docker layer and run the far argv directly.
		const argv = buildListDirsArgv(local, hostile);
		const far = argv.slice(argv.indexOf("sh"));
		const r1 = run(far);
		assert.equal(r1.status, 0, r1.stderr);
		assert.deepEqual(parseListDirsOutput(r1.stdout), { path: hostile, dirs: ["child dir"] });
		// ssh: the last word is what the far login shell parses. Evaluate it with a local sh.
		const sshArgv = buildListDirsArgv(prod, hostile);
		const r2 = run(["sh", "-c", sshArgv.at(-1)!]);
		assert.equal(r2.status, 0, r2.stderr);
		assert.deepEqual(parseListDirsOutput(r2.stdout), { path: hostile, dirs: ["child dir"] });
		// And as a session cwd.
		const r3 = run(["sh", "-c", buildTargetArgv(prod, { command: "pwd", cwd: hostile }).at(-1)!]);
		assert.equal(r3.stdout, `${hostile}\n`);
		assert.equal(existsSync(pwned), false, "the $(…) in the path must never execute");
		// A missing folder exits 3 without a listing.
		const r4 = run(["sh", "-c", buildListDirsArgv(prod, join(root, "nope")).at(-1)!]);
		assert.equal(r4.status, 3);
		assert.equal(parseListDirsOutput(r4.stdout), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("list dirs: ~ is the far $HOME, dotdirs included, noise before the marker ignored", () => {
	const home = mkdtempSync(join(tmpdir(), "remote-home-"));
	try {
		for (const d of ["b", "a", ".hidden", "..odd"]) mkdirSync(join(home, d));
		const r = spawnSync("sh", ["-c", `echo motd; ${buildListDirsArgv(prod, "~").at(-1)}`], { encoding: "utf8", env: { ...process.env, HOME: home } });
		const out = parseListDirsOutput(r.stdout)!;
		assert.equal(out.path, home);
		assert.deepEqual(out.dirs.sort(), ["..odd", ".hidden", "a", "b"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// registry file and placeholder paths

test("validateTarget and parseTargetsFile", () => {
	assert.deepEqual(validateTarget(prod), []);
	assert.match(validateTarget({ name: "x", kind: "local" }).join(), /kind must be/);
	assert.match(validateTarget({ name: "x", kind: "ssh" }).join(), /needs an ssh block/);
	assert.match(validateTarget({ name: "x", kind: "incus-cell" }).join(), /needs an incus block/);
	assert.match(validateTarget({ name: "x", kind: "docker", docker: { container: "-rm" } }).join(), /container/);
	assert.match(validateTarget({ ...prod, ssh: { host: "-oProxyCommand=evil" } }).join(), /ssh.host/);
	assert.match(validateTarget({ ...prod, name: "../x" }).join(), /name/);
	for (const name of [".", "..", "..."]) assert.match(validateTarget({ ...prod, name }).join(), /name/, name);
	assert.deepEqual(validateTarget({ ...prod, name: "a.b..c" }), []);
	assert.match(validateTarget({ ...prod, env: { "A B": "x" } }).join(), /env/);
	assert.deepEqual(validateTarget({ name: "c", kind: "docker", docker: { container: "c" }, via: "acme-prod" }), []);
	// Unknown keys are ignored, never an error: a lingering `mount` block from before sshfs support was removed keeps its entry valid.
	assert.deepEqual(validateTarget({ ...prod, mount: { remote: "/home/deploy/acme-site", local: "~/.pi/agent/mounts/acme-prod" } } as never), []);
	const parsed = parseTargetsFile(JSON.stringify({ version: 1, targets: [prod, prod, { name: "bad", kind: "ssh" }] }));
	assert.deepEqual(parsed.targets.map((t) => t.name), ["acme-prod"]);
	assert.deepEqual(parsed.invalid.map((i) => i.name), ["acme-prod", "bad"]);
	assert.throws(() => parseTargetsFile(`{"targets":[]}`));
});

test("placeholder cwd maps back to the remote path", () => {
	const root = placeholderRoot("/h/.pi/agent", "acme-prod");
	assert.equal(root, "/h/.pi/agent/pi-web/targets/acme-prod");
	assert.equal(placeholderDir("/h/.pi/agent", "acme-prod", "/home/deploy/x"), `${root}/home/deploy/x`);
	assert.equal(toRemotePath(`${root}/home/deploy/x`, root), "/home/deploy/x");
	assert.equal(toRemotePath(root, root), "/");
	assert.equal(placeholderDir("/h/.pi/agent", "acme-prod", "/../../x"), `${root}/x`, "cannot climb out of the root");
	assert.equal(placeholderDir("/h/.pi/agent", "acme-prod", "home/../../etc"), `${root}/etc`);
	assert.equal(toRemotePath(`${root}-other/x`, root), `${root}-other/x`);
	assert.equal(toRemotePath("/elsewhere", root), "/elsewhere");
});

test("hangupGuard: passes output and exit code through, and kills the whole far job when stdin closes", async () => {
	const { spawn } = await import("node:child_process");
	const { hangupGuard } = await import("./argv.ts");
	const ok = spawnSync("sh", ["-c", hangupGuard("echo out; echo err >&2; exit 7")], { encoding: "utf8", input: "" });
	// input "" closes stdin at once, so the watchdog may race a fast command; the result must still be whole or killed, never hung.
	assert.ok(ok.status === 7 || ok.status === 143, String(ok.status));
	const marker = `hangup-${process.pid}-${Date.now()}`;
	const held = spawn("sh", ["-c", hangupGuard(`echo started; sleep 30; echo ${marker}`)], { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	held.stdout.on("data", (d) => (out += d));
	await new Promise((r) => held.stdout.once("data", r));
	const t0 = Date.now();
	held.stdin.end(); // the channel closing
	const code = await new Promise((r) => held.on("close", r));
	assert.ok(Date.now() - t0 < 3000, "exits promptly");
	assert.equal(code, 143);
	assert.ok(!out.includes(marker));
	assert.equal(spawnSync("pgrep", ["-f", `echo ${marker}`]).status, 1, "no far process left behind");
	// With stdin held open until exit, a normal command is untouched.
	const normal = spawn("sh", ["-c", hangupGuard("echo out; exit 7")], { stdio: ["pipe", "pipe", "pipe"] });
	let nout = "";
	normal.stdout.on("data", (d) => (nout += d));
	normal.on("exit", () => normal.stdin.destroy());
	assert.equal(await new Promise((r) => normal.on("close", r)), 7);
	assert.equal(nout, "out\n");
});
