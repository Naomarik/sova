/**
 * What a Claude Code CLI spent, from its stream-json frames: one call per Anthropic message id, and
 * at each turn's `result` a residual for what no frame showed (README.md). Builtins only.
 *
 * Per call: `message_start` carries input and cache tokens, `message_delta` the output, and the
 * `assistant` frames repeat them; all of them are merged by the max per field, never summed. A
 * message is done when its lane starts the next request or reply, at the turn's `result`, or when
 * the process closes (its assistant echoes come before any of those).
 *
 * The residual: the result's `modelUsage` is cumulative over the Claude session (`--resume`
 * history included). The last cumulative total per Claude session is persisted (`BaselineStore`),
 * so at each result, per model, residual = cumulative − baseline − what this collector recorded
 * since; negatives clamp to 0. A result at or under the persisted total is history (a re-adopted
 * worker's replay, a turn that spent nothing): it only resets what was recorded since. A session
 * with no baseline that this process did not start fresh (a resume, a fork, an adoption of a
 * session from before the ledger) has its first result taken as the baseline, never as spend.
 */
import fs from "node:fs";
import path from "node:path";

/** One call's tokens: input, output, cache read, cache write (all), the 1-hour part of the writes. */
export interface ClaudeTokens {
	i: number;
	o: number;
	cr: number;
	cw: number;
	cw1h: number;
}

/** One Anthropic message (one API call). */
export interface ClaudeCallUsage {
	/** The message id (`msg_…`), or undefined when the frames carried none. */
	id?: string;
	/** The resolved model id (`claude-fable-5-1`), or "" when no frame named it. */
	model: string;
	/** The lane: "" for the root, else its parent_tool_use_id (a Task subagent). */
	lane: string;
	/** The Claude session id, when a frame named it. */
	claudeSession?: string;
	stop?: string;
	at: number;
	tokens: ClaudeTokens;
}

/** What a result's cumulative usage shows beyond the calls recorded, for one model. */
export interface ClaudeResidualUsage {
	claudeSession: string;
	model: string;
	/** The session's cumulative total (all models, all fields) at this result: unique per result. */
	total: number;
	at: number;
	tokens: ClaudeTokens;
}

export interface ClaudeUsageSink {
	call(usage: ClaudeCallUsage): void;
	residual(usage: ClaudeResidualUsage): void;
}

/** Cumulative tokens per model. */
export type ClaudeCumulative = Record<string, ClaudeTokens>;

/** The last cumulative total per Claude session, kept across processes. */
export interface BaselineStore {
	read(claudeSession: string): ClaudeCumulative | undefined;
	write(claudeSession: string, cumulative: ClaudeCumulative): void;
}

export const zeroTokens = (): ClaudeTokens => ({ i: 0, o: 0, cr: 0, cw: 0, cw1h: 0 });
const FIELDS = ["i", "o", "cr", "cw", "cw1h"] as const;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
export const tokenSum = (t: ClaudeTokens): number => t.i + t.o + t.cr + t.cw;
const cumSum = (c: ClaudeCumulative): number => Object.values(c).reduce((n, t) => n + tokenSum(t), 0);

/** An API usage block (snake_case) as tokens. */
export function tokensOfUsage(usage: unknown): ClaudeTokens {
	const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, any>;
	return {
		i: num(u.input_tokens),
		o: num(u.output_tokens),
		cr: num(u.cache_read_input_tokens),
		cw: num(u.cache_creation_input_tokens),
		cw1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
	};
}

/** A result's `modelUsage` (camelCase, per model) as cumulative tokens, or undefined without one. */
export function cumulativeOf(modelUsage: unknown): ClaudeCumulative | undefined {
	if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return undefined;
	const out: ClaudeCumulative = {};
	for (const [model, v] of Object.entries(modelUsage as Record<string, any>)) {
		if (!v || typeof v !== "object") continue;
		out[model] = { i: num(v.inputTokens), o: num(v.outputTokens), cr: num(v.cacheReadInputTokens), cw: num(v.cacheCreationInputTokens), cw1h: 0 };
	}
	return out;
}

