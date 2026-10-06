/**
 * The spec check's per-run record (§chat.spec-card/record): one `spec-turn` custom entry the mode
 * extension appends at the check's final verdict on a run that changed something. It is a plain custom
 * entry, never a custom message, so pi never puts it in the model's context; Sova draws it as the spec
 * card and the TUI as one line.
 *
 * Imports nothing, and none of pi's runtime: Sova's server imports this file (server/transcript.ts,
 * server/spec-claim.ts) for the same shape and the one strict check, `normalizeSpecTurnDetails`. Nothing
 * here throws on odd stored data.
 */

/** customType of the record. */
export const SPEC_TURN_ENTRY = "spec-turn";
/** Version of the record's data. */
export const SPEC_TURN_VERSION = 1;

/** Caps: a record stays small whatever a run did. */
const MAX_IDS = 400;
const MAX_TEXT = 600;
const MAX_PROSE = 8000;
const MAX_PROSE_IDS = 24;
const MAX_OPS = 64;

export type SpecTurnOpKind = "commit" | "merge" | "ff" | "promote" | "rebase" | "reset";
const OP_KINDS: readonly SpecTurnOpKind[] = ["commit", "merge", "ff", "promote", "rebase", "reset"];

/** One git operation of the run: the session's own (`actor` "self") or a worker's. */
export interface SpecTurnOp {
	kind: SpecTurnOpKind;
	/** The repository's top level the operation ran in. */
	tree: string;
	/** The branch checked out there at settle, when known. */
	branch?: string;
	actor: string;
	/** HEAD before and after; equal for an uncommitted promote (the work tree is its head). */
	before: string;
	after: string;
}

/** One § the run changed or landed. */
export interface SpecTurnItem {
	id: string;
	/** The change kind as the spec tools name it (text, record, text+record, child-added, deleted, renamed, …). */
	change?: string;
	/** In words: the reply's own for `own`, an earlier record's for `landed`. */
	what?: string;
	/** The index in `ops` of the operation that landed it, when one did. */
	op?: number;
}

/** § that came in from the default branch: counted, never listed one by one. */
export interface SpecTurnArrived {
	/** The default branch's name. */
	from: string;
	count: number;
	byArea: { area: string; count: number }[];
}

export interface SpecTurnGate {
	/** Changed files no claim maps, with the reply's `Plumbing:` why. */
	unmapped: { path: string; status?: string; plumbing?: string }[];
	/** Unpromoted draft records, with the reply's `Deferred:` why. */
	unpromoted: { draft?: string; ids: string[]; deferred?: string }[];
	/** Unpromoted § at a landing on the default branch: never deferred. */
	stale: string[];
	/** § a merge resolved by hand (they differ from both parents). */
	handResolved: string[];
}

export interface SpecTurnCheck {
	ok: boolean;
	/** What was wrong with the reply's closing lines, in words. */
	problem?: string;
	/** The reply's `Spec check override:` why. */
	override?: string;
	/** Hidden re-prompts the run took before this verdict. */
	reprompts: number;
	/** The check could not compute everything: why. */
	incomplete?: string;
}

export interface SpecTurnDetails {
	v: 1;
	ops: SpecTurnOp[];
	own: SpecTurnItem[];
	landed: SpecTurnItem[];
	arrived?: SpecTurnArrived;
	created: string[];
	gate: SpecTurnGate;
	check: SpecTurnCheck;
	/** Claim text captured at settle, by §, for an uncommitted promotion (no commit holds it). */
	prose?: Record<string, string>;
}

// ── The strict check ─────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SECTION_ID = /^§[A-Za-z0-9](?:[\w.\-/]*[\w-])?$/;
const isId = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && SECTION_ID.test(v);
const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const sha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{4,64}$/.test(v);

/** A list whose every element passes, else undefined (one bad element fails the record). */
function every<T>(v: unknown, one: (x: unknown) => T | undefined, max = MAX_IDS): T[] | undefined {
	if (!Array.isArray(v) || v.length > max) return undefined;
	const out: T[] = [];
	for (const x of v) {
		const y = one(x);
		if (y === undefined) return undefined;
		out.push(y);
	}
	return out;
}

const ids = (v: unknown): string[] | undefined => every(v, (x) => (isId(x) ? x : undefined));

