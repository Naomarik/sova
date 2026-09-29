/**
 * The `show_changes` tool's contract: its name, the versioned shape of each result's `details`
 * (which changes to show, optional path filter, optional agent-written steps) and the strict check
 * `normalizeShowChangesDetails` that every reader runs before trusting stored data.
 *
 * Imports nothing at all: Sova's server and its frontend import this file (Vite bundles it for the
 * browser), so both read one shape. Nothing here throws on odd stored data.
 *
 * The tool resolves the scope, checks the steps' shape, and refuses steps that don't place every
 * hunk of the diff (coverage.ts). Sova matches them again when it draws the diff, assigning every
 * hunk to exactly one step (the first ref that matches it), leftovers under "Other changes".
 */

/** The tool's name, in the loadout and on every tool result. */
export const SHOW_CHANGES_TOOL = "show_changes";
/** Version of the tool result's `details`. */
export const SHOW_CHANGES_DETAILS_VERSION = 1;

/** Caps on what a call may carry; the tool rejects more, the normalizer refuses more. */
export const SHOW_CHANGES_LIMITS = { paths: 200, steps: 100, hunksPerStep: 400, text: 2000 } as const;

export type ShowChangesScopeKind = "dirty" | "worktree" | "commit";
export const SHOW_CHANGES_SCOPE_KINDS: readonly ShowChangesScopeKind[] = ["dirty", "worktree", "commit"];

/**
 * What to diff, named the way Sova's diff endpoint names it (shared/protocol.ts `DiffScope`, minus
 * `sessionPath`, which the reader adds from the session it renders): `cwd` / `worktreePath` /
 * `repoPath` is the directory the tool read (the tracked worktree's path, or the session cwd), so
 * it is always a folder the session knows. `root` is that repository's canonical top level. The
 * shas are full object names resolved when the tool ran; Sova re-resolves the scope when it loads
 * the diff, so they say what the agent saw, not what is shown.
 * - dirty: the index and working tree, untracked files included, against HEAD (`head`, then).
 * - worktree: the branch against its merge-base (`base`) with `baseRef` (the tracked worktree's
 *   base branch, else master, else main, else origin/HEAD's target such as "origin/main"; else the
 *   tracked base commit's short sha). Once the branch is merged, `base` is where what its merge
 *   brought in starts and `baseRef` names it, e.g. "master before 4ef9f18" or "f686546 (created from)".
 * - commit: one commit against its first parent (`parent`; absent for a root commit, whose
 *   diff is against the empty tree).
 */
export type ShowChangesScope =
	| { kind: "dirty"; cwd: string; root: string; head: string }
	| { kind: "worktree"; worktreePath: string; root: string; branch: string; head: string; base: string; baseRef: string }
	| { kind: "commit"; repoPath: string; root: string; sha: string; parent?: string };

/**
 * One hunk, or every hunk of a file. `path` is repo-relative (posix, the diff's new path; the old
 * path for a deletion). `oldStart`/`newStart` are the numbers of the hunk's `@@ -a,b +c,d @@`
 * header (a and c); with neither, the ref means every hunk of that file. Sova gives each real
 * hunk to the first step (in order) holding a ref that matches it.
 */
export interface ShowChangesHunkRef {
	path: string;
	oldStart?: number;
	newStart?: number;
}

export interface ShowChangesStep {
	title: string;
	why?: string;
	/** 1-based numbers of earlier steps this one builds on. */
	buildsOn?: number[];
	hunks: ShowChangesHunkRef[];
}

export interface ShowChangesDetails {
	v: 1;
	scope: ShowChangesScope;
	/** The agent's one-line heading for the change, e.g. "Rate limiting for the export API". */
	title?: string;
	/** Repo-relative posix paths or directory prefixes the view is limited to. */
	paths?: string[];
	steps?: ShowChangesStep[];
}

// ── Checks shared by the tool's input validation and the normalizer ──────────

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isSha = (v: unknown): v is string => typeof v === "string" && SHA.test(v);

/**
 * A repo-relative posix path: not empty, not absolute, no backslash, NUL or newline, no "." or ".."
 * segment, no empty segment except one trailing "/" (a directory prefix).
 */
