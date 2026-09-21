/**
 * sshfs mounts of remote targets: the ONE implementation, imported by the extension (index.ts) and
 * by pi-web's server (which exposes the toggle and opens sessions inside the mount). Node builtins
 * only (argv.ts, exec.ts), like argv.ts: this file is imported by the server, so it must stay
 * pi-runtime-free.
 *
 * Event-loop safety is the design constraint — the caller may be pi-web's server:
 *  - `isMounted`/`mountEntryAt` read `/proc/mounts` (a kernel text file): never a `stat` on a
 *    possibly-hung fuse path, which would block the loop for good;
 *  - `verifyMounted` reads THROUGH the mount only via `fs/promises` (a hung fuse path blocks one
 *    threadpool thread, never the loop) and only inside a timeout race;
 *  - every mount this module builds carries `reconnect` + `ServerAlive*` (SSHFS_MOUNT_OPTIONS):
 *    without them a dead host turns any later `stat` on the mount into an event-loop freeze.
 *    mountArgv is the only place a mount command line is built, and mount.test.ts asserts every
 *    option is present — that test is the regression that protects the event loop.
 *
 * Measured, live, on a real fuse mount: plain `fusermount3 -u` fails EBUSY when any local process
 * holds an fd through the mount (a Playwright run with an open `<mount>/node_modules`); the lazy
 * fallback (`-u -z`) detaches it and the mount leaves the table at once. Reports never guess: what
 * went away is what `/proc/mounts` says, not what an exit code implies.
 *
 * sshfs facts this builds on (verified against sshfs 3.7.6 / fuse3 3.18.2, mounted over a local ssh):
 *  - the parent process exits 0 once the mount is established, non-zero with ssh's line in stderr
 *    when it isn't (a missing far folder fails here — it never becomes a mount);
 *  - `-i` is not an sshfs option: identity travels as `-o IdentityFile=…`;
 *  - `/proc/mounts` shows the source as exactly the `user@host:/path` operand and the type as
 *    `fuse.sshfs` — that is what "already mounted by us" is matched against.
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { awsSsmProxyCommand, type Target, type TargetMount } from "./argv.ts";
import { type RunOptions, type RunResult, runArgv } from "./exec.ts";

export type { TargetMount };

// ---------------------------------------------------------------------------
// the measured-safe mount options

/**
 * The one `-o` value every mount gets. `reconnect` + `ServerAliveInterval/CountMax` are
 * non-negotiable: they are what makes a dead host an error instead of an event-loop freeze; the
 * cache/timeout options are the measured-safe speed set. Asserted option-by-option in mount.test.ts.
 */
export const SSHFS_MOUNT_OPTIONS =
	"reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,idmap=user,follow_symlinks,cache=yes,kernel_cache,dir_cache=yes,entry_timeout=10,attr_timeout=10";

/** sshfs answers a working mount in milliseconds; a hung or dead one never does. */
export const VERIFY_TIMEOUT_MS = 10_000;
/** Plain `fusermount3 -u` attempts (EBUSY is often a transient holder) before the lazy fallback. */
export const UNMOUNT_ATTEMPTS = 3;
/** Sleep between plain unmount attempts. */
export const UNMOUNT_RETRY_MS = 500;
/** Bound on the sshfs spawn itself (ssh's ConnectTimeout is 10; this covers the mount setup). */
const MOUNT_TIMEOUT_MS = 30_000;
/** Bound on one fusermount3 run. */
const FUSERMOUNT_TIMEOUT_MS = 10_000;
const MOUNTS_FILE = "/proc/mounts";

// ---------------------------------------------------------------------------
// the mount table

export interface MountEntry {
	/** The device column: for sshfs, exactly the `user@host:/path` operand. */
	source: string;
	/** The mount point, unescaped. */
	point: string;
	fstype: string;
	options: string;
}

