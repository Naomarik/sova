/**
 * show-changes: the `show_changes` tool. The agent calls it when the user asks to see what changed;
 * it resolves which changes (uncommitted work, a worktree's branch against its base, or one
 * commit) with read-only git, checks the agent's optional steps for shape, and returns a short
 * text for the model plus `details` (details.ts) that Sova renders as a card opening its changes
 * viewer. It computes no diff: Sova loads the diff and gives each hunk to one step.
 *
 * Local sessions only: a session whose tools run on a remote target has no local repository.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activeTrees, restoreActive } from "../worktrees/state.ts";
import { normalizeShowChangesDetails, scopeLine, SHOW_CHANGES_LIMITS, SHOW_CHANGES_TOOL, type ShowChangesDetails } from "./details.ts";
import { changedFiles, type Git, inPaths, type KnownTree, pickDir, resolveScope, runGit } from "./git.ts";
import { checkShowChangesParams, ShowChangesError } from "./input.ts";

/** remote/workers.ts: a session on a target runs its tools there. */
const REMOTE_SESSION_EVENT = "remote:session";
const REMOTE_DISCOVER_EVENT = "remote:discover";

/** How many changed files the reply lists by name. */
const LIST_FILES = 40;

export const SHOW_CHANGES_DESCRIPTION = `Open Sova's changes viewer on a set of git changes, for the user to review: a file tree, a numbered list of steps, and one file or step's diff at a time. Read-only: it changes nothing, computes no diff, and returns the changed files.

scope: "dirty" = uncommitted work (index + working tree, untracked files included) vs HEAD; "worktree" = a worktree's branch vs its merge-base with its base branch (the tracked worktree's base, else master, else main, else origin/HEAD); "commit" = one commit vs its first parent (give commit, e.g. a sha or "HEAD").
worktree: for dirty or worktree, which checkout: a tracked worktree's branch or path, or a directory; default the tracked worktree holding the session cwd, else (worktree scope) the only tracked one, else the session cwd.
paths: limit the view to these repo-relative files or directories.
steps: optional, the change told as a story, in reading order. Each step: a title, why (optional), buildsOn (numbers of earlier steps it depends on) and hunks: {path} for every hunk of a file, or {path, newStart} (or oldStart) naming one hunk by its @@ -a,b +c,d @@ header's c (a). Each hunk belongs to exactly one step; Sova puts hunks no step names under "Other changes".

Example: {"scope": "worktree", "title": "Rate limits on the export API", "steps": [{"title": "Token bucket", "why": "one limiter shared by every route", "hunks": [{"path": "server/limit.ts"}]}, {"title": "Apply it to /export", "buildsOn": [1], "hunks": [{"path": "server/routes.ts", "newStart": 120}, {"path": "server/routes.test.ts"}]}]}`;

export const SHOW_CHANGES_PROMPT_SNIPPET = "Show the user git changes (uncommitted, a worktree branch, or a commit) in Sova's diff viewer, optionally as numbered steps";

export const SHOW_CHANGES_GUIDELINES = [
	"When the user asks to see, review or walk through changes (\"show me the diff\", \"what did you change\"), call show_changes instead of pasting diffs or running git diff for them; reply with a sentence or two, the viewer shows the rest.",
	"Pick the scope that answers the question: dirty for uncommitted work, worktree for everything a feature branch did, commit for one commit (a merge's sha, say).",
	"For a change spread over several files, add steps: each a coherent unit the user can review on its own (a new module, then its wiring, then its tests), ordered so each builds on earlier ones (buildsOn), with a title and a short why. Name every hunk in exactly one step; name a file by path alone when all of its hunks belong to one step, and by newStart only when a file's hunks split across steps. Skip steps for a small change.",
];

const Hunk = Type.Object(
	{
		path: Type.String({ minLength: 1, description: "Repo-relative file path (the new path of a rename; the old one of a deletion)." }),
		oldStart: Type.Optional(Type.Integer({ minimum: 0, description: "The hunk's @@ -a,b header a: names one hunk by its old side." })),
		newStart: Type.Optional(Type.Integer({ minimum: 0, description: "The hunk's @@ +c,d header c: names one hunk by its new side. Omit both for every hunk of the file." })),
	},
	{ additionalProperties: false },
);

