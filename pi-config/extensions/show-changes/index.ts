/**
 * show-changes: the `show_changes` tool. The agent calls it when the user asks to see what changed;
 * it resolves which changes (uncommitted work, a worktree's branch against its base, or one
 * commit) with read-only git, checks the agent's steps for shape and then against the diff's hunks
 * (hunks.ts, coverage.ts: a diff of more than one hunk opens only when the steps place every hunk),
 * and returns a short text for the model plus `details` (details.ts) that Sova renders as a card
 * opening its changes viewer, which places the hunks the same way.
 *
 * Local sessions only: a session whose tools run on a remote target has no local repository.
 */
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activeTrees, restoreActive } from "../worktrees/state.ts";
import { normalizeShowChangesDetails, scopeLine, SHOW_CHANGES_LIMITS, SHOW_CHANGES_TOOL, type ShowChangesDetails } from "./details.ts";
import { coverageRefusal, placeSteps } from "./coverage.ts";
import { REVIEW_LIMITS } from "../worktrees/git.ts";
import { knownRoots, sessionFolderCandidates } from "./folders.ts";
import { changedFiles, type Git, inPaths, type KnownTree, pickDir, resolveScope, runGit, unknownFolderRefusal } from "./git.ts";
import { readHunks } from "./hunks.ts";
import { checkShowChangesParams, ShowChangesError } from "./input.ts";

/** remote/workers.ts: a session on a target runs its tools there. */
const REMOTE_SESSION_EVENT = "remote:session";
const REMOTE_DISCOVER_EVENT = "remote:discover";

/** How many changed files the reply lists by name. */
const LIST_FILES = 40;

export const SHOW_CHANGES_DESCRIPTION = `Open Sova's changes viewer for the user on git changes: a file tree, the change as numbered steps, one diff at a time. Read-only.

When the diff has more than one hunk, every hunk must be in exactly one step, or the call is refused, opening nothing, with the hunks still to place. Read the diff first with plain \`git diff\` or \`git show\` (default context, never -U0): a hunk's numbers are in its @@ -a,b +c,d @@ header.

Example: {"scope": "worktree", "title": "Rate limits on the export API", "steps": [{"title": "Token bucket", "why": "one limiter shared by every route", "hunks": [{"path": "server/limit.ts"}]}, {"title": "Apply it to /export", "hunks": [{"path": "server/routes.ts", "newStart": 120}, {"path": "server/routes.test.ts"}]}]}`;

export const SHOW_CHANGES_PROMPT_SNIPPET = "Show the user git changes in Sova's changes viewer";

export const SHOW_CHANGES_GUIDELINES = [
	"When the user asks to see or review changes, call show_changes rather than pasting a diff, then reply in a sentence or two.",
	"show_changes shows only git changes in this session's checkout or its tracked worktrees. If the change is anywhere else or not in git yet, write it into a tracked worktree first (the worktree tool can create one), or tell the user there is no diff to show.",
];

const Hunk = Type.Object(
	{
		path: Type.String({ minLength: 1, description: "Repo-relative (a rename's new path)." }),
		oldStart: Type.Optional(Type.Integer({ minimum: 0, description: "Any old-side line inside the hunk, instead of newStart." })),
		newStart: Type.Optional(Type.Integer({ minimum: 0, description: "Any new-side line inside the hunk, e.g. c from @@ -a,b +c,d @@. Omit for all of the file's hunks." })),
	},
	{ additionalProperties: false },
);

const Step = Type.Object(
	{
		title: Type.String({ minLength: 1, description: 'Short: "Token bucket limiter".' }),
		why: Type.Optional(Type.String({ minLength: 1, description: "Why, in a sentence." })),
		hunks: Type.Array(Hunk, { minItems: 1, maxItems: SHOW_CHANGES_LIMITS.hunksPerStep, description: "{path} for all of a file's hunks, {path, newStart} for one." }),
	},
	{ additionalProperties: false },
);