function op(v: unknown): SpecTurnOp | undefined {
	if (!isRecord(v) || !OP_KINDS.includes(v.kind as SpecTurnOpKind)) return undefined;
	if (typeof v.tree !== "string" || !v.tree.startsWith("/") || v.tree.includes("\0")) return undefined;
	if (!sha(v.before) || !sha(v.after) || !text(v.actor, 200)) return undefined;
	const out: SpecTurnOp = { kind: v.kind as SpecTurnOpKind, tree: v.tree, actor: v.actor as string, before: v.before, after: v.after };
	if (v.branch !== undefined) {
		const b = text(v.branch, 200);
		if (!b) return undefined;
		out.branch = b;
	}
	return out;
}

function item(v: unknown, ops: number): SpecTurnItem | undefined {
	if (!isRecord(v) || !isId(v.id)) return undefined;
	const out: SpecTurnItem = { id: v.id };
	if (v.change !== undefined) {
		const c = text(v.change, 40);
		if (!c) return undefined;
		out.change = c;
	}
	if (v.what !== undefined) {
		const w = text(v.what);
		if (!w) return undefined;
		out.what = w;
	}
	if (v.op !== undefined) {
		const i = count(v.op);
		if (i === undefined || i >= ops) return undefined;
		out.op = i;
	}
	return out;
}

function arrived(v: unknown): SpecTurnArrived | undefined {
	if (!isRecord(v) || !text(v.from, 200) || count(v.count) === undefined) return undefined;
	const byArea = every(v.byArea, (a) => (isRecord(a) && text(a.area, 200) && count(a.count) !== undefined ? { area: a.area as string, count: a.count as number } : undefined));
	if (!byArea) return undefined;
	return { from: v.from as string, count: v.count as number, byArea };
}

function gate(v: unknown): SpecTurnGate | undefined {
	if (!isRecord(v)) return undefined;
	const unmapped = every(v.unmapped, (u) => {
		if (!isRecord(u) || !text(u.path, 400)) return undefined;
		const out: SpecTurnGate["unmapped"][number] = { path: u.path as string };
		if (u.status !== undefined) {
			const s = text(u.status, 40);
			if (!s) return undefined;
			out.status = s;
		}
		if (u.plumbing !== undefined) {
			const p = text(u.plumbing);
			if (!p) return undefined;
			out.plumbing = p;
		}
		return out;
	});
	const unpromoted = every(v.unpromoted, (u) => {
		if (!isRecord(u)) return undefined;
		const list = ids(u.ids);
		if (!list) return undefined;
		const out: SpecTurnGate["unpromoted"][number] = { ids: list };
		if (u.draft !== undefined) {
			const d = text(u.draft, 200);
			if (!d) return undefined;
			out.draft = d;
		}
		if (u.deferred !== undefined) {
			const d = text(u.deferred);
			if (!d) return undefined;
			out.deferred = d;
		}
		return out;
	});
	const stale = ids(v.stale);
	const handResolved = ids(v.handResolved);
	if (!unmapped || !unpromoted || !stale || !handResolved) return undefined;
	return { unmapped, unpromoted, stale, handResolved };
}

function check(v: unknown): SpecTurnCheck | undefined {
	if (!isRecord(v) || typeof v.ok !== "boolean" || count(v.reprompts) === undefined) return undefined;
	const out: SpecTurnCheck = { ok: v.ok, reprompts: v.reprompts as number };
	for (const k of ["problem", "override", "incomplete"] as const) {
		if (v[k] === undefined) continue;
		const t = text(v[k]);
		if (!t) return undefined;
		out[k] = t;
	}
	return out;
}

/** The record's data, checked whole: undefined when any part is malformed. Never throws. */
export function normalizeSpecTurnDetails(v: unknown): SpecTurnDetails | undefined {
	try {
		if (!isRecord(v) || v.v !== SPEC_TURN_VERSION) return undefined;
		const ops = every(v.ops, op, MAX_OPS);
		if (!ops) return undefined;
		const own = every(v.own, (x) => item(x, ops.length));
		const landed = every(v.landed, (x) => item(x, ops.length));
		const created = ids(v.created);
		const g = gate(v.gate);
		const c = check(v.check);
		if (!own || !landed || !created || !g || !c) return undefined;
		const out: SpecTurnDetails = { v: 1, ops, own, landed, created, gate: g, check: c };
		if (v.arrived !== undefined) {
			const a = arrived(v.arrived);
			if (!a) return undefined;
			out.arrived = a;
		}
		if (v.prose !== undefined) {
			if (!isRecord(v.prose)) return undefined;
			const keys = Object.keys(v.prose);
			if (keys.length > MAX_PROSE_IDS) return undefined;
			const prose: Record<string, string> = {};
			for (const k of keys) {
				const t = text(v.prose[k], MAX_PROSE);
				if (!isId(k) || !t) return undefined;
				prose[k] = t;
			}
			out.prose = prose;
		}
		return out;
	} catch {
		return undefined;
	}
}

