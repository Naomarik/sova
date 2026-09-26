/**
 * Pure worktrees-state handling. Node builtins only, no pi imports: unit-testable with node --test
 * and imported by Sova's server (server/worktrees-state.ts) and by the subagents extension (its
 * spawn gate folds the branch itself), so it must stay runtime-free.
 *
 * `WorktreesActive` is one session's set of git worktrees, carried WHOLE in every `worktrees`
 * custom entry. The newest usable entry on the branch wins (`restoreActive`), the same rule as
 * mode/state.ts and sandbox/state.ts, so tree navigation, forks and rewinds move the set with the
 * branch and the server and the extension cannot disagree.
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/** The custom-entry type the extension appends on every change. */
export const WORKTREES_ENTRY_TYPE = "worktrees";
/** The extension message (custom_message) of a recorded merge: the transcript's merge card. */
export const WORKTREE_MERGE_MESSAGE = "worktree-merge";

/**
 * Event-bus names (pi.events): the sandbox reads the set to make active worktrees writable roots.
 * `state` is emitted on session_start, on every change and on branch navigation, and again
 * whenever someone emits `discover`.
 */
export const WORKTREES_STATE_EVENT = "worktrees:state";
export const WORKTREES_DISCOVER_EVENT = "worktrees:discover";

export type WorktreeStatus = "active" | "dropped" | "merged";
export const STATUSES: readonly WorktreeStatus[] = ["active", "dropped", "merged"];

/** How a merge was recorded: made by the `worktree merge` tool, or seen after a turn (plain git). */
export type MergeHow = "tool" | "detected";

export interface WorktreeMerge {
	/** The branch merged into. */
	target: string;
	/** The target's commit after the merge. */
	sha: string;
	at: number;
	how: MergeHow;
}

export interface TrackedWorktree {
	/** Canonical (realpath) top level of the worktree. */
	path: string;
	/** Its branch (short name, e.g. `feat/x`). */
	branch: string;
	/** The commit it was based on (create), or its HEAD when attached. */
	base: string;
	/** The branch `base` was taken from, when known: the default merge target for detection. */
	baseBranch?: string;
	status: WorktreeStatus;
	/** Set when status is `merged`. */
	merge?: WorktreeMerge;
	/** Id of the session that created or attached it. Another id here means the set was inherited. */
	session: string;
	how: "created" | "attached";
	at: number;
}

export interface WorktreesActive {
	version: 1;
	trees: TrackedWorktree[];
}

/** What a merge card carries (the custom message's `details`); the content is `mergeNote` of it. */
export interface WorktreeMergeDetails {
	version: 1;
	path: string;
	branch: string;
	target: string;
	sha: string;
	/** Commits the merge brought into the target (reachable from the branch, not from the old target). */
	commits: number;
	added: number;
	removed: number;
	fastForward: boolean;
	how: MergeHow;
}

/** The state event's payload. */
export interface WorktreesStateEvent {
	version: 1;
	/** Canonical paths of the active worktrees. */
	active: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const time = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function normalizeMerge(v: unknown): WorktreeMerge | undefined {
	if (!isRecord(v) || !text(v.target) || !text(v.sha) || !time(v.at) || (v.how !== "tool" && v.how !== "detected")) return undefined;
	return { target: v.target, sha: v.sha, at: v.at, how: v.how };
}

/** One stored worktree, or undefined when any required field is missing or malformed. */
export function normalizeTree(v: unknown): TrackedWorktree | undefined {
	if (!isRecord(v)) return undefined;
	if (!text(v.path) || !isAbsolute(v.path) || !text(v.branch) || !text(v.base) || !text(v.session) || !time(v.at)) return undefined;
	if (!(STATUSES as readonly unknown[]).includes(v.status) || (v.how !== "created" && v.how !== "attached")) return undefined;
	const merge = normalizeMerge(v.merge);
	if (v.status === "merged" && !merge) return undefined;
	return {
		path: v.path,
		branch: v.branch,
		base: v.base,
		...(text(v.baseBranch) ? { baseBranch: v.baseBranch } : {}),
		status: v.status as WorktreeStatus,
		...(v.status === "merged" && merge ? { merge } : {}),
		session: v.session,
		how: v.how,
		at: v.at,
	};
}

/**
 * A stored entry, or undefined for anything this version does not understand. A set with one
 * malformed worktree is refused whole: dropping it would silently widen or narrow the set.
 * Never throws.
 */
export function normalizeActive(value: unknown): WorktreesActive | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.trees)) return undefined;
	const trees: TrackedWorktree[] = [];
	for (const t of value.trees) {
		const tree = normalizeTree(t);
		if (!tree) return undefined;
		trees.push(tree);
	}
	return { version: 1, trees };
}