export const SHOW_CHANGES_PARAMETERS = Type.Object(
	{
		scope: StringEnum(["dirty", "worktree", "commit"] as const, {
			description: "dirty: uncommitted work vs HEAD, untracked files included. worktree: a branch vs its base branch. commit: one commit vs its parent.",
		}),
		commit: Type.Optional(Type.String({ minLength: 1, description: 'For scope commit: a sha or "HEAD".' })),
		worktree: Type.Optional(Type.String({ minLength: 1, description: "For scope dirty or worktree: this session's checkout (the default) or a tracked worktree, by branch or path. The viewer opens no other folder." })),
		title: Type.Optional(Type.String({ minLength: 1, description: "One line naming the change." })),
		paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: SHOW_CHANGES_LIMITS.paths, description: "Show only these repo-relative files or folders." })),
		steps: Type.Optional(Type.Array(Step, { maxItems: SHOW_CHANGES_LIMITS.steps, description: "The change in reading order, one reviewable idea per step. Required when the diff has more than one hunk." })),
	},
	{ additionalProperties: false },
);

export interface ShowChangesOptions {
	git?: Git;
	/** The agent dir of the Sova server hosting this chat, where remote targets' placeholders live (default serverAgentDir). */
	agentDir?: () => string;
}

/**
 * The agent dir of the Sova server hosting this chat, the one the viewer's check uses. A chat runs
 * with the server's agent dir, except a worker given its own: Sova then names the server's state
 * root (<agent dir>/sova) in SOVA_CHAT_STATE_ROOT. Outside Sova, pi's own.
 */
export function serverAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.SOVA_CHAT_STATE_ROOT ? dirname(env.SOVA_CHAT_STATE_ROOT) : getAgentDir();
}

/** The session's active tracked worktrees (the worktrees extension's entry on this branch). */
function knownTrees(ctx: ExtensionContext): KnownTree[] {
	try {
		return activeTrees(restoreActive(ctx.sessionManager.getBranch())).map((t) => ({
			path: t.path,
			branch: t.branch,
			base: t.base,
			...(t.baseBranch ? { baseBranch: t.baseBranch } : {}),
		}));
	} catch {
		return [];
	}
}

/**
 * The folders the viewer opens for this session (folders.ts, the rule Sova's diff endpoint uses):
 * read from the session header's cwd and every entry in the file, all branches, as the viewer
 * reads the file. A remote target's local placeholder (<agent dir>/sova/targets/…) is never one.
 */
function sessionRoots(ctx: ExtensionContext, agentDir: string): string[] {
	const sm = ctx.sessionManager;
	let cwd: unknown = ctx.cwd;
	let entries: readonly unknown[] = [];
	try {
		const header = sm.getHeader?.();
		if (header) cwd = header.cwd;
		entries = sm.getEntries?.() ?? sm.getBranch();
	} catch {
		// an unreadable session: its folder alone
	}
	return knownRoots(sessionFolderCandidates(cwd, entries), agentDir);
}

/** The refusal for a comparison with no changed file: the agent tells the user instead of opening an empty card. */
export function emptyRefusal(scope: string, paths?: readonly string[]): string {
	return `No changes in this comparison (${scope}${paths ? `, limited to ${paths.join(", ")}` : ""}), so nothing was shown. Tell the user nothing changed there.`;
}

/** The reply the model reads: what opened, the files, and how many hunks the steps placed. */
export function replyText(details: ShowChangesDetails, files: readonly string[], hunks: number): string {
	const lines = [`Opened the changes viewer for the user: ${scopeLine(details.scope)}${details.paths ? `, limited to ${details.paths.join(", ")}` : ""}.`];
	lines.push(`${files.length} changed file${files.length === 1 ? "" : "s"}:`);
	for (const f of files.slice(0, LIST_FILES)) lines.push(`  ${f}`);
	if (files.length > LIST_FILES) lines.push(`  … and ${files.length - LIST_FILES} more`);
	const h = `${hunks} hunk${hunks === 1 ? "" : "s"}`;
	if (details.steps) lines.push(`${details.steps.length} step${details.steps.length === 1 ? "" : "s"}; every hunk (${h}) is placed in a step.`);
	else if (hunks) lines.push(`${h}, no steps needed.`);
	lines.push("The user sees the diff in the viewer; don't repeat it.");
	return lines.join("\n");
}

