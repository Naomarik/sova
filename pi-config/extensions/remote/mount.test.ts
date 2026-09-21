/**
 * mount.ts without a network: the argv it builds (the regression that protects the event loop —
 * every measured-safe option present), the mount-table lookup, mount/unmount reporting through a
 * fake sshfs/fusermount3, and verifyMounted's bounded read. Where it can, the REAL /proc/mounts is
 * used; everything else runs against a fake table via MountDeps.
 *
 *   npx tsx --test pi-config/extensions/remote/mount.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type MountDeps,
	type MountReport,
	mount,
	mountArgv,
	mountEntryAt,
	mountPointOf,
	SSHFS_MOUNT_OPTIONS,
	parseMountTable,
	isMounted,
	toMountLocal,
	toMountRemote,
	UNMOUNT_ATTEMPTS,
	UNMOUNT_RETRY_MS,
	unmount,
	verifyMounted,
} from "./mount.ts";
import type { RunResult } from "./exec.ts";
import type { Target as TargetType } from "./argv.ts";

const mp = () => mkdtempSync(join(tmpdir(), "pi-mount-mp-"));
const target = (local: string, remote = "/srv/app"): TargetType => ({
	name: "t",
	kind: "ssh",
	ssh: { user: "deploy", host: "example.test" },
	mount: { remote, local },
});
const entry = (source: string, point: string, fstype = "fuse.sshfs") =>
	`${source} ${point} ${fstype} rw,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0`;
const res = (code: number, stderr = ""): RunResult => ({ code, exitCode: code, stdout: Buffer.alloc(0), stderr, timedOut: false, aborted: false });
const clean = (p: string) => rmSync(p, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// mountArgv — the event-loop regression

test("mountArgv: the measured-safe options exactly, plus the connection and the operands", () => {
	const t: TargetType = {
		name: "prod",
		kind: "ssh",
		ssh: { user: "deploy", host: "example.test", port: 2222, key: "~/.ssh/id_rsa", options: ["StrictHostKeyChecking=accept-new", "ControlMaster=auto", "ControlPersist=10m"] },
		mount: { remote: "/srv/app/", local: "~/remote/prod" },
	};
	const argv = mountArgv(t, "/home/me/remote/prod");
	assert.equal(argv[0], "sshfs");
	const opts = argv.flatMap((w, i) => (argv[i - 1] === "-o" ? [w] : []));
	// THE regression: the measured-safe set, exact and complete. A mount without reconnect and
	// ServerAlive turns a dead host into an event-loop freeze on the next stat of the mount.
	assert.ok(opts.includes(SSHFS_MOUNT_OPTIONS), `options: ${opts.join(" | ")}`);
	assert.deepEqual(SSHFS_MOUNT_OPTIONS.split(","), [
		"reconnect",
		"ServerAliveInterval=15",
		"ServerAliveCountMax=3",
		"idmap=user",
		"follow_symlinks",
		"cache=yes",
		"kernel_cache",
		"dir_cache=yes",
		"entry_timeout=10",
		"attr_timeout=10",
	]);
	assert.ok(opts.includes("BatchMode=yes"), "no interactive prompt can hang the mount");
	assert.ok(opts.includes("ConnectTimeout=10"), "bounded connection");
	assert.ok(opts.includes(`IdentityFile=${join(homedir(), ".ssh/id_rsa")}`), "identity via -o (sshfs has no -i)");
	assert.ok(opts.includes("StrictHostKeyChecking=accept-new"), "entry options ride along");
	assert.ok(!opts.some((o) => /^Control(Master|Path|Persist)=/.test(o)), "Control* never ride a mount");
	assert.equal(argv[argv.indexOf("-p") + 1], "2222");
	assert.deepEqual(argv.slice(-2), ["deploy@example.test:/srv/app", "/home/me/remote/prod"], "the remote operand (normalized) and the local mount point, last");
});

test("mountArgv: an aws-ssm proxy rides along; targets sshfs cannot carry are refused", () => {
	const t: TargetType = { name: "ec2", kind: "ssh", ssh: { host: "i-0abc", key: "~/.ssh/k" }, proxy: { type: "aws-ssm", profile: "p" }, mount: { remote: "/srv", local: "~/m" } };
	const argv = mountArgv(t, "/m");
	assert.ok(
		argv.flatMap((w, i) => (argv[i - 1] === "-o" ? [w] : [])).some((o) => o.startsWith("ProxyCommand=") && o.includes("start-session")),
		"the aws-ssm proxy command",
	);
	assert.throws(() => mountArgv({ name: "d", kind: "docker", docker: { container: "web" }, mount: { remote: "/srv", local: "~/m" } } as TargetType, "/m"), /container/);
	assert.throws(() => mountArgv({ name: "v", kind: "ssh", via: "host", mount: { remote: "/srv", local: "~/m" } } as TargetType, "/m"), /via/);
	assert.throws(() => mountArgv({ name: "n", kind: "ssh", ssh: { host: "h" } } as TargetType, "/m"), /no mount config/);
});

// ---------------------------------------------------------------------------
// the mount table

test("isMounted: a real mount-table entry vs a plain directory (the real /proc/mounts)", () => {
	let table: string;
	try {
		table = readFileSync("/proc/mounts", "utf8");
	} catch {
		return; // not Linux; the synthetic cases below cover the parsing
	}
	const real = parseMountTable(table).find((e) => e.point === "/") ?? parseMountTable(table)[0]!;
	assert.ok(isMounted(real.point), `the table's own entry: ${real.point}`);
	const plain = mp();
	try {
		assert.equal(isMounted(plain), false);
		assert.equal(mountEntryAt(plain), undefined);
	} finally {
		clean(plain);
	}
});

test("parseMountTable/mountEntryAt: octal escapes, exact points, short lines skipped", () => {
	const text = ["proc /proc proc rw,nosuid 0 0", "deploy@example.test:/srv\\040app /mnt/with\\040space\\011tab fuse.sshfs rw 0 0", "a b c"].join("\n");
	assert.equal(parseMountTable(text).length, 2, "the short line is skipped");
	assert.equal(mountEntryAt("/proc", text)?.fstype, "proc");
	assert.equal(mountEntryAt("/mnt/with space\ttab", text)?.source, "deploy@example.test:/srv app", "field escapes decoded");
	assert.equal(mountEntryAt("/proc/sub", text), undefined, "a mount below a mount point is not the mount point");
});

// ---------------------------------------------------------------------------
// paths

test("mountPointOf/toMountLocal/toMountRemote: the mapping and its edges", () => {
	const m = { remote: "/srv/app/", local: "~/remote/prod" };
	const p = join(homedir(), "remote", "prod");
	assert.equal(mountPointOf(target("~/remote/prod")), p, "~/… expanded");
	assert.equal(mountPointOf({ name: "t", kind: "ssh", ssh: { host: "h" } } as TargetType), undefined, "no mount config");
	assert.equal(mountPointOf(target("relative")), undefined, "not absolute after expansion");
	assert.equal(toMountLocal(m, "/srv/app"), p, "the root maps to the mount point");
	assert.equal(toMountLocal(m, "/srv/app/sub/f.txt"), join(p, "sub", "f.txt"));
	assert.equal(toMountLocal(m, "/srv/appx"), null, "prefix match is not a path match");
	assert.equal(toMountLocal(m, "/etc"), null);
	assert.equal(toMountRemote(m, p), "/srv/app", "remote normalized");
	assert.equal(toMountRemote(m, join(p, "sub/f.txt")), "/srv/app/sub/f.txt");
	assert.equal(toMountRemote(m, join(p, "..")), null, "climbed out of the mount point");
	assert.equal(toMountRemote(m, "/etc"), null);
});

// ---------------------------------------------------------------------------
// mount()

test("mount: idempotent — our mount already there is verified, sshfs never spawned", async () => {
	const p = mp();
	try {
		const deps: MountDeps = {
			mounts: () => entry("deploy@example.test:/srv/app", p),
			exec: async () => {
				throw new Error("must not spawn sshfs");
			},
			readdir: async () => ["f.txt"],
		};
		const rep: MountReport = await mount(target(p), deps);
		assert.deepEqual(rep, { ok: true, mounted: true, already: true, mountPoint: p, remote: "/srv/app" });
		// …but one that does not answer is NOT ok, even though it is mounted:
		const hung = await mount(target(p), { ...deps, readdir: () => new Promise(() => {}), verifyTimeoutMs: 20 });
		assert.deepEqual([hung.ok, hung.mounted, hung.already], [false, true, true]);
		assert.match(hung.error!, /no answer within 20ms/);
	} finally {
		clean(p);
	}
});

test("mount: a mount point in use by anything else is reported, never adopted", async () => {
	const p = mp();
	try {
		const foreign = await mount(target(p), {
			mounts: () => entry("/dev/sda1", p, "ext4"),
			readdir: async () => {
				throw new Error("must not read through a foreign fs");
			},
		});
		assert.deepEqual([foreign.ok, foreign.mounted, foreign.already], [false, true, true]);
		assert.match(foreign.error!, /already a mount/);
		const other = await mount(target(p), { mounts: () => entry("other@example.test:/other", p), readdir: async () => [] });
		assert.deepEqual([other.ok, other.mounted], [false, true]);
		assert.match(other.error!, /other@example.test:\/other/);
	} finally {
		clean(p);
	}
});

test("mount: not mounted → spawns the one argv, then verifies through the mount", async () => {
	const parent = mkdtempSync(join(tmpdir(), "pi-mount-parent-"));
	const p = join(parent, "mp"); // does not exist yet
	try {
		let up = false;
		let read = "";
		const argvs: string[][] = [];
		const rep = await mount(target(p), {
			mounts: () => (up ? entry("deploy@example.test:/srv/app", p) : ""),
			exec: async (argv) => {
				argvs.push([...argv]);
				up = true;
				return res(0);
			},
			readdir: async (dir) => {
				read = dir;
				return [];
			},
		});
		assert.deepEqual(rep, { ok: true, mounted: true, already: false, mountPoint: p, remote: "/srv/app" });
		assert.ok(existsSync(p), "the mount point was created");
		assert.equal(argvs.length, 1);
		assert.deepEqual(argvs[0], mountArgv(target(p), p), "the spawn is exactly the one builder's argv");
		assert.equal(read, p, "verified by reading through the mount");
	} finally {
		clean(parent);
	}
});

test("mount: real failures are reported, never claimed as success", async () => {
	const parent = mkdtempSync(join(tmpdir(), "pi-mount-parent-"));
	const p = join(parent, "mp");
	try {
		const t = target(p);
		let spawned: string[] | undefined;
		const bad = await mount(t, {
			mounts: () => "",
			exec: async (argv) => {
				spawned = [...argv];
				return res(1, "ssh: connect to host example.test port 22: Connection refused\n");
			},
		});
		assert.deepEqual([bad.ok, bad.mounted, bad.already], [false, false, false]);
		assert.equal(bad.error, "ssh: connect to host example.test port 22: Connection refused");
		assert.equal(spawned![0], "sshfs");
		const weird = await mount(t, { mounts: () => "", exec: async () => res(0) });
		assert.equal(weird.ok, false);
		assert.match(weird.error!, /no mount appeared/);
		const noBinary = await mount(t, { mounts: () => "", exec: async () => { throw new Error("spawn sshfs ENOENT"); } });
		assert.equal(noBinary.ok, false);
		assert.match(noBinary.error!, /sshfs ENOENT/);
	} finally {
		clean(parent);
	}
});

test("mount: shape problems are reported, not thrown", async () => {
	const noMount = await mount({ name: "t", kind: "ssh", ssh: { host: "h" } } as TargetType);
	assert.deepEqual([noMount.ok, noMount.mounted], [false, false]);
	assert.match(noMount.error!, /no mount config/);
	const noSsh = await mount({ name: "t", kind: "docker", docker: { container: "w" }, mount: { remote: "/r", local: "~/m" } } as TargetType);
	assert.equal(noSsh.ok, false);
	assert.match(noSsh.error!, /ssh block/);
	const relLocal = await mount({ name: "t", kind: "ssh", ssh: { host: "h" }, mount: { remote: "/r", local: "relative" } } as TargetType);
	assert.match(relLocal.error!, /mount.local must be/);
});

// ---------------------------------------------------------------------------
// unmount()

test("unmount: nothing there → ok without spawning; a non-fuse mount is refused", async () => {
	let spawns = 0;
	const exec: MountDeps["exec"] = async () => {
		spawns++;
		return res(0);
	};
	const none = await unmount(join(tmpdir(), "pi-mount-nothing-xyz"), { mounts: () => "", exec });
	assert.deepEqual(none, { ok: true, mounted: false, already: true }, "safe to call twice");
	const p = mp();
	try {
		const refused = await unmount(p, { mounts: () => entry("/dev/sda1", p, "ext4"), exec });
		assert.deepEqual([refused.ok, refused.mounted], [false, true]);
		assert.match(refused.error!, /not a fuse mount/);
	} finally {
		clean(p);
	}
	assert.equal(spawns, 0, "no spawn in either case");
});

test("unmount: clean first try, running exactly fusermount3 -u", async () => {
	const p = mp();
	try {
		let gone = false;
		const argvs: string[][] = [];
		const rep = await unmount(p, {
			mounts: () => (gone ? "" : entry("deploy@example.test:/srv/app", p)),
			exec: async (argv) => {
				argvs.push([...argv]);
				gone = true;
				return res(0);
			},
		});
		assert.deepEqual(rep, { ok: true, mounted: false, already: false, how: "fusermount" }, "the table says it is gone");
		assert.deepEqual(argvs, [["fusermount3", "-u", p]]);
	} finally {
		clean(p);
	}
});

test("unmount: EBUSY → bounded plain retries → the lazy fallback, reported honestly", async () => {
	const p = mp();
	try {
		const argvs: string[][] = [];
		const sleeps: number[] = [];
		let lazy = false;
		const rep = await unmount(p, {
			mounts: () => (lazy ? "" : entry("deploy@example.test:/srv/app", p)),
			exec: async (argv) => {
				argvs.push([...argv]);
				if (argv[2] === "-z") {
					lazy = true;
					return res(0);
				}
				return res(1, `fusermount3: failed to unmount ${p}: Device or resource busy\n`);
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		// The measured reality: a local process holding an fd through the mount makes plain -u
		// busy; only the lazy unmount succeeds, and the mount really leaves the table.
		assert.deepEqual(rep, { ok: true, mounted: false, already: false, how: "lazy" });
		assert.equal(argvs.filter((a) => a.join(" ") === `fusermount3 -u ${p}`).length, UNMOUNT_ATTEMPTS, "bounded plain retries");
		assert.deepEqual(argvs[argvs.length - 1], ["fusermount3", "-u", "-z", p], "then the lazy fallback");
		assert.deepEqual(sleeps, Array(UNMOUNT_ATTEMPTS - 1).fill(UNMOUNT_RETRY_MS));
	} finally {
		clean(p);
	}
});

test("unmount: nothing works → still mounted, with the real error", async () => {
	const p = mp();
	try {
		const rep = await unmount(p, {
			mounts: () => entry("deploy@example.test:/srv/app", p),
			exec: async () => res(1, `fusermount3: failed to unmount ${p}: Device or resource busy\n`),
			sleep: async () => {},
		});
		assert.deepEqual(rep, {
			ok: false,
			mounted: true,
			already: false,
			error: `fusermount3: failed to unmount ${p}: Device or resource busy`,
		}, "a busy mount is never reported as unmounted");
	} finally {
		clean(p);
	}
});

// ---------------------------------------------------------------------------
// verifyMounted()

test("verifyMounted: ok when a bounded read answers; the reason when it doesn't", async () => {
	const p = mp();
	try {
		const t = target(p);
		const up: MountDeps = { mounts: () => entry("deploy@example.test:/srv/app", p), readdir: async () => ["f.txt"] };
		assert.deepEqual(await verifyMounted(t, p, up), { ok: true });
		assert.deepEqual(await verifyMounted(t, join(p, "sub"), { ...up, readdir: async () => [] }), { ok: true }, "any directory inside the mount (a session cwd)");
		const enoent = new Error("x") as NodeJS.ErrnoException;
		enoent.code = "ENOENT";
		assert.deepEqual(await verifyMounted(t, join(p, "nope"), { ...up, readdir: async () => { throw enoent; } }), {
			ok: false,
			error: `no such directory through the mount: ${join(p, "nope")}`,
		});
		assert.deepEqual(await verifyMounted(t, p, { ...up, readdir: () => new Promise(() => {}), verifyTimeoutMs: 25 }), {
			ok: false,
			error: `no answer within 25ms: the mount at ${p} is hung`,
		}, "a hung mount is bounded, never a success");
		assert.deepEqual(await verifyMounted(t, p, { mounts: () => "", readdir: async () => [] }), { ok: false, error: `no mount at ${p}` });
		assert.deepEqual(await verifyMounted(t, "/etc", up), { ok: false, error: `/etc is not inside the mount at ${p}` });
		assert.deepEqual(await verifyMounted({ name: "t", kind: "ssh", ssh: { host: "h" } } as TargetType, "/x"), { ok: false, error: "target t: no mount config" });
	} finally {
		clean(p);
	}
});