/** Octal escapes in /proc/mounts fields: \040 space, \011 tab, \012 newline, \134 backslash. */
function unescapeField(s: string): string {
	return s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Parse /proc/mounts text into entries; short/blank lines are skipped. */
export function parseMountTable(text: string): MountEntry[] {
	const out: MountEntry[] = [];
	for (const line of text.split("\n")) {
		const f = line.trim().split(/\s+/);
		if (f.length < 4) continue;
		out.push({ source: unescapeField(f[0]!), point: unescapeField(f[1]!), fstype: f[2]!, options: f[3]! });
	}
	return out;
}

/** The mount table; "" when unreadable (non-Linux). Never throws. */
function mountTableText(): string {
	try {
		return readFileSync(MOUNTS_FILE, "utf8");
	} catch {
		return "";
	}
}

/** The entry mounted exactly at localPath (a mount below it is not it); `text` overrides the table (tests). */
export function mountEntryAt(localPath: string, text?: string): MountEntry | undefined {
	const want = resolve(localPath);
	return parseMountTable(text ?? mountTableText()).find((e) => resolve(e.point) === want);
}

/**
 * Whether a real mount sits exactly at localPath — a mount-table lookup, never a stat of the fuse
 * path (a hung mount would block the caller's event loop).
 */
export function isMounted(localPath: string): boolean {
	return mountEntryAt(localPath) !== undefined;
}

// ---------------------------------------------------------------------------
// paths

function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** The far mount root, normalized as an absolute path with no trailing slash (posix.normalize keeps one). */
function farRoot(p: string): string {
	const n = posix.normalize(p.startsWith("/") ? p : `/${p}`);
	return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * The target's resolved local mount point (`~/…` expanded); undefined when the entry has no mount
 * config, or `local` isn't an absolute path after expansion (validateTarget rejects that, so this
 * only guards unvalidated input).
 */
export function mountPointOf(target: Target): string | undefined {
	if (!target.mount) return undefined;
	const p = expandHome(target.mount.local);
	return p.startsWith("/") ? p : undefined;
}

/**
 * The local path (inside the mount) of a far path: mount.local + the part under mount.remote.
 * Null when remotePath isn't under mount.remote. This is how a mounted session's cwd is derived.
 */
export function toMountLocal(m: TargetMount, remotePath: string): string | null {
	const mp = expandHome(m.local);
	const root = farRoot(m.remote);
	const rp = farRoot(remotePath);
	if (rp !== root && !rp.startsWith(root + "/")) return null;
	return rp === root ? mp : join(mp, ...rp.slice(root.length + 1).split("/"));
}

/**
 * The far path of a local path inside the mount: mount.remote + the part under mount.local.
 * Null when localPath isn't under the mount point. Lexical only (no symlink resolution: a stat
 * under a hung mount blocks).
 */
export function toMountRemote(m: TargetMount, localPath: string): string | null {
	const mp = expandHome(m.local);
	const lp = resolve(localPath);
	if (lp !== mp && !lp.startsWith(mp + sep)) return null;
	return lp === mp ? farRoot(m.remote) : posix.join(farRoot(m.remote), lp.slice(mp.length + sep.length).split(sep).join("/"));
}

// ---------------------------------------------------------------------------
// argv

/** The `user@host:/path` operand of the mount — also exactly the source /proc/mounts reports. */
export function mountSpec(target: Target): string {
	if (!target.mount) throw new Error(`target ${target.name}: no mount config`);
	const s = target.ssh;
	if (!s)
		throw new Error(
			`target ${target.name}: mounts need the target's own ssh block` +
				(target.via ? ` (it is reached via ${target.via})` : target.kind === "docker" ? " (it runs in a container)" : target.kind === "incus-cell" ? " (it runs in an incus cell)" : ""),
		);
	return `${s.user ? `${s.user}@` : ""}${s.host}:${farRoot(target.mount.remote)}`;
}

/**
 * Spawn argv for `sshfs` mounting the target's mount.remote at localPath. Never spawns by itself.
 *
 * Option order matters: ssh takes the FIRST value of an option, so BatchMode (ours) can't be
 * overridden by an entry option and the measured-safe SSHFS_MOUNT_OPTIONS win over any entry
 * ServerAlive* — a mount that loses reconnect/ServerAlive is an event-loop hazard, not a
 * preference. Entry options still add new ones (StrictHostKeyChecking, …); Control* are dropped
 * (the mount owns one connection, and `reconnect` is what re-establishes it); the port and identity
 * come from the ssh block (`-o IdentityFile=`: sshfs has no `-i`).
 */
export function mountArgv(target: Target, localPath: string): string[] {
	const spec = mountSpec(target); // throws the clean no-mount / no-ssh-block errors
	const s = target.ssh!;
	const argv = ["sshfs", "-o", "BatchMode=yes", "-o", SSHFS_MOUNT_OPTIONS];
	for (const o of s.options ?? []) {
		if (/^(Control(Master|Path|Persist)|ProxyCommand)[= ]/i.test(o)) continue;
		argv.push("-o", o);
	}
	if (target.proxy) argv.push("-o", `ProxyCommand=${awsSsmProxyCommand(target.proxy, s.key)}`);
	argv.push("-o", "ConnectTimeout=10");
	if (s.port) argv.push("-p", String(s.port));
	if (s.key) argv.push("-o", `IdentityFile=${expandHome(s.key)}`);
	argv.push(spec, resolve(localPath));
	return argv;
}

// ---------------------------------------------------------------------------
// results

export interface MountReport {
	/** Mounted AND verified: safe to hand out sessions inside it. */
	ok: boolean;
	/** A mount sits at mountPoint right now (whoever made it). */
	mounted: boolean;
	/** A mount was already there; sshfs was not spawned. */
	already: boolean;
	/** The resolved local mount point. */
	mountPoint: string;
	/** The far path that is (to be) mounted. */
	remote: string;
	/** First line of the failure, when !ok. */
	error?: string;
}

export interface UnmountReport {
	/** The mount is really gone from the mount table (the table decides, never a stat). */
	ok: boolean;
	/** A mount is still at localPath. */
	mounted: boolean;
	/** There was nothing to unmount. */
	already: boolean;
	/** How it went away: a plain fusermount3 -u, or the lazy fallback after EBUSY. */
	how?: "fusermount" | "lazy";
	/** First line of the failure, when !ok. */
	error?: string;
}

export interface VerifyResult {
	/** A bounded read through the mount answered. */
	ok: boolean;
	/** Why not: no mount / not inside it / far folder missing / no answer within the bound (hung). */
	error?: string;
}

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface MountDeps {
	/** Spawn (default exec.ts runArgv); tests swap in a fake sshfs/fusermount3. */
	exec?: (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;
	/** Sleep between plain unmount retries (default setTimeout). */
	sleep?: (ms: number) => Promise<void>;
	/** One read through the mount (default fs/promises readdir). */
	readdir?: (path: string) => Promise<string[]>;
	/** The mount table text (default /proc/mounts); tests supply a fake. */
	mounts?: () => string;
	/** verifyMounted's bound (default VERIFY_TIMEOUT_MS). */
	verifyTimeoutMs?: number;
}

const line1 = (s: string) => s.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

// ---------------------------------------------------------------------------
// mount / unmount / verify

/**
 * Mount the target's mount.remote at its configured mount point. Idempotent: a mount that is
 * already there and answers is verified and reported ok without spawning sshfs; a mount point in
 * use by anything else is reported, never adopted. Never throws — every failure lands in
 * MountReport.error with ok:false, so the server can map it to an HTTP error as-is.
 */
export async function mount(target: Target, deps: MountDeps = {}): Promise<MountReport> {
	const cfg = target.mount;
	const mp = mountPointOf(target);
	const report = (mounted: boolean, already: boolean, error?: string): MountReport => ({
		ok: false,
		mounted,
		already,
		mountPoint: mp ?? String(cfg?.local ?? ""),
		remote: cfg ? farRoot(cfg.remote) : "",
		...(error ? { error } : {}),
	});
	if (!cfg) return report(false, false, `target ${target.name}: no mount config`);
	if (!mp) return report(false, false, `mount.local must be ~/… or an absolute path: ${cfg.local}`);
	let expected: string;
	try {
		expected = mountSpec(target);
	} catch (e) {
		return report(false, false, (e as Error).message);
	}
	const entryAt = () => mountEntryAt(mp, deps.mounts ? deps.mounts() : undefined);
	const exec = deps.exec ?? runArgv;

	const entry = entryAt();
	if (entry) {
		if (entry.source !== expected || !entry.fstype.startsWith("fuse"))
			return report(true, true, `${mp} is already a mount (${entry.source} on ${entry.fstype}), not this target's ${expected} — unmount it or change mount.local`);
		const v = await verifyMounted(target, mp, deps);
		if (!v.ok) return report(true, true, v.error);
		return { ok: true, mounted: true, already: true, mountPoint: mp, remote: farRoot(cfg.remote) };
	}

	// Not mounted: create the mount point (a plain local dir), spawn sshfs (bounded), then let the
	// mount table and a read through the mount decide whether anything actually worked.
	try {
		await mkdir(mp, { recursive: true });
	} catch (e) {
		return report(false, false, `cannot create the mount point ${mp}: ${(e as Error).message}`);
	}
	let argv: string[];
	try {
		argv = mountArgv(target, mp);
	} catch (e) {
		return report(false, false, (e as Error).message);
	}
	let r: RunResult;
	try {
		r = await exec(argv, { timeoutMs: MOUNT_TIMEOUT_MS });
	} catch (e) {
		return report(false, false, `${argv[0]}: ${(e as Error).message}`);
	}
	const now = entryAt();
	if (!now)
		return report(false, false, r.exitCode === 0 ? `sshfs exited 0 but no mount appeared at ${mp}` : line1(r.stderr) || `sshfs exited with code ${r.exitCode}`);
	if (now.source !== expected || !now.fstype.startsWith("fuse"))
		return report(true, false, `${mp} was mounted by something else (${now.source} on ${now.fstype}) instead of ${expected}`);
	const v = await verifyMounted(target, mp, deps);
	if (!v.ok) return report(true, false, v.error);
	return { ok: true, mounted: true, already: false, mountPoint: mp, remote: farRoot(cfg.remote) };
}

/**
 * Unmount whatever sits at localPath. Nothing there → ok (safe to call twice). Plain
 * `fusermount3 -u` first (it ends the sshfs process and connection cleanly), UNMOUNT_ATTEMPTS
 * tries for the EBUSY case, then the lazy fallback `-u -z` (measured: a local process holding an
 * fd through the mount — e.g. an open node_modules — makes plain -u busy and lazy succeed; new
 * opens then see the plain directory while the holder keeps its far fds). What the report says is
 * what the mount table says. A non-fuse mount at the point is refused, not unmounted.
 */
export async function unmount(localPath: string, deps: MountDeps = {}): Promise<UnmountReport> {
	const p = resolve(localPath);
	const exec = deps.exec ?? runArgv;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r2) => setTimeout(r2, ms)));
	const entryAt = () => mountEntryAt(p, deps.mounts ? deps.mounts() : undefined);
	const entry = entryAt();
	if (!entry) return { ok: true, mounted: false, already: true };
	if (!entry.fstype.startsWith("fuse")) return { ok: false, mounted: true, already: false, error: `${p} is not a fuse mount (${entry.fstype}); refusing to unmount it` };

	const run = async (argv: string[]): Promise<RunResult> => {
		try {
			return await exec(argv, { timeoutMs: FUSERMOUNT_TIMEOUT_MS });
		} catch (e) {
			return { code: null, exitCode: null, stdout: Buffer.alloc(0), stderr: (e as Error).message, timedOut: false, aborted: false };
		}
	};
	let lastError = "";
	for (let i = 0; i < UNMOUNT_ATTEMPTS; i++) {
		if (i) await sleep(UNMOUNT_RETRY_MS);
		const r = await run(["fusermount3", "-u", p]);
		if (!entryAt()) return { ok: true, mounted: false, already: false, how: "fusermount" };
		if (r.exitCode !== 0) lastError = line1(r.stderr) || `fusermount3 exited with code ${r.exitCode}`;
	}
	const z = await run(["fusermount3", "-u", "-z", p]);
	if (!entryAt()) return { ok: true, mounted: false, already: false, how: "lazy" };
	return { ok: false, mounted: true, already: false, error: line1(z.stderr) || lastError || "the mount did not go away" };
}