const maxInto = (into: ClaudeTokens, from: ClaudeTokens) => {
	for (const f of FIELDS) into[f] = Math.max(into[f], from[f]);
};
const addInto = (into: ClaudeTokens, from: ClaudeTokens) => {
	for (const f of FIELDS) into[f] += from[f];
};

/** The baseline files: `<dir>/<claude session id>.json` `{v: 1, at, models}`, rewritten atomically. */
export function fileBaselineStore(dir: string): BaselineStore {
	const SAFE = /^[A-Za-z0-9._-]{1,128}$/;
	const file = (sid: string) => (SAFE.test(sid) ? path.join(dir, `${sid}.json`) : undefined);
	return {
		read(sid) {
			const f = file(sid);
			if (!f) return undefined;
			try {
				const v = JSON.parse(fs.readFileSync(f, "utf8")) as { v?: unknown; models?: unknown };
				if (v?.v !== 1 || !v.models || typeof v.models !== "object") return undefined;
				const out: ClaudeCumulative = {};
				for (const [m, t] of Object.entries(v.models as Record<string, any>)) out[m] = { i: num(t?.i), o: num(t?.o), cr: num(t?.cr), cw: num(t?.cw), cw1h: num(t?.cw1h) };
				return out;
			} catch {
				return undefined;
			}
		},
		write(sid, cumulative) {
			const f = file(sid);
			if (!f) return;
			try {
				fs.mkdirSync(dir, { recursive: true });
				const tmp = `${f}.${process.pid}.tmp`;
				fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), models: cumulative }));
				fs.renameSync(tmp, f);
			} catch {
				// Bookkeeping only: the next result re-establishes it.
			}
		},
	};
}

export interface ClaudeUsageCollector {
	/** One decoded stdout record. Never throws. */
	frame(event: unknown): void;
	/** The process closed: every open message is recorded. Idempotent. */
	close(): void;
}

export interface ClaudeUsageOptions {
	sink: ClaudeUsageSink;
	baseline: BaselineStore;
	/**
	 * This process started its Claude session fresh (no `--resume`): a session with no baseline
	 * starts from zero. Otherwise its first result only establishes the baseline.
	 */
	fresh?: boolean;
	now?: () => number;
}

interface Pending {
	id?: string;
	model: string;
	lane: string;
	claudeSession?: string;
	stop?: string;
	tokens: ClaudeTokens;
}

interface SessionState {
	/** The cumulative last accounted for; undefined until known. */
	base?: ClaudeCumulative;
	/** Tokens recorded per model since `base`. */
	since: ClaudeCumulative;
}

