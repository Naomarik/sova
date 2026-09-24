/**
 * Manager side of detachable workers: launches each new worker under a
 * detached host (host.ts) when hosting is enabled, keeps its registry entry
 * (workers-dir.ts) current, detaches instead of killing when the embedding
 * process says it is going away, and re-adopts or finalizes an owner
 * session's workers when that session starts again.
 *
 * TRANSPORT SWITCH — env PI_WORKER_TRANSPORT, read at every spawn and session
 * start (in practice: whatever the server was started with):
 *
 *   unset | "inline"   DEFAULT. Workers are plain child processes of this
 *                      process, exactly as before hosting existed: no host
 *                      process, no socket, no ~/.pi/agent/sova/workers
 *                      registry, no worker-registry session entries, no
 *                      adoption; session_shutdown kills every worker.
 *   "host"             Each new worker runs under its own detached host with
 *                      a unix socket and a registry entry; a later session
 *                      start re-adopts or finalizes them.
 *   anything else      treated as "inline" (fail safe).
 *
 * Detach vs kill (host transport only) — read at session_shutdown:
 *
 *   globalThis[Symbol.for("sova:detach-workers")] === true
 *     the embedding process (Sova) is exiting: shutdown DETACHES hosted
 *     workers (registry state "detached", hosts keep running).
 *   anything else
 *     shutdown kills them, like inline. agent_kill, team teardown and explicit
 *     close always kill.
 */
import * as fs from "node:fs";
import type { Worker } from "./contracts.ts";
import {
	DEFAULT_WORKERS_ROOT,
	acquireLock,
	archive,
	ensurePrivateDir,
	files,
	listOwner,
	lockHeldByOther,
	mailboxDir,
	pidAlive,
	procStartTime,
	reap,
	releaseLock,
	safeId,
	socketPath,
	workerDir,
	writeMeta,
	type HostedSpec,
	type WorkerMeta,
} from "./workers-dir.ts";
import {
	adoptSpawnImpl,
	attachTransport,
	hostedSpawnImpl,
	logTransport,
	pingHost,
	type HostTransport,
	type TransportOptions,
} from "./host-transport.ts";

/** Set by the embedding process (Sova); see the module comment. */
export const DETACH_WORKERS = Symbol.for("sova:detach-workers");
export const TRANSPORT_ENV = "PI_WORKER_TRANSPORT";
export type WorkerTransport = "inline" | "host";
const SAVE_DELAY_MS = 250;
const SENT_TAIL_BYTES = 1024 * 1024;
const ADOPTABLE = new Set(["starting", "running", "detached"]);

export const detachRequested = (): boolean => {
	const g = globalThis as Record<symbol, unknown>;
	return g[DETACH_WORKERS] === true;
};
export const workerTransport = (env: NodeJS.ProcessEnv = process.env): WorkerTransport =>
	env[TRANSPORT_ENV]?.trim().toLowerCase() === "host" ? "host" : "inline";
export const hostingRequested = (env: NodeJS.ProcessEnv = process.env): boolean => workerTransport(env) === "host";

export interface HostingOptions {
	/** Registry root. Default DEFAULT_WORKERS_ROOT (~/.pi/agent/sova/workers). Created lazily. */
	root?: string;
	/** Force hosting on/off (tests); default: PI_WORKER_TRANSPORT === "host", read at each call. */
	enabled?: boolean;
	lingerMs?: number;
	orphanTtlMs?: number;
	/** Test seam: the host script. */
	hostScript?: string;
	/** Test seam: ping timeout for adoption. */
	pingTimeoutMs?: number;
}

interface Entry {
	dir: string;
	meta: WorkerMeta;
	transport?: HostTransport;
	worker?: Worker;
	saveTimer?: ReturnType<typeof setTimeout>;
	detached?: boolean;
	lost?: boolean;
}

export interface LaunchRequest {
	id: string;
	groupId: string;
	groupLabel?: string;
	name: string;
	backend: string;
	spec: HostedSpec;
	team?: { teamId: string; role: string; orchestrator?: boolean };
}

export interface Adoption {
	meta: WorkerMeta;
	/** The host answered; false means the log is replayed and the worker finalized. */
	alive: boolean;
	transport: HostTransport;
	/** Spread into the runner options. */
	options: { spawnImpl: ReturnType<typeof adoptSpawnImpl>; tmpDir: string; adopt: { replaying(): boolean; sessionId?: string; sessionFile?: string; sent: string[]; ended: boolean } };
}

/** The newest stdin lines earlier managers sent (in.jsonl tail); a cut first line is dropped. */
export function sentLines(dir: string, maxBytes = SENT_TAIL_BYTES): string[] {
	let fd: number | undefined;
	try {
		fd = fs.openSync(files(dir).in, "r");
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(size - start);
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const lines = buffer.toString("utf8").split("\n");
		if (start > 0) lines.shift();
		return lines.filter((line) => line.trim());
	} catch {
		return [];
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
	}
}

export class WorkerHosting {
	readonly root: string;
	private owner?: { id: string; file?: string };
	private readonly entries = new Map<string, Entry>();
	private readonly lostIds = new Set<string>();
	private readonly options: HostingOptions;