/** One dim line naming what opened; expanded, the steps too. Unreadable details fall back to the text's first line. */
export function renderShowChangesResult(result: { content?: unknown; details?: unknown }, expanded: boolean, theme: Theme): Component {
	const d = normalizeShowChangesDetails(result.details);
	if (!d) {
		const first = Array.isArray(result.content) ? (result.content as { text?: unknown }[]).find((c) => typeof c?.text === "string") : undefined;
		return new Text(theme.fg("dim", String(first?.text ?? "").split("\n")[0] ?? ""), 0, 0);
	}
	const head = `${d.title ? `${d.title} · ` : ""}${scopeLine(d.scope)}${d.steps ? ` · ${d.steps.length} step${d.steps.length === 1 ? "" : "s"}` : ""} · open it in Sova`;
	if (!expanded || !d.steps) return new Text(theme.fg("dim", head), 0, 0);
	const steps = d.steps.map((s, i) => `  ${i + 1}. ${s.title} · ${s.hunks.length} ref${s.hunks.length === 1 ? "" : "s"}`);
	return new Text(theme.fg("dim", [head, ...steps].join("\n")), 0, 0);
}

export default function showChanges(pi: ExtensionAPI, options: ShowChangesOptions = {}) {
	const git = options.git ?? runGit;
	const agentDir = options.agentDir ?? (() => serverAgentDir());
	let remote = false;

	pi.events?.on(REMOTE_SESSION_EVENT, () => {
		remote = true;
	});
	pi.on("session_start", async () => {
		pi.events?.emit(REMOTE_DISCOVER_EVENT, { version: 1 });
	});

	pi.registerTool({
		name: SHOW_CHANGES_TOOL,
		label: "Show changes",
		// Its card is drawn from this tool's recorded result, which a codemode script's call never has.
		exposure: "model-only",
		description: SHOW_CHANGES_DESCRIPTION,
		promptSnippet: SHOW_CHANGES_PROMPT_SNIPPET,
		promptGuidelines: SHOW_CHANGES_GUIDELINES,
		parameters: SHOW_CHANGES_PARAMETERS,
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			try {
				if (remote) throw new ShowChangesError("show_changes is local only; this session runs its tools on a remote target");
				const req = checkShowChangesParams(params);
				const { dir, tree } = pickDir(req, ctx.cwd, knownTrees(ctx));
				// The viewer opens only folders the session knows: refuse any other rather than open a card it would refuse.
				const unknown = unknownFolderRefusal(dir, sessionRoots(ctx, agentDir()));
				if (unknown) throw new ShowChangesError(unknown);
				const scope = await resolveScope(git, req, dir, tree);
				const all = await changedFiles(git, scope);
				const files = all.filter((f) => inPaths(f, req.paths));
				// An empty card helps no one: refuse, and have the agent say so instead.
				if (files.length === 0) throw new ShowChangesError(emptyRefusal(scopeLine(scope), req.paths), true);
				// The viewer lists at most maxFiles (after the same paths filter): past it, refuse rather than open a cut list.
				if (files.length > REVIEW_LIMITS.maxFiles) {
					throw new ShowChangesError(
						`${files.length} files changed${req.paths ? " within the paths given" : ""}, more than the ${REVIEW_LIMITS.maxFiles} the viewer shows: narrow it with paths (the folders or files to review)`,
					);
				}
				// The steps against the hunks the viewer will show: refuse unless they place them all.
				const diff = (await readHunks(git, scope)).filter((f) => inPaths(f.path, req.paths));
				const refusal = coverageRefusal(req.steps, diff);
				if (refusal) throw new ShowChangesError(refusal, true);
				const hunks = placeSteps([], diff).units;
				const built: ShowChangesDetails = {
					v: 1,
					scope,
					...(req.title ? { title: req.title } : {}),
					...(req.paths ? { paths: req.paths } : {}),
					...(req.steps ? { steps: req.steps } : {}),
				};
				// The stored shape must pass the readers' own check, or Sova would show nothing.
				const details = normalizeShowChangesDetails(built);
				if (!details) throw new ShowChangesError("the call produced details Sova could not read; simplify the steps");
				return { content: [{ type: "text" as const, text: replyText(details, files, hunks) }], details };
			} catch (error) {
				if (error instanceof ShowChangesError) throw new Error(error.complete ? error.message : `${error.message}. Nothing was shown.`);
				throw error;
			}
		},
		renderCall: (args, theme) => {
			const a = args as { scope?: string; commit?: string; worktree?: string; steps?: unknown[] };
			const what = a.scope === "commit" ? `commit ${a.commit ?? "?"}` : `${a.scope ?? "?"}${a.worktree ? ` ${a.worktree}` : ""}`;
			const steps = Array.isArray(a.steps) && a.steps.length ? theme.fg("dim", ` · ${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("show_changes "))}${what}${steps}`, 0, 0);
		},
		renderResult: (result, options, theme) => renderShowChangesResult(result, options.expanded, theme),
	});
}