const VERIFY_TIMED_OUT = "pi-mount-verify-timeout";

/**
 * Prove the mount works by reading THROUGH it: one readdir of localPath (which may be the mount
 * point itself or any directory inside it — the server verifies a session cwd here), bounded by a
 * timeout race, so a mount that exists but does not answer (hung fuse, dead host) is not success.
 * The read runs on fs/promises: a hung mount blocks one threadpool thread, never the event loop.
 */
export async function verifyMounted(target: Target, localPath: string, deps: MountDeps = {}): Promise<VerifyResult> {
	const cfg = target.mount;
	if (!cfg) return { ok: false, error: `target ${target.name}: no mount config` };
	const mp = mountPointOf(target);
	if (!mp) return { ok: false, error: `mount.local must be ~/… or an absolute path: ${cfg.local}` };
	if (mountEntryAt(mp, deps.mounts ? deps.mounts() : undefined) === undefined) return { ok: false, error: `no mount at ${mp}` };
	if (toMountRemote(cfg, localPath) === null) return { ok: false, error: `${localPath} is not inside the mount at ${mp}` };
	const timeoutMs = deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			(deps.readdir ?? readdir)(localPath),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(VERIFY_TIMED_OUT)), timeoutMs);
				timer.unref?.();
			}),
		]);
		return { ok: true };
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.message === VERIFY_TIMED_OUT)
			return { ok: false, error: `no answer within ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}: the mount at ${mp} is hung` };
		if (err.code === "ENOENT") return { ok: false, error: `no such directory through the mount: ${localPath}` };
		if (err.code === "EACCES") return { ok: false, error: `not readable through the mount: ${localPath}` };
		return { ok: false, error: err.message || String(e) };
	} finally {
		if (timer) clearTimeout(timer);
	}
}