	constructor(options: HostingOptions = {}) {
		this.options = options;
		this.root = options.root ?? DEFAULT_WORKERS_ROOT;
	}

	setOwner(id: string | undefined, file: string | undefined): void {
		this.owner = id && safeId(id) ? { id, file } : undefined;
	}

	/** Hosting applies to new workers now: enabled, and a persisted owner session to re-adopt from. */
	active(): boolean {
		return (this.options.enabled ?? hostingRequested()) && !!this.owner?.file;
	}

	/** Team mailbox root under the registry, so pending requests survive a restart. */
	mailboxRoot(): string {
		const dir = mailboxDir(this.root, this.owner!.id);
		ensurePrivateDir(dir);
		return dir;
	}

	owns(workerId: string): boolean { return this.entries.has(workerId); }
	/** The worker's host died mid-turn (decided just before its synthesized exit). */
	lost(workerId: string): boolean { return this.lostIds.has(workerId) || this.entries.get(workerId)?.lost === true; }

	private transportOptions(entry: Entry): TransportOptions {
		return {
			statusFile: files(entry.dir).status,
			historyEnd: entry.meta.consumedOffset,
			onConsumed: (offset) => { entry.meta.consumedOffset = offset; this.save(entry); },
			onHello: (hello) => {
				Object.assign(entry.meta, {
					hostPid: hello.hostPid, pidStartTime: hello.hostStartTime ?? entry.meta.pidStartTime,
					workerPid: hello.workerPid, workerPgid: hello.workerPid, workerStartTime: hello.workerStartTime,
				});
				if (entry.meta.state === "starting" || entry.meta.state === "detached") entry.meta.state = "running";
				this.save(entry, true);
			},
		};
	}

	private save(entry: Entry, now = false): void {
		if (entry.detached) return;
		const write = () => {
			entry.saveTimer = undefined;
			try { writeMeta(entry.dir, entry.meta); } catch { /* registry is best effort; the host keeps running */ }
		};
		if (now) {
			if (entry.saveTimer) clearTimeout(entry.saveTimer);
			write();
			return;
		}
		if (entry.saveTimer) return;
		entry.saveTimer = setTimeout(write, SAVE_DELAY_MS);
		entry.saveTimer.unref?.();
	}

	/** Registry entry + runner options for a new hosted worker. */
	launch(request: LaunchRequest): { spawnImpl: ReturnType<typeof hostedSpawnImpl>; tmpDir: string } {
		const owner = this.owner!;
		const dir = workerDir(this.root, owner.id, request.id);
		// IDs are reserved durably per owner, so an existing directory is a leftover.
		if (listOwner(this.root, owner.id).some((e) => e.meta.id === request.id)) archive(this.root, dir, owner.id, request.id);
		ensurePrivateDir(dir);
		const now = Date.now();
		const meta: WorkerMeta = {
			v: 1, id: request.id, groupId: request.groupId, ...(request.groupLabel ? { groupLabel: request.groupLabel } : {}),
			name: request.name, backend: request.backend, ownerSessionId: owner.id, ...(owner.file ? { ownerSessionFile: owner.file } : {}),
			sock: socketPath(owner.id, request.id), outLog: files(dir).out, spec: request.spec, ...(request.team ? { team: request.team } : {}),
			consumedOffset: 0, state: "starting", createdAt: now, updatedAt: now,
		};
		const entry: Entry = { dir, meta };
		writeMeta(dir, meta);
		acquireLock(dir);
		this.entries.set(request.id, entry);
		const spawnImpl = hostedSpawnImpl({
			dir, sock: meta.sock, lingerMs: this.options.lingerMs, orphanTtlMs: this.options.orphanTtlMs, hostScript: this.options.hostScript,
			transport: this.transportOptions(entry),
			onTransport: (transport) => { entry.transport = transport; },
			onHostStarted: (pid) => {
				meta.hostPid = pid;
				meta.pidStartTime = pid ? procStartTime(pid) : undefined;
				this.save(entry, true);
			},
		});
		return { spawnImpl, tmpDir: dir };
	}

	/** Tie an entry to its runner: finalize when it closes; used for the lost decision. */
	bind(workerId: string, worker: Worker): void {
		const entry = this.entries.get(workerId);
		if (!entry) return;
		entry.worker = worker;
		void worker.whenClosed.then(() => this.finalize(workerId));
	}

	/** Keep the registry's backend identity current (cheap; call on every refresh). */
	observe(worker: Worker): void {
		const entry = this.entries.get(worker.id);
		if (!entry || entry.detached) return;
		const id = typeof worker.sessionId === "string" && worker.sessionId ? worker.sessionId : undefined;
		const file = typeof worker.sessionFile === "string" && worker.sessionFile ? worker.sessionFile : undefined;
		if ((id ?? entry.meta.backendSessionId) === entry.meta.backendSessionId && (file ?? entry.meta.backendSessionFile) === entry.meta.backendSessionFile) return;
		if (id) entry.meta.backendSessionId = id;
		if (file) entry.meta.backendSessionFile = file;
		this.save(entry, true);
	}

