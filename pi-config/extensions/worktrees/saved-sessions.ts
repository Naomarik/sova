/**
 * Saved sessions in a branch's history: the merge guard. Sova keeps saved conversations on their own
 * side branch, never in the code; a card that reached a code branch anyway (copied in by hand) would
 * land in the target's history with the merge, readable by anyone who clones it even if a later commit
 * deleted it. So a merge first scans every commit it would bring in (`<merge-base>..<branch>`) for a
 * card, found by its marker string (git log -S), never only by a path, and stops unless overridden.
 *
 * Node builtins only, git by argv: the `worktree` tool's merge and Sova's server (Merge Branch, main
 * detection) both import it.
 */
import type { Git } from "./git.ts";

/** The marker every saved session's card and README carry (Sova's SAVED_SESSION_MARKER; a test pins them
    equal). Spelled in two parts so no source file holds it whole: the guard searches history for it, and a
    file carrying it would read as a saved session itself. */
export const SAVED_SESSION_MARKER = ["sova-saved-session", "v1"].join("/");

/** One commit the merge would bring in that adds, changes or deletes a saved session's files. */
export interface SavedSessionCommit {
	sha: string;
	subject: string;
	/** The files in it whose marker count changed. */
	paths: string[];
}

/** The commits in `range` (a `git log` revision range such as `base..branch`) whose diff adds or
    removes the marker: a card written, copied, changed or deleted. Oldest last, as git log lists them. */
export async function savedSessionsInRange(git: Git, cwd: string, range: string[]): Promise<SavedSessionCommit[]> {
	const sep = "\u001e";
	const r = await git(["log", "--no-color", "--no-renames", `--format=${sep}%H%x00%s`, "--name-only", "-S", SAVED_SESSION_MARKER, ...range, "--"], cwd);
	if (r.code !== 0) throw new Error(`git log failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
	const out: SavedSessionCommit[] = [];
	for (const block of r.stdout.split(sep)) {
		if (!block.trim()) continue;
		const [head, ...rest] = block.split("\n");
		const nul = head!.indexOf("\0");
		const sha = head!.slice(0, nul);
		if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
		out.push({ sha, subject: head!.slice(nul + 1), paths: rest.map((l) => l.trim()).filter(Boolean) });
	}
	return out;
}

/** What merging `branchSha` into `targetSha` would bring in: the commits since their merge base (all of
    the branch's history when they share none). */
export async function savedSessionsToMerge(git: Git, cwd: string, branchSha: string, targetSha: string): Promise<SavedSessionCommit[]> {
	return savedSessionsInRange(git, cwd, [branchSha, `^${targetSha}`]);
}

/** The refusal a guarded merge gives, naming the commits. Its last sentence is for its reader: the agent is told
    it needs cleaning or the user's go-ahead (who is asked to confirm), the operator is offered Merge Anyway. */
export function savedSessionsRefusal(branch: string, commits: SavedSessionCommit[], audience: "agent" | "operator" = "agent"): string {
	const shown = commits.slice(0, 3).map((c) => `${c.sha.slice(0, 7)} ${c.subject}${c.paths.length ? ` (${c.paths.slice(0, 2).join(", ")}${c.paths.length > 2 ? ", …" : ""})` : ""}`);
	const more = commits.length > shown.length ? `; and ${commits.length - shown.length} more` : "";
	return (
		`This branch's history carries saved sessions: ${branch} has ${commits.length} commit${commits.length === 1 ? "" : "s"} adding, changing or removing a saved conversation (${shown.join("; ")}${more}). ` +
		"Merging would put those conversations in the target's history, even ones a later commit deleted. Nothing was merged. " +
		(audience === "operator"
			? "Move the work to a branch without them, or press Merge Anyway."
			: "This needs the saved sessions cleaned out of the branch's history (the work re-applied on a fresh branch), or the user's explicit go-ahead; if the user wants it merged anyway, the user is asked to confirm.")
	);
}

export class SavedSessionsInHistoryError extends Error {
	readonly branch: string;
	readonly commits: SavedSessionCommit[];
	constructor(branch: string, commits: SavedSessionCommit[]) {
		super(savedSessionsRefusal(branch, commits));
		this.branch = branch;
		this.commits = commits;
	}
}