// ── Building one ─────────────────────────────────────────────────────────────

/** A closing line's `<head> — <why>` split (` — `, ` – `, ` - `). */
function headWhy(body: string): { head: string; why: string } {
	const m = /\s[—–-]\s/.exec(body);
	return m ? { head: body.slice(0, m.index).trim(), why: body.slice(m.index + m[0].length).trim() } : { head: body.trim(), why: "" };
}
const lineBody = (raw: string, tag: string): string | undefined => {
	const line = raw.trim().replace(/^[*_]+|[*_]+$/g, "").replace(/`/g, "").trim();
	return line.startsWith(tag) ? line.slice(tag.length).trim() : undefined;
};

/** The reply's closing-line whys: `Plumbing:` by path, `Deferred:` by §, and the override's. */
export function closingWhys(reply: string): { plumbing: Map<string, string>; deferred: Map<string, string>; override?: string } {
	const plumbing = new Map<string, string>();
	const deferred = new Map<string, string>();
	let override: string | undefined;
	for (const raw of reply.split("\n")) {
		const p = lineBody(raw, "Plumbing:");
		if (p !== undefined) {
			const { head, why } = headWhy(p);
			if (why) for (const path of head.split(/,\s*/).map((x) => x.trim().replace(/^\.\//, "")).filter(Boolean)) plumbing.set(path, why);
			continue;
		}
		const d = lineBody(raw, "Deferred:");
		if (d !== undefined) {
			const { head, why } = headWhy(d);
			if (!why) continue;
			let full = "";
			for (const part of head.split(/\s*,\s*/)) {
				const id = part.startsWith("/") && full ? `${full.slice(0, Math.max(full.lastIndexOf("/"), 0))}${part}` : part;
				if (!part.startsWith("/")) full = id;
				if (isId(id)) deferred.set(id, why);
			}
			continue;
		}
		const o = lineBody(raw, "Spec check override:");
		if (o) override = o;
	}
	return { plumbing, deferred, ...(override ? { override } : {}) };
}

/** The area a § sits in: everything before its last `/`, without the `§` ("§app.harness/reader" → "app.harness"). */
export function areaOf(id: string): string {
	const bare = id.replace(/^§/, "");
	const cut = bare.lastIndexOf("/");
	return cut < 0 ? bare : bare.slice(0, cut);
}

/** What the run computed, as the check holds it at its final verdict. */
export interface SpecTurnInput {
	ops: SpecTurnOp[];
	/** The reply's `Also changes:` items (parsed by also-changes.ts): the § and the reply's words. */
	named: { ids: string[]; text: string }[];
	/** The § the check computed for the run (Git's foreign list). */
	foreign: readonly string[];
	/** Each computed § with its change kind and operation, when the check knows them. */
	changes?: ReadonlyMap<string, { change?: string; op?: number }>;
	/** § earlier records on the branch described, with their words. */
	described?: ReadonlyMap<string, string>;
	arrived?: SpecTurnArrived;
	created?: readonly string[];
	unmapped: readonly (string | { path: string; status?: string })[];
	unpromoted: readonly { draft?: string; ids: readonly string[] }[];
	stale: readonly string[];
	handResolved?: readonly string[];
	reply: string;
	ok: boolean;
	problem?: string;
	reprompts: number;
	incomplete?: string;
	prose?: Record<string, string>;
}

/** The words after an item's ids: its leading separator dropped. */
const wordsOf = (t: string): string | undefined => text(t.replace(/^[—–:-]\s*|^\(\s*/, "").replace(/\)$/, "").trim());

/** One record from what the run computed: the reply's own § first, then the rest it landed. */
export function buildSpecTurn(input: SpecTurnInput): SpecTurnDetails {
	const whys = closingWhys(input.reply);
	const changeOf = (id: string) => input.changes?.get(id);
	const withChange = (it: SpecTurnItem): SpecTurnItem => {
		const c = changeOf(it.id);
		if (c?.change) it.change = c.change.slice(0, 40);
		if (c?.op !== undefined && c.op < input.ops.length) it.op = c.op;
		return it;
	};
	const own: SpecTurnItem[] = [];
	const seen = new Set<string>();
	for (const named of input.named) {
		const what = wordsOf(named.text);
		for (const id of named.ids) {
			if (seen.has(id) || !isId(id)) continue;
			seen.add(id);
			own.push(withChange({ id, ...(what ? { what } : {}) }));
		}
	}
	const landed: SpecTurnItem[] = [];
	for (const id of input.foreign) {
		if (seen.has(id) || !isId(id)) continue;
		seen.add(id);
		const what = input.described?.get(id);
		landed.push(withChange({ id, ...(what ? { what: what.slice(0, MAX_TEXT) } : {}) }));
	}
	const unmapped = input.unmapped.map((u) => {
		const path = typeof u === "string" ? u : u.path;
		const status = typeof u === "string" ? undefined : u.status;
		const plumbing = whys.plumbing.get(path);
		return { path, ...(status ? { status } : {}), ...(plumbing ? { plumbing: plumbing.slice(0, MAX_TEXT) } : {}) };
	});
	const unpromoted = input.unpromoted.map((d) => {
		const deferred = d.ids.map((id) => whys.deferred.get(id)).find(Boolean);
		return { ...(d.draft ? { draft: d.draft } : {}), ids: [...d.ids].filter(isId), ...(deferred ? { deferred: deferred.slice(0, MAX_TEXT) } : {}) };
	});
	const out: SpecTurnDetails = {
		v: 1,
		ops: input.ops.slice(0, MAX_OPS),
		own: own.slice(0, MAX_IDS),
		landed: landed.slice(0, MAX_IDS),
		created: [...(input.created ?? [])].filter(isId).slice(0, MAX_IDS),
		gate: { unmapped: unmapped.slice(0, MAX_IDS), unpromoted: unpromoted.slice(0, MAX_IDS), stale: [...input.stale].filter(isId).slice(0, MAX_IDS), handResolved: [...(input.handResolved ?? [])].filter(isId).slice(0, MAX_IDS) },
		check: {
			ok: input.ok,
			reprompts: input.reprompts,
			...(input.problem ? { problem: input.problem.slice(0, MAX_TEXT) } : {}),
			...(whys.override ? { override: whys.override.slice(0, MAX_TEXT) } : {}),
			...(input.incomplete ? { incomplete: input.incomplete.slice(0, MAX_TEXT) } : {}),
		},
	};
	if (input.arrived) out.arrived = input.arrived;
	if (input.prose && Object.keys(input.prose).length) {
		const prose: Record<string, string> = {};
		for (const [k, v] of Object.entries(input.prose).slice(0, MAX_PROSE_IDS)) if (isId(k) && v.trim()) prose[k] = v.slice(0, MAX_PROSE);
		if (Object.keys(prose).length) out.prose = prose;
	}
	return out;
}

// ── Reading them back ────────────────────────────────────────────────────────

/**
 * The § earlier records on a branch described, with their words (the newest wins): what the check
 * passes as `described`, so a reply never has to name them again. `entries` are raw session entries.
 */
export function describedOn(entries: readonly unknown[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom" || e.customType !== SPEC_TURN_ENTRY) continue;
		const d = normalizeSpecTurnDetails(e.data);
		if (!d) continue;
		for (const it of [...d.own, ...d.landed]) if (it.what) out.set(it.id, it.what);
	}
	return out;
}

/** The § a record counts as changed by its run: its own and what it landed. */
export const changedCount = (d: SpecTurnDetails): number => new Set([...d.own, ...d.landed].map((it) => it.id)).size;

/** The card's collapsed line, and the TUI's: "Spec · 6 § changed · 83 § from master" (a 0 part left out). */
export function specTurnLine(d: SpecTurnDetails): string {
	const parts = ["Spec"];
	const n = changedCount(d);
	if (n) parts.push(`${n} § changed`);
	if (d.arrived?.count) parts.push(`${d.arrived.count} § from ${d.arrived.from}`);
	if (parts.length === 1) parts.push("no § changed");
	return parts.join(" · ");
}
