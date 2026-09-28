/**
 * The `show_changes` call's input check: the parameters as the model sent them, turned into a
 * request or refused with a sentence the model can act on. Node builtins only (none, in fact).
 */
import {
	hunkRefKey,
	isRepoPath,
	SHOW_CHANGES_LIMITS,
	SHOW_CHANGES_SCOPE_KINDS,
	type ShowChangesHunkRef,
	type ShowChangesScopeKind,
	type ShowChangesStep,
} from "./details.ts";

/** A call the model can fix: the message says what was wrong and where. */
export class ShowChangesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShowChangesError";
	}
}

export interface ShowChangesRequest {
	scope: ShowChangesScopeKind;
	/** scope commit: the commit-ish, as given. */
	commit?: string;
	/** scope dirty / worktree: a tracked worktree's path or branch, or a directory path. */
	worktree?: string;
	title?: string;
	paths?: string[];
	steps?: ShowChangesStep[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function need(ok: unknown, message: string): asserts ok {
	if (!ok) throw new ShowChangesError(message);
}

function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(v)) {
		if (v[key] === undefined) continue;
		need(allowed.includes(key), `${where}: unknown field "${key}" (allowed: ${allowed.join(", ")})`);
	}
}

function text(v: unknown, where: string): string {
	need(typeof v === "string" && v.trim() !== "", `${where} must be a non-empty string`);
	const s = (v as string).trim();
	need(s.length <= SHOW_CHANGES_LIMITS.text, `${where} is longer than ${SHOW_CHANGES_LIMITS.text} characters`);
	return s;
}

/** A path as the model may write it: "./src/a.ts" → "src/a.ts". Directory prefixes keep one trailing "/". */
function repoPath(v: unknown, where: string, dirOk: boolean): string {
	need(typeof v === "string", `${where} must be a string`);
	const p = (v as string).trim().replace(/^(?:\.\/)+/, "");
	need(isRepoPath(p), `${where} must be a path relative to the repository's top level, with "/" separators and no "." or ".." segment: ${JSON.stringify(v)}`);
	need(dirOk || !p.endsWith("/"), `${where} must name a file, not a directory: ${JSON.stringify(v)}`);
	return p;
}

function lineNo(v: unknown, where: string): number | undefined {
	if (v === undefined) return undefined;
	need(typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9, `${where} must be a line number (the @@ header's start)`);
	return v as number;
}

function hunk(v: unknown, where: string): ShowChangesHunkRef {
	need(isRecord(v), `${where} must be an object {path, oldStart?, newStart?}`);
	const r = v as Record<string, unknown>;
	onlyKeys(r, ["path", "oldStart", "newStart"], where);
	const out: ShowChangesHunkRef = { path: repoPath(r.path, `${where}.path`, false) };
	const o = lineNo(r.oldStart, `${where}.oldStart`);
	const n = lineNo(r.newStart, `${where}.newStart`);
	if (o !== undefined) out.oldStart = o;
	if (n !== undefined) out.newStart = n;
	return out;
}

function step(v: unknown, i: number, seen: Map<string, number>): ShowChangesStep {
	const where = `steps[${i}]`;
	need(isRecord(v), `${where} must be an object {title, why?, buildsOn?, hunks}`);
	const r = v as Record<string, unknown>;
	onlyKeys(r, ["title", "why", "buildsOn", "hunks"], where);
	const out: ShowChangesStep = { title: text(r.title, `${where}.title`), hunks: [] };
	if (r.why !== undefined) out.why = text(r.why, `${where}.why`);
	if (r.buildsOn !== undefined) {
		need(Array.isArray(r.buildsOn), `${where}.buildsOn must be an array of step numbers`);
		const b = r.buildsOn as unknown[];
		for (const k of b) need(Number.isInteger(k) && (k as number) >= 1 && (k as number) <= i, `${where}.buildsOn: ${JSON.stringify(k)} is not an earlier step's number (steps are numbered from 1; this is step ${i + 1})`);
		need(new Set(b).size === b.length, `${where}.buildsOn names a step twice`);
		if (b.length) out.buildsOn = b as number[];
	}
	need(Array.isArray(r.hunks) && r.hunks.length > 0, `${where}.hunks must list at least one hunk`);
	const hs = r.hunks as unknown[];
	need(hs.length <= SHOW_CHANGES_LIMITS.hunksPerStep, `${where}.hunks: at most ${SHOW_CHANGES_LIMITS.hunksPerStep}`);
	hs.forEach((x, j) => {
		const h = hunk(x, `${where}.hunks[${j}]`);
		const key = hunkRefKey(h);
		const first = seen.get(key);
		need(first === undefined, `${where}.hunks[${j}] (${h.path}${h.newStart ?? h.oldStart ? ` @${h.newStart ?? h.oldStart}` : ""}) is already in step ${(first ?? 0) + 1}: each hunk belongs to exactly one step`);
		seen.set(key, i);
		out.hunks.push(h);
	});
	return out;
}

/** The parameters, checked. Throws ShowChangesError naming the first problem. */
export function checkShowChangesParams(params: unknown): ShowChangesRequest {
	need(isRecord(params), "The parameters must be an object");
	const p = params as Record<string, unknown>;
	onlyKeys(p, ["scope", "commit", "worktree", "title", "paths", "steps"], "show_changes");
	need(
		typeof p.scope === "string" && (SHOW_CHANGES_SCOPE_KINDS as readonly string[]).includes(p.scope),
		`scope must be one of ${SHOW_CHANGES_SCOPE_KINDS.join(", ")}`,
	);
	const req: ShowChangesRequest = { scope: p.scope as ShowChangesScopeKind };
	if (req.scope === "commit") {
		const c = text(p.commit, "commit (required with scope commit)");
		need(!c.startsWith("-") && !/[\s\0]/.test(c), `commit must be a commit-ish such as a sha or "HEAD~1": ${JSON.stringify(p.commit)}`);
		req.commit = c;
		need(p.worktree === undefined, 'worktree is for scope dirty or worktree; with scope commit, name the commit only');
	} else {
		need(p.commit === undefined, `commit is only for scope commit (this call has scope ${req.scope})`);
		if (p.worktree !== undefined) req.worktree = text(p.worktree, "worktree");
	}
	if (p.title !== undefined) req.title = text(p.title, "title");
	if (p.paths !== undefined) {
		need(Array.isArray(p.paths), "paths must be an array of repo-relative files or directories");
		const ps = p.paths as unknown[];
		need(ps.length <= SHOW_CHANGES_LIMITS.paths, `paths: at most ${SHOW_CHANGES_LIMITS.paths}`);
		const out = [...new Set(ps.map((x, i) => repoPath(x, `paths[${i}]`, true)))];
		if (out.length) req.paths = out;
	}
	if (p.steps !== undefined) {
		need(Array.isArray(p.steps), "steps must be an array");
		const ss = p.steps as unknown[];
		need(ss.length <= SHOW_CHANGES_LIMITS.steps, `steps: at most ${SHOW_CHANGES_LIMITS.steps}`);
		const seen = new Map<string, number>();
		const out = ss.map((s, i) => step(s, i, seen));
		if (out.length) req.steps = out;
	}
	return req;
}
