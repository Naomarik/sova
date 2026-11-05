/**
 * The wake store: what must bring a chat back at a time, kept outside the chat (one JSON file per
 * chat and source, in the directory `SOVA_WAKE_DIR` names), so the host that started it still knows
 * after the chat shut down, crashed or the machine restarted. Node builtins only: wake-nudge.ts,
 * subagents/index.ts and Sova's keeper read and write the same files.
 *
 * Whoever owns an item (`source`) writes its own file and removes the item once it has really been
 * delivered: the keeper never removes one that is still pending, it only brings the chat back. So any
 * "bring this chat back at time T" works the same way: write an item, deliver it when the chat
 * starts, remove it. A source republishes on every start, which is how the keeper tells a stale file
 * from a nudge that didn't fire (`syncedAt`).
 *
 * Only a chat a host started writes here: `wakeStoreOf` needs `SOVA_WAKE_DIR` and the session file
 * the host named in `SOVA_CHAT_PATH`, so a terminal pi, or one run by a chat's own bash, writes nothing.
 */
import fs from "node:fs";
import path from "node:path";

export const WAKE_DIR_ENV = "SOVA_WAKE_DIR";
/** Set ("1") in a worker chat's process (see `resetsWakeCount`, wake-nudge.ts). */
export const WAKE_WORKER_ENV = "SOVA_WAKE_WORKER";
/** The directory under a state root. */
export const WAKE_DIR_NAME = "wake-nudges";
const CANCELLED_DIR = "cancelled";

export interface WakeItem {
	/** Unique within its record. */
	id: string;
	/** When it comes due (epoch ms). */
	at: number;
}

export interface WakeRecord {
	v: 1;
	/** Who owns these items: "nudges", "team", or any later source. */
	source: string;
	sessionId: string;
	/** The chat's session file. */
	path: string;
	items: WakeItem[];
	/** When its owner last wrote it. */
	syncedAt: number;
}

export interface WakeStore {
	dir: string;
	sessionId: string;
	path: string;
}

const recordName = (sessionId: string, source: string) => `${encodeURIComponent(sessionId)}.${encodeURIComponent(source)}.json`;

/** This chat's store, or none: only the chat its host started, on the session file it was started for. */
export function wakeStoreOf(sessionId: string | undefined, sessionFile: string | undefined, env: NodeJS.ProcessEnv = process.env): WakeStore | undefined {
	const dir = env[WAKE_DIR_ENV];
	const hosted = env.SOVA_CHAT_PATH;
	if (!dir || !hosted || !sessionId || !sessionFile || path.resolve(hosted) !== path.resolve(sessionFile)) return undefined;
	return { dir, sessionId, path: sessionFile };
}

function writeAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Publish a source's items for a chat, replacing what it published before; none removes its file. */
export function publishWakes(store: WakeStore, source: string, items: WakeItem[], now = Date.now()): void {
	const file = path.join(store.dir, recordName(store.sessionId, source));
	if (!items.length) {
		fs.rmSync(file, { force: true });
		return;
	}
	const record: WakeRecord = { v: 1, source, sessionId: store.sessionId, path: store.path, items, syncedAt: now };
	writeAtomic(file, `${JSON.stringify(record)}\n`);
}

/** Every record in the directory. A file that doesn't read as one is left out, never fatal. */
export function readWakeRecords(dir: string): WakeRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: WakeRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const r = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<WakeRecord>;
			if (r?.v !== 1 || typeof r.path !== "string" || typeof r.sessionId !== "string" || typeof r.source !== "string" || !Array.isArray(r.items)) continue;
			const items = r.items.filter((i) => typeof i?.id === "string" && typeof i?.at === "number");
			out.push({ v: 1, source: r.source, sessionId: r.sessionId, path: r.path, items, syncedAt: typeof r.syncedAt === "number" ? r.syncedAt : 0 });
		} catch {
			/* Half-written or foreign. */
		}
	}
	return out;
}

/** Remove every source's record of a chat. */
export function dropWakeRecords(dir: string, sessionId: string): void {
	const prefix = `${encodeURIComponent(sessionId)}.`;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) if (name.startsWith(prefix) && name.endsWith(".json")) fs.rmSync(path.join(dir, name), { force: true });
}

/**
 * The durable cancel of a chat that may have no process to write one: everything it scheduled up to
 * `at` is cancelled for good. A chat reads it when it rebuilds its nudges.
 */
export function cancelWakesBefore(dir: string, sessionId: string, at: number): void {
	writeAtomic(path.join(dir, CANCELLED_DIR, encodeURIComponent(sessionId)), `${at}\n`);
}

/** The time up to which this chat's nudges were cancelled; 0 when none were. */
export function wakesCancelledBefore(dir: string, sessionId: string): number {
	try {
		const at = Number(fs.readFileSync(path.join(dir, CANCELLED_DIR, encodeURIComponent(sessionId)), "utf8").trim());
		return Number.isFinite(at) ? at : 0;
	} catch {
		return 0;
	}
}