const Step = Type.Object(
	{
		title: Type.String({ minLength: 1, description: 'What this step does, short: "Token bucket limiter".' }),
		why: Type.Optional(Type.String({ minLength: 1, description: "Why, in a sentence (optional)." })),
		buildsOn: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Numbers (from 1) of earlier steps this one depends on." })),
		hunks: Type.Array(Hunk, { minItems: 1, maxItems: SHOW_CHANGES_LIMITS.hunksPerStep, description: "The hunks of this step; each hunk in exactly one step." }),
	},
	{ additionalProperties: false },
);

export const SHOW_CHANGES_PARAMETERS = Type.Object(
	{
		scope: StringEnum(["dirty", "worktree", "commit"] as const, {
			description: "dirty: uncommitted work vs HEAD; worktree: a branch vs its merge-base with its base branch; commit: one commit vs its first parent.",
		}),
		commit: Type.Optional(Type.String({ minLength: 1, description: 'scope commit only: the commit, e.g. a sha or "HEAD~1".' })),
		worktree: Type.Optional(Type.String({ minLength: 1, description: "scope dirty or worktree: a tracked worktree's branch or path, or a directory (default: see the description)." })),
		title: Type.Optional(Type.String({ minLength: 1, description: "One line naming the change, for the viewer's card." })),
		paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: SHOW_CHANGES_LIMITS.paths, description: "Limit the view to these repo-relative files or directories." })),
		steps: Type.Optional(Type.Array(Step, { maxItems: SHOW_CHANGES_LIMITS.steps, description: "The change as numbered steps, in reading order." })),
	},
	{ additionalProperties: false },
);

export interface ShowChangesOptions {
	git?: Git;
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

/** The reply the model reads: what opened, the files, and step refs that name no changed file. */
export function replyText(details: ShowChangesDetails, files: readonly string[]): string {
	const lines = [`Opened the changes viewer for the user: ${scopeLine(details.scope)}${details.paths ? `, limited to ${details.paths.join(", ")}` : ""}.`];
	if (files.length === 0) {
		lines.push("There are no changes in this scope.");
		return lines.join("\n");
	}
	lines.push(`${files.length} changed file${files.length === 1 ? "" : "s"}:`);
	for (const f of files.slice(0, LIST_FILES)) lines.push(`  ${f}`);
	if (files.length > LIST_FILES) lines.push(`  … and ${files.length - LIST_FILES} more`);
	if (details.steps) {
		const changed = new Set(files);
		const named = new Set(details.steps.flatMap((s) => s.hunks.map((h) => h.path)));
		const stray = [...named].filter((p) => !changed.has(p));
		const unnamed = files.filter((f) => !named.has(f));
		lines.push(`${details.steps.length} step${details.steps.length === 1 ? "" : "s"}; Sova gives each hunk to the first step naming it and shows the rest under "Other changes".`);
		if (stray.length) lines.push(`Not in this diff (those refs show as unmatched): ${stray.join(", ")}`);
		if (unnamed.length) lines.push(`Named by no step (under "Other changes"): ${unnamed.slice(0, LIST_FILES).join(", ")}${unnamed.length > LIST_FILES ? ", …" : ""}`);
	}
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
	const steps = d.steps.map((s, i) => `  ${i + 1}. ${s.title}${s.buildsOn ? ` (builds on ${s.buildsOn.join(", ")})` : ""} · ${s.hunks.length} ref${s.hunks.length === 1 ? "" : "s"}`);
	return new Text(theme.fg("dim", [head, ...steps].join("\n")), 0, 0);
}

export default function showChanges(pi: ExtensionAPI, options: ShowChangesOptions = {}) {
	const git = options.git ?? runGit;
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
				const scope = await resolveScope(git, req, dir, tree);
				const all = await changedFiles(git, scope);
				const files = all.filter((f) => inPaths(f, req.paths));
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
				return { content: [{ type: "text" as const, text: replyText(details, files) }], details };
			} catch (error) {
				if (error instanceof ShowChangesError) throw new Error(`${error.message}. Nothing was shown.`);
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
