/**
 * Which folders Sova's changes viewer opens for a session: one rule, shared by the `show_changes`
 * tool (so it never reports a card the viewer would refuse) and Sova's diff endpoint, which imports
 * this file. A folder is known when it is at or below a root: the session's own folder (its
 * header's cwd), its workers' folders, every worktree any `worktrees` entry names (any status), and
 * every merge card's folder. Roots must be absolute; a remote target's local placeholder is never
 * one. Paths are compared canonical, so a symlink is judged by where it leads.
 *
 * Node builtins and pure siblings only (Sova's server imports it): no pi runtime.
 */
import { dirname, isAbsolute, normalize, sep } from "node:path";
import { placeholderRoot } from "../remote/argv.ts";
import { readWorkerManifests } from "../subagents/worker-transcript.ts";
import { canonical, isWithin, normalizeActive, normalizeMergeDetails, WORKTREE_MERGE_MESSAGE, WORKTREES_ENTRY_TYPE } from "../worktrees/state.ts";

/**
 * The roots, from candidates in the caller's order (the session's folder first, then its workers',
 * then worktrees and merge cards in file order; a reader that tries roots in turn takes that
 * order). Anything not an absolute path is dropped, and so is a remote target's local placeholder
 * (under `<agentDir>/sova/targets/`, the remote extension's layout): the folder is on the target,
 * not here. Repeats are kept once.
 */
export function knownRoots(candidates: readonly unknown[], agentDir: string): string[] {
	const targets = dirname(placeholderRoot(agentDir, "x")) + sep;
	const roots: string[] = [];
	for (const p of candidates) {
		if (typeof p !== "string" || !isAbsolute(p) || p.startsWith(targets)) continue;
		const root = normalize(p).replace(/\/+$/, "") || "/";
		if (!roots.includes(root)) roots.push(root);
	}
	return roots;
}

/** True when `dir` is at or below one of `roots`, both compared canonical. */
export function folderKnown(dir: string, roots: readonly string[]): boolean {
	const at = canonical(dir);
	return roots.some((r) => isWithin(at, canonical(r)));
}

/**
 * The candidate roots of a session from its raw entries (pi's shapes: `custom` entries carry `data`,
 * `custom_message` entries `details`), for the tool, which reads its own session. `cwd` is the
 * session header's cwd. Order as `knownRoots` takes it.
 */
export function sessionFolderCandidates(cwd: unknown, entries: readonly unknown[]): unknown[] {
	const out: unknown[] = [cwd];
	try {
		for (const m of readWorkerManifests(entries).manifests.values()) {
			const c = m.spec?.cwd;
			if (c && !out.includes(c)) out.push(c);
		}
	} catch {
		// unreadable worker records: the other roots still stand
	}
	for (const raw of entries) {
		const e = raw as { type?: unknown; customType?: unknown; data?: unknown; details?: unknown } | null;
		if (e?.type === "custom" && e.customType === WORKTREES_ENTRY_TYPE) {
			for (const t of normalizeActive(e.data)?.trees ?? []) out.push(t.path);
		} else if (e?.type === "custom_message" && e.customType === WORKTREE_MERGE_MESSAGE) {
			const m = normalizeMergeDetails(e.details);
			if (m) out.push(m.path);
		}
	}
	return out;
}