export function createClaudeUsageCollector(options: ClaudeUsageOptions): ClaudeUsageCollector {
	const now = options.now ?? Date.now;
	const lanes = new Map<string, Pending>();
	const sessions = new Map<string, SessionState>();
	let closed = false;
	let lastSession: string | undefined;

	const stateOf = (sid: string): SessionState => {
		let s = sessions.get(sid);
		if (!s) {
			s = { base: options.baseline.read(sid), since: {} };
			sessions.set(sid, s);
		}
		return s;
	};
	const flush = (lane: string) => {
		const p = lanes.get(lane);
		if (!p) return;
		lanes.delete(lane);
		if (tokenSum(p.tokens) === 0) return;
		const sid = p.claudeSession ?? lastSession;
		if (sid) addInto((stateOf(sid).since[p.model] ??= zeroTokens()), p.tokens);
		try {
			options.sink.call({ ...(p.id ? { id: p.id } : {}), model: p.model, lane: p.lane, ...(sid ? { claudeSession: sid } : {}), ...(p.stop ? { stop: p.stop } : {}), at: now(), tokens: p.tokens });
		} catch {
			// Recording only.
		}
	};
	/** The lane's message `id` (a new id ends the one before). */
	const messageOf = (lane: string, id: string | undefined, sid: string | undefined): Pending => {
		const cur = lanes.get(lane);
		if (cur && (id === undefined || cur.id === undefined || cur.id === id)) {
			cur.id ??= id;
			return cur;
		}
		if (cur) flush(lane);
		const p: Pending = { ...(id ? { id } : {}), model: "", lane, ...(sid ? { claudeSession: sid } : {}), tokens: zeroTokens() };
		lanes.set(lane, p);
		return p;
	};
	const result = (e: Record<string, any>) => {
		for (const lane of [...lanes.keys()]) flush(lane);
		const sid = typeof e.session_id === "string" ? e.session_id : lastSession;
		const cum = cumulativeOf(e.modelUsage);
		if (!sid || !cum) return;
		const s = stateOf(sid);
		if (!s.base) {
			if (!options.fresh) {
				// No baseline for a session this process resumed: its history is not this process's spend.
				s.base = cum;
				s.since = {};
				options.baseline.write(sid, cum);
				return;
			}
			s.base = {};
		}
		const total = cumSum(cum);
		if (total <= cumSum(s.base)) {
			s.since = {};
			return;
		}
		const at = now();
		for (const [model, t] of Object.entries(cum)) {
			const b = s.base[model] ?? zeroTokens();
			const r = s.since[model] ?? zeroTokens();
			const tokens = zeroTokens();
			for (const f of FIELDS) tokens[f] = Math.max(0, t[f] - b[f] - r[f]);
			if (tokenSum(tokens) > 0) {
				try {
					options.sink.residual({ claudeSession: sid, model, total, at, tokens });
				} catch {
					// Recording only.
				}
			}
		}
		s.base = cum;
		s.since = {};
		options.baseline.write(sid, cum);
	};

	return {
		frame(event) {
			if (closed || !event || typeof event !== "object") return;
			try {
				const e = event as Record<string, any>;
				const sid = typeof e.session_id === "string" ? e.session_id : undefined;
				if (sid) lastSession = sid;
				const lane = typeof e.parent_tool_use_id === "string" ? e.parent_tool_use_id : "";
				switch (e.type) {
					case "system":
						if (e.subtype === "init" && sid && options.fresh && !options.baseline.read(sid)) {
							// A fresh session starts at zero: a later relaunch with --resume finds that.
							stateOf(sid).base ??= {};
							options.baseline.write(sid, {});
						} else if (e.subtype === "status" && e.status === "requesting") flush(lane);
						return;
					case "stream_event": {
						const ev = e.event as Record<string, any> | undefined;
						if (ev?.type === "message_start") {
							const m = ev.message as Record<string, any> | undefined;
							const p = messageOf(lane, typeof m?.id === "string" ? m.id : undefined, sid);
							if (typeof m?.model === "string" && m.model) p.model = m.model;
							maxInto(p.tokens, tokensOfUsage(m?.usage));
						} else if (ev?.type === "message_delta") {
							const p = lanes.get(lane);
							if (!p) return;
							maxInto(p.tokens, tokensOfUsage(ev.usage));
							if (typeof ev.delta?.stop_reason === "string") p.stop = ev.delta.stop_reason;
						}
						return;
					}
					case "assistant": {
						const m = e.message as Record<string, any> | undefined;
						if (!m || m.model === "<synthetic>") return;
						const p = messageOf(lane, typeof m.id === "string" ? m.id : undefined, sid);
						if (typeof m.model === "string" && m.model) p.model = m.model;
						maxInto(p.tokens, tokensOfUsage(m.usage));
						if (typeof m.stop_reason === "string") p.stop = m.stop_reason;
						return;
					}
					case "result":
						result(e);
						return;
				}
			} catch {
				// Observation only.
			}
		},
		close() {
			if (closed) return;
			closed = true;
			for (const lane of [...lanes.keys()]) flush(lane);
		},
	};
}
