#!/usr/bin/env node
// claude-probe-inner.mjs — NOT a suite. The process the claude-* suites run INSIDE a confined launch.
//
//   node claude-probe-inner.mjs launcher <spec.json>   stands in for `claude`: reads the token fd the
//        way the CLI does (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), then launches itself as a child in
//        `mcp` mode over stdio (the way Claude starts an MCP server), runs the battery itself too, and
//        prints one JSON line {self, child}.
//   node claude-probe-inner.mjs mcp <spec.json>        the "MCP server" child: runs the battery only.
//
// The spec is a JSON FILE path (readable inside: the suite puts it in a writable root), never argv
// text, so no probe input shows in /proc/<pid>/cmdline either. Node builtins only; never throws: every
// check reports what happened ({ok, code}) and the host-side suite decides what that means.
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const [mode, specFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, "utf8"));

function tryWrite(file) {
	try {
		writeFileSync(file, "redteam");
		try { rmSync(file, { force: true }); } catch {}
		return { ok: true };
	} catch (e) {
		return { ok: false, code: e.code ?? String(e.message) };
	}
}
function tryRead(file) {
	try {
		const b = readFileSync(file);
		return { ok: true, bytes: b.length };
	} catch (e) {
		return { ok: false, code: e.code ?? String(e.message) };
	}
}
function tryList(dir) {
	try {
		return { ok: true, entries: readdirSync(dir).length };
	} catch (e) {
		return { ok: false, code: e.code ?? String(e.message) };
	}
}
function tryKill(pid) {
	try {
		process.kill(pid, 0);
		return { ok: true };
	} catch (e) {
		return { ok: false, code: e.code };
	}
}
function tryConnect(host, port, ms = 2500) {
	return new Promise((resolve) => {
		const s = net.connect({ host, port });
		const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
		s.setTimeout(ms);
		s.once("connect", () => done({ ok: true }));
		s.once("timeout", () => done({ ok: false, code: "TIMEOUT" }));
		s.once("error", (e) => done({ ok: false, code: e.code }));
	});
}
/** CONNECT through the sandbox's HTTPS_PROXY (the relay); the status line, or an error code. */
function proxyConnect(host, port = 443, ms = 8000) {
	const px = process.env.HTTPS_PROXY || process.env.https_proxy;
	if (!px) return Promise.resolve({ ok: false, code: "NO_PROXY_ENV" });
	const u = new URL(px);
	return new Promise((resolve) => {
		const s = net.connect({ host: u.hostname, port: Number(u.port) });
		let buf = "";
		const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
		s.setTimeout(ms);
		s.once("connect", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
		s.on("data", (d) => {
			buf += d.toString("latin1");
			const i = buf.indexOf("\r\n");
			if (i !== -1) done({ ok: true, status: Number(buf.slice(9, 12)), line: buf.slice(0, i) });
		});
		s.once("timeout", () => done({ ok: false, code: "TIMEOUT" }));
		s.once("error", (e) => done({ ok: false, code: e.code }));
	});
}
/** Every /proc/<pid>/{cmdline,environ} this process can read, searched for the token (never printed). */
function procTokenScan(token) {
	const out = { pids: 0, readable: 0, hits: [] };
	let pids = [];
	try { pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return out; }
	out.pids = pids.length;
	for (const pid of pids) {
		for (const f of ["cmdline", "environ"]) {
			try {
				const b = readFileSync(`/proc/${pid}/${f}`, "latin1");
				out.readable++;
				if (token && b.includes(token)) out.hits.push(`${pid}/${f}`);
			} catch {}
		}
	}
	return out;
}
/** Open fds beyond stdio, and whether any of them yields the token. */
function fdScan(token) {
	const fds = [];
	let list = [];
	try { list = readdirSync("/proc/self/fd"); } catch {}
	for (const fd of list.map(Number).filter((n) => n > 2)) {
		let target = "?";
		try { target = readlinkSync(`/proc/self/fd/${fd}`); } catch {}
		fds.push({ fd, target });
	}
	let leaked = false;
	// A pipe whose both ends sit in this process is node's own (libuv wakeup/signal pipes): reading it
	// would eat the event loop's wakeups. Only a lone read end can have come from outside.
	const count = new Map();
	for (const { target } of fds) count.set(target, (count.get(target) ?? 0) + 1);
	if (token) {
		for (const { fd, target } of fds) {
			if (target.startsWith("pipe:") && count.get(target) > 1) continue;
			// Pipes and plain files only (never a socket or a tty), reopened non-blocking so an empty pipe
			// answers EAGAIN instead of hanging the probe.
			if (!/^pipe:|^\/|^\/memfd:/.test(target) || target.startsWith("/proc") || target.startsWith("/dev")) continue;
			try {
				const b = Buffer.alloc(4096);
				const fh = openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
				const n = readSync(fh, b, 0, b.length, null);
				closeSync(fh);
				if (b.subarray(0, n).toString("latin1").includes(token)) leaked = true;
			} catch {}
		}
	}
	return { fds, leaked };
}

async function battery() {
	const r = { pid: process.pid, ppid: process.ppid, mntns: safe(() => readlinkSync("/proc/self/ns/mnt")), netns: safe(() => readlinkSync("/proc/self/ns/net")) };
	r.writes = {};
	for (const [name, file] of Object.entries(spec.writeTargets ?? {})) r.writes[name] = tryWrite(file);
	r.reads = {};
	for (const [name, file] of Object.entries(spec.readTargets ?? {})) r.reads[name] = tryRead(file);
	r.lists = {};
	for (const [name, dir] of Object.entries(spec.listTargets ?? {})) r.lists[name] = tryList(dir);
	r.kill = spec.sentinelPid ? tryKill(spec.sentinelPid) : null;
	r.procSentinel = spec.sentinelPid ? existsSync(`/proc/${spec.sentinelPid}`) : null;
	r.ports = {};
	for (const p of spec.ports ?? []) r.ports[p] = await tryConnect("127.0.0.1", p);
	r.envKeys = Object.keys(process.env).sort();
	r.envHasToken = !!spec.token && Object.values(process.env).some((v) => v.includes(spec.token));
	r.proc = procTokenScan(spec.token);
	r.fd = fdScan(spec.token);
	r.proxy = {};
	for (const h of spec.proxyHosts ?? []) r.proxy[h] = await proxyConnect(h);
	return r;
}
function safe(f) {
	try { return f(); } catch (e) { return `ERR ${e.code ?? e.message}`; }
}

/** The CLI's documented fd handover: read the token from the named fd (and close it), like claude does. */
function readTokenFd() {
	const v = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
	if (!v) return { present: false };
	const fd = Number(v);
	try {
		const chunks = [];
		const b = Buffer.alloc(4096);
		for (;;) {
			const n = readSync(fd, b, 0, b.length, null);
			if (n <= 0) break;
			chunks.push(Buffer.from(b.subarray(0, n)));
		}
		try { closeSync(fd); } catch {}
		const text = Buffer.concat(chunks).toString("utf8").trim();
		return { present: true, fd, matches: !!spec.token && text === spec.token, length: text.length };
	} catch (e) {
		return { present: true, fd, error: e.code ?? e.message };
	}
}

/** With `spec.hold`, stay alive until stdin ends, so the suite can scan /proc from outside meanwhile. */
const held = () => (spec.hold ? new Promise((r) => { process.stdin.on("end", r).on("error", r).resume(); }) : Promise.resolve());

if (mode === "mcp") {
	process.stdout.write(`${JSON.stringify(await battery())}\n`);
	await held();
} else {
	const tokenFd = readTokenFd();
	const self = await battery();
	let childProc;
	const child = await new Promise((resolve) => {
		const c = (childProc = spawn(process.execPath, [path.resolve(process.argv[1]), "mcp", specFile], { stdio: ["pipe", "pipe", "pipe"] }));
		let out = "";
		let err = "";
		const tryLine = () => {
			const i = out.indexOf("\n");
			if (i === -1) return;
			try { resolve({ pid: c.pid, ...JSON.parse(out.slice(0, i)) }); } catch { resolve({ bad: out.slice(0, 400) }); }
		};
		c.stdout.on("data", (d) => { out += d; tryLine(); });
		c.stderr.on("data", (d) => (err += d));
		c.on("error", (e) => resolve({ spawnError: String(e) }));
		c.on("close", (code) => resolve({ code, out: out.slice(0, 400), err: err.slice(0, 400) }));
		if (!spec.hold) c.stdin.end();
	});
	process.stdout.write(`${JSON.stringify({ tokenFd, self, child })}\n`);
	await held();
	try { childProc.stdin.end(); } catch {}
}
