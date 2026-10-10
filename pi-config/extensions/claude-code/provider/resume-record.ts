/**
 * A chat's resume record (§app.claude-code-provider/continuity): where a new CLI child for a pi
 * session can pick up that session's own last Claude session instead of folding the history.
 *
 * The bridge saves one after each turn that settled cleanly and in step (a success result, no tool
 * call left open), and drops it as soon as it sends the child anything else, or the child falls out
 * of step, or a turn is aborted: a record therefore never names a Claude session that stopped
 * mid-turn. It is kept in memory and on disk (`<dir>/<pi session id>.json`, one file per pi
 * session, written atomically), so it survives an idle child being closed and a server restart.
 *
 * Builtins only. Never throws: a record that can't be read or written only means a fold.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ResumeRecord {
	v: 1;
	/** The Claude session the child that settled ran under. */
	claudeSessionId: string;
	/** How many pi messages (as sent to the provider) that session heard. */
	messages: number;
	/** Their cumulative fingerprint (session-bridge.ts `transcriptFingerprint`). */
	prefix: string;
	/** The child's working directory. */
	cwd: string;
	/** The login the child ran on (accounts.ts id), or null without logins. */
	login: string | null;
	/** session-bridge.ts `turnMeta` of the turn: model, effort, system prompt, tools, cwd. */
	meta: string;
	/** ms epoch: when the turn settled. */
	at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The record in `value`, or undefined for anything that is not exactly one. */
export function normalizeResumeRecord(value: unknown): ResumeRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	if (r.v !== 1) return undefined;
	if (typeof r.claudeSessionId !== "string" || !UUID.test(r.claudeSessionId)) return undefined;
	if (typeof r.messages !== "number" || !Number.isInteger(r.messages) || r.messages < 1) return undefined;
	if (typeof r.prefix !== "string" || !r.prefix) return undefined;
	if (typeof r.cwd !== "string" || !r.cwd) return undefined;
	if (!(r.login === null || (typeof r.login === "string" && r.login.length > 0))) return undefined;
	if (typeof r.meta !== "string" || !r.meta) return undefined;
	if (typeof r.at !== "number" || !Number.isFinite(r.at)) return undefined;
	return { v: 1, claudeSessionId: r.claudeSessionId, messages: r.messages, prefix: r.prefix, cwd: r.cwd, login: r.login as string | null, meta: r.meta, at: r.at };
}

/** One record per pi session, in memory and (with a `dir`) on disk. */
export class ResumeStore {
	private readonly memory = new Map<string, ResumeRecord | null>();
	constructor(private readonly dir: string | undefined) {}

	private file(key: string): string | undefined {
		return this.dir && SAFE_KEY.test(key) ? join(this.dir, `${key}.json`) : undefined;
	}

	get(key: string): ResumeRecord | undefined {
		if (this.memory.has(key)) return this.memory.get(key) ?? undefined;
		const file = this.file(key);
		let record: ResumeRecord | undefined;
		if (file) {
			try { record = normalizeResumeRecord(JSON.parse(readFileSync(file, "utf8"))); } catch { record = undefined; }
		}
		this.memory.set(key, record ?? null);
		return record;
	}

	set(key: string, record: ResumeRecord): void {
		this.memory.set(key, record);
		const file = this.file(key);
		if (!file) return;
		try {
			mkdirSync(this.dir!, { recursive: true, mode: 0o700 });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			renameSync(tmp, file);
		} catch { /* a record on disk is an optimisation: without it the next process folds */ }
	}

	clear(key: string): void {
		if (this.memory.get(key) === null) return;
		this.memory.set(key, null);
		const file = this.file(key);
		if (!file) return;
		try { rmSync(file, { force: true }); } catch { /* the next set or a stale read check covers it */ }
	}
}