/**
 * The newest usable `worktrees` entry on a session branch, or undefined when the branch never
 * recorded one. Shared with Sova and the subagents gate, so all three read the set by the same
 * rule. Never throws.
 */
export function restoreActive(entries: readonly { type: string; customType?: string; data?: unknown }[]): WorktreesActive | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== WORKTREES_ENTRY_TYPE) continue;
		const active = normalizeActive(entry.data);
		if (active) return active;
	}
	return undefined;
}

export function activeTrees(set: WorktreesActive | undefined): TrackedWorktree[] {
	return (set?.trees ?? []).filter((t) => t.status === "active");
}

/** The session the tree was inherited from (a fork or fanout copied the entry), or undefined when it is this session's own. */
export function sharedWith(tree: Pick<TrackedWorktree, "session">, sessionId: string | undefined): string | undefined {
	return sessionId && tree.session !== sessionId ? tree.session : undefined;
}

/**
 * Canonical spelling of a path: realpath of the deepest existing ancestor, the rest appended. A
 * symlink into a worktree is judged by where it leads.
 */
export function canonical(path: string): string {
	let head = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			const real = realpathSync.native(head);
			return rest.length ? resolve(real, ...rest.reverse()) : real;
		} catch {
			const parent = dirname(head);
			if (parent === head) return resolve(path);
			rest.push(head.slice(parent === sep ? 1 : parent.length + 1));
			head = parent;
		}
	}
}

/** True when `child` is `root` or below it; both canonical. */
export function isWithin(child: string, root: string): boolean {
	if (child === root) return true;
	return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The active worktree a cwd is in (the deepest, should they nest), or undefined. */
export function treeOf(set: WorktreesActive | undefined, cwd: string): TrackedWorktree | undefined {
	const c = canonical(cwd);
	return activeTrees(set)
		.filter((t) => isWithin(c, canonical(t.path)))
		.sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Why a worker must not start in `cwd`: it is neither at or below the session's cwd nor inside
 * one of the set's active worktrees. Undefined means it may start. Both paths are compared
 * canonical, so a symlink cannot smuggle a worker out.
 */
export function workerCwdRefusal(req: { sessionCwd: string; cwd: string; set: WorktreesActive | undefined }): string | undefined {
	const c = canonical(req.cwd);
	if (isWithin(c, canonical(req.sessionCwd))) return undefined;
	if (treeOf(req.set, c)) return undefined;
	const names = activeTrees(req.set).map((t) => t.path);
	return `Worktrees: worker cwd ${c} is outside this session's cwd and its worktrees (${names.length ? names.join(", ") : "none tracked"}). Start it in the session cwd or inside an active worktree; the parent agent can track one with the worktree tool.`;
}

/** A new set with `tree` in it, replacing a tree at the same path. Never mutates the input. */
export function withTree(set: WorktreesActive | undefined, tree: TrackedWorktree): WorktreesActive {
	const trees = (set?.trees ?? []).filter((t) => t.path !== tree.path);
	return { version: 1, trees: [...trees, tree] };
}

/** Short commit id as shown in notes and cards. */
export function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

/** The one line the model reads for a merge (the custom message's content), and the card's summary. */
export function mergeNote(d: Pick<WorktreeMergeDetails, "branch" | "target" | "sha" | "commits" | "added" | "removed">): string {
	return `Merged ${d.branch} into ${d.target} at ${shortSha(d.sha)}, ${d.commits} commit${d.commits === 1 ? "" : "s"}, +${d.added} −${d.removed}`;
}

/** Decode a merge card's details, or undefined for anything this version does not understand. Never throws. */
export function normalizeMergeDetails(v: unknown): WorktreeMergeDetails | undefined {
	if (!isRecord(v) || v.version !== 1) return undefined;
	if (!text(v.path) || !text(v.branch) || !text(v.target) || !text(v.sha)) return undefined;
	const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : undefined);
	const commits = n(v.commits);
	const added = n(v.added);
	const removed = n(v.removed);
	if (commits === undefined || added === undefined || removed === undefined || typeof v.fastForward !== "boolean") return undefined;
	if (v.how !== "tool" && v.how !== "detected") return undefined;
	return { version: 1, path: v.path, branch: v.branch, target: v.target, sha: v.sha, commits, added, removed, fastForward: v.fastForward, how: v.how };
}

/** The status word shown for a worktree: "active", "dropped", "merged into master at abc1234". */
export function statusText(t: Pick<TrackedWorktree, "status" | "merge">): string {
	if (t.status === "merged" && t.merge) return `merged into ${t.merge.target} at ${shortSha(t.merge.sha)}`;
	return t.status;
}