export function isRepoPath(v: unknown): v is string {
	if (typeof v !== "string" || v === "" || v.length > 4096) return false;
	if (v.startsWith("/") || /[\\\0\n\r]/.test(v)) return false;
	const segs = (v.endsWith("/") ? v.slice(0, -1) : v).split("/");
	return segs.every((s) => s !== "" && s !== "." && s !== "..");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= SHOW_CHANGES_LIMITS.text;
const lineNo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;
const absolute = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !/[\0\n\r]/.test(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).every((k) => keys.includes(k) || v[k] === undefined);

/** A hunk ref's identity, for "no ref twice": the path plus its numbers. */
export const hunkRefKey = (h: ShowChangesHunkRef): string => `${h.path}\0${h.oldStart ?? ""}\0${h.newStart ?? ""}`;

// ── The normalizer ───────────────────────────────────────────────────────────

function normScope(v: unknown): ShowChangesScope | undefined {
	if (!isRecord(v) || !absolute(v.root)) return undefined;
	switch (v.kind) {
		case "dirty":
			if (!onlyKeys(v, ["kind", "cwd", "root", "head"]) || !absolute(v.cwd) || !isSha(v.head)) return undefined;
			return { kind: "dirty", cwd: v.cwd, root: v.root, head: v.head };
		case "worktree":
			if (!onlyKeys(v, ["kind", "worktreePath", "root", "branch", "head", "base", "baseRef"]) || !absolute(v.worktreePath)) return undefined;
			if (!nonEmpty(v.branch) || !isSha(v.head) || !isSha(v.base) || !nonEmpty(v.baseRef)) return undefined;
			return { kind: "worktree", worktreePath: v.worktreePath, root: v.root, branch: v.branch, head: v.head, base: v.base, baseRef: v.baseRef };
		case "commit": {
			if (!onlyKeys(v, ["kind", "repoPath", "root", "sha", "parent"]) || !absolute(v.repoPath) || !isSha(v.sha)) return undefined;
			if (v.parent !== undefined && !isSha(v.parent)) return undefined;
			const out: ShowChangesScope = { kind: "commit", repoPath: v.repoPath, root: v.root, sha: v.sha };
			if (v.parent !== undefined) out.parent = v.parent;
			return out;
		}
		default:
			return undefined;
	}
}

function normHunk(v: unknown): ShowChangesHunkRef | undefined {
	if (!isRecord(v) || !onlyKeys(v, ["path", "oldStart", "newStart"]) || !isRepoPath(v.path) || v.path.endsWith("/")) return undefined;
	const out: ShowChangesHunkRef = { path: v.path };
	if (v.oldStart !== undefined) {
		if (!lineNo(v.oldStart)) return undefined;
		out.oldStart = v.oldStart;
	}
	if (v.newStart !== undefined) {
		if (!lineNo(v.newStart)) return undefined;
		out.newStart = v.newStart;
	}
	return out;
}

function normStep(v: unknown, index: number, seen: Set<string>): ShowChangesStep | undefined {
	if (!isRecord(v) || !onlyKeys(v, ["title", "why", "buildsOn", "hunks"]) || !nonEmpty(v.title)) return undefined;
	if (!Array.isArray(v.hunks) || v.hunks.length === 0 || v.hunks.length > SHOW_CHANGES_LIMITS.hunksPerStep) return undefined;
	const hunks: ShowChangesHunkRef[] = [];
	for (const x of v.hunks) {
		const h = normHunk(x);
		if (!h || seen.has(hunkRefKey(h))) return undefined;
		seen.add(hunkRefKey(h));
		hunks.push(h);
	}
	const out: ShowChangesStep = { title: v.title, hunks };
	if (v.why !== undefined) {
		if (!nonEmpty(v.why)) return undefined;
		out.why = v.why;
	}
	if (v.buildsOn !== undefined) {
		const n = index + 1;
		const b = v.buildsOn;
		if (!Array.isArray(b) || !b.every((k) => Number.isInteger(k) && k >= 1 && k < n) || new Set(b).size !== b.length) return undefined;
		out.buildsOn = [...(b as number[])];
	}
	return out;
}

/** A tool result's details, checked; a fresh object, or undefined when anything is off. */
export function normalizeShowChangesDetails(v: unknown): ShowChangesDetails | undefined {
	try {
		if (!isRecord(v) || v.v !== SHOW_CHANGES_DETAILS_VERSION || !onlyKeys(v, ["v", "scope", "title", "paths", "steps"])) return undefined;
		const scope = normScope(v.scope);
		if (!scope) return undefined;
		const out: ShowChangesDetails = { v: 1, scope };
		if (v.title !== undefined) {
			if (!nonEmpty(v.title)) return undefined;
			out.title = v.title;
		}
		if (v.paths !== undefined) {
			const p = v.paths;
			if (!Array.isArray(p) || p.length === 0 || p.length > SHOW_CHANGES_LIMITS.paths || !p.every(isRepoPath)) return undefined;
			out.paths = [...(p as string[])];
		}
		if (v.steps !== undefined) {
			const s = v.steps;
			if (!Array.isArray(s) || s.length === 0 || s.length > SHOW_CHANGES_LIMITS.steps) return undefined;
			const seen = new Set<string>();
			const steps: ShowChangesStep[] = [];
			for (let i = 0; i < s.length; i++) {
				const step = normStep(s[i], i, seen);
				if (!step) return undefined;
				steps.push(step);
			}
			out.steps = steps;
		}
		return out;
	} catch {
		return undefined;
	}
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** One line naming the scope: "uncommitted changes in /r", "feat/x vs master (abc1234..def5678)", "commit abc1234". */
export function scopeLine(scope: ShowChangesScope): string {
	const short = (sha: string) => sha.slice(0, 7);
	switch (scope.kind) {
		case "dirty":
			return `uncommitted changes vs HEAD ${short(scope.head)} in ${scope.root}`;
		case "worktree":
			return `${scope.branch} vs ${scope.baseRef} (${short(scope.base)}..${short(scope.head)}) in ${scope.root}`;
		case "commit":
			return `commit ${short(scope.sha)}${scope.parent ? ` vs ${short(scope.parent)}` : " (root commit)"} in ${scope.root}`;
	}
}