	/** The worker closed while owned: record the ending, let the host exit, archive the entry. */
	private finalize(workerId: string): void {
		const entry = this.entries.get(workerId);
		if (!entry || entry.detached) return;
		this.entries.delete(workerId);
		if (entry.saveTimer) clearTimeout(entry.saveTimer);
		entry.saveTimer = undefined;
		entry.meta.state = entry.lost ? "lost" : "exited";
		if (entry.lost) this.lostIds.add(workerId);
		try { writeMeta(entry.dir, entry.meta); } catch { /* archived below anyway */ }
		entry.transport?.release();
		releaseLock(entry.dir);
		archive(this.root, entry.dir, entry.meta.ownerSessionId, workerId);
	}

	/**
	 * Leave hosted workers running for a later manager. `keep` decides per
	 * worker (teardown already in flight is finished, not detached). Returns the
	 * detached worker IDs; everything else must still be disposed by the caller.
	 */
	detachAll(keep: (worker: Worker) => boolean): Set<string> {
		const detached = new Set<string>();
		for (const [id, entry] of this.entries) {
			if (!entry.transport || !entry.worker || entry.transport.gone || !keep(entry.worker)) continue;
			if (entry.saveTimer) clearTimeout(entry.saveTimer);
			entry.saveTimer = undefined;
			entry.meta.state = "detached";
			entry.meta.consumedOffset = entry.transport.consumedOffset;
			try { writeMeta(entry.dir, entry.meta); } catch { /* the host still runs; adoption falls back to offset 0 history */ }
			entry.detached = true;
			entry.transport.detach();
			releaseLock(entry.dir);
			this.entries.delete(id);
			detached.add(id);
		}
		return detached;
	}

	/** Entries of the current owner a new manager may adopt. */
	candidates(): { dir: string; meta: WorkerMeta }[] {
		if (!this.owner) return [];
		return listOwner(this.root, this.owner.id).filter(({ dir, meta }) =>
			ADOPTABLE.has(meta.state) && !this.entries.has(meta.id) && !lockHeldByOther(dir));
	}

	/**
	 * Take over one registry entry: attach to its living host (full replay, then
	 * live), or replay the log of a dead host and finalize. Undefined if another
	 * manager holds it.
	 */
	async adopt(dir: string, meta: WorkerMeta): Promise<Adoption | undefined> {
		if (this.entries.has(meta.id) || !acquireLock(dir)) return undefined;
		const pong = pidAlive(meta.hostPid, meta.pidStartTime) ? await pingHost(meta.sock, this.options.pingTimeoutMs) : undefined;
		const alive = !!pong && (!meta.hostPid || pong.hostPid === meta.hostPid);
		const entry: Entry = { dir, meta };
		const options = this.transportOptions(entry);
		let transport: HostTransport;
		if (alive) {
			transport = attachTransport(meta.sock, options);
		} else {
			// A dead host cannot drive its worker any more; never leave that worker orphaned.
			if (meta.workerPid && meta.workerStartTime !== undefined && pidAlive(meta.workerPid, meta.workerStartTime)) {
				try { process.kill(-(meta.workerPgid ?? meta.workerPid), "SIGTERM"); } catch { /* already gone */ }
			}
			transport = logTransport(meta.outLog, files(dir).status, options);
			// Died mid-turn: the task never settled in the log.
			transport.beforeExit = () => { entry.lost = !entry.worker || !entry.worker.isSettled(); };
		}
		entry.transport = transport;
		this.entries.set(meta.id, entry);
		return {
			meta, alive, transport,
			options: {
				spawnImpl: adoptSpawnImpl(transport),
				tmpDir: dir,
				adopt: { replaying: () => transport.replaying, sessionId: meta.backendSessionId, sessionFile: meta.backendSessionFile, sent: sentLines(dir), ended: !alive },
			},
		};
	}

	/** A launched entry whose runner was never created: stop any host it started and archive it. */
	discard(workerId: string): void {
		const entry = this.entries.get(workerId);
		if (!entry) return;
		this.entries.delete(workerId);
		entry.transport?.kill("SIGKILL");
		entry.transport?.release();
		releaseLock(entry.dir);
		archive(this.root, entry.dir, entry.meta.ownerSessionId, workerId);
	}

	/** Give up an adoption that never produced a runner. */
	abandon(workerId: string): void {
		const entry = this.entries.get(workerId);
		if (!entry) return;
		this.entries.delete(workerId);
		entry.transport?.detach();
		releaseLock(entry.dir);
	}

	/** Archive stale entries of every owner (dead host, nobody adopting, older than 24h). */
	reap(now = Date.now()): string[] {
		return reap(this.root, now);
	}

	/** Nothing of this owner is left in the registry (so its mailbox can go). */
	ownerEmpty(): boolean {
		return !this.owner || listOwner(this.root, this.owner.id).length === 0;
	}

	clear(): void {
		for (const entry of this.entries.values()) if (entry.saveTimer) clearTimeout(entry.saveTimer);
		this.entries.clear();
		this.lostIds.clear();
	}
}
