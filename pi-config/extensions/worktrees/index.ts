/**
 * worktrees — the git worktrees a session works in (see README.md and §chat/worktrees).
 *
 * The set is the session's own `worktrees` custom entry (state.ts), a whole snapshot per change,
 * restored from the branch like mode's and the sandbox's. The parent agent manages it with one
 * tool, `worktree` (create, attach, detach, merge, list); there is no command and no pane control.
 * Workers never load this extension (subagents refuses it as a worker extension), so they never
 * have the tool.
 *
 * The subagents extension reads the set itself at every spawn (state.ts `workerCwdRefusal`); the
 * sandbox hears it on the bus (`worktrees:state`) to make active worktrees writable roots.
 *
 * Merges: `worktree merge` records one directly; a merge made with plain git during one of this
 * session's turns is detected after the turn (the branch became an ancestor of its target) and
 * recorded as `detected`. Each recorded merge appends a `worktree-merge` extension message: one
 * line for the model, a card in the TUI and in Sova.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createWorktree, defaultTarget, forkPoint, GitError, type Git, inspectWorktree, landedStats, mergeWorktree, type MergeProbe, probeMerge, runGit } from "./git.ts";
import {
	activeTrees,
	canonical,
	mergeNote,
	normalizeMergeDetails,
	restoreActive,
	sharedWith,
	shortSha,
	statusText,
	type TrackedWorktree,
	withTree,
	WORKTREE_MERGE_MESSAGE,
	type WorktreeMergeDetails,
	WORKTREES_DISCOVER_EVENT,
	WORKTREES_ENTRY_TYPE,
	WORKTREES_STATE_EVENT,
	type WorktreesActive,
	type WorktreesStateEvent,
} from "./state.ts";

/** sandbox/state.ts SANDBOX_STATE_EVENT / SANDBOX_DISCOVER_EVENT, spelled again: this extension imports nothing of the sandbox. */
const SANDBOX_STATE_EVENT = "sandbox:state";
const SANDBOX_DISCOVER_EVENT = "sandbox:discover";
/** remote/workers.ts: a session on a target runs its tools there; worktrees are local only. */
const REMOTE_SESSION_EVENT = "remote:session";
const REMOTE_DISCOVER_EVENT = "remote:discover";

const Action = StringEnum(["create", "attach", "detach", "merge", "list"] as const);

/** @internal Test seam. */
export interface WorktreesOptions {
	git?: Git;
	now?: () => number;
}

export default function worktrees(pi: ExtensionAPI, options: WorktreesOptions = {}) {
	const git = options.git ?? runGit;
	const now = options.now ?? Date.now;
	let set: WorktreesActive | undefined;
	let sessionId = "";
	let sandboxOn = false;
	let remote = false;
	/** Each active worktree's merge state when the current run started; cleared when it settles. */
	let turnStart: Map<string, MergeProbe> | undefined;

	function emitState(): void {
		const event: WorktreesStateEvent = { version: 1, active: activeTrees(set).map((t) => t.path) };
		pi.events?.emit(WORKTREES_STATE_EVENT, event);
	}

	function restore(ctx: ExtensionContext): void {
		try {
			set = restoreActive(ctx.sessionManager.getBranch());
		} catch {
			set = undefined;
		}
		emitState();
	}

	function record(next: WorktreesActive): void {
		set = next;
		pi.appendEntry<WorktreesActive>(WORKTREES_ENTRY_TYPE, next);
		emitState();
	}

	function describe(t: TrackedWorktree): string {
		const shared = sharedWith(t, sessionId);
		return `${t.path}  ${t.branch}  ${statusText(t)}${t.how === "created" ? "" : "  attached"}${shared ? `  shared with session ${shared}` : ""}`;
	}

	function listing(): string {
		const trees = set?.trees ?? [];
		return trees.length ? `This session's worktrees:\n${trees.map(describe).join("\n")}` : "This session tracks no worktrees.";
	}

	function find(ref: string, cwd: string): TrackedWorktree | undefined {
		const trees = set?.trees ?? [];
		const path = canonical(ref.startsWith("/") || ref.startsWith(".") || ref.startsWith("~") ? expand(ref, cwd) : `${cwd}/${ref}`);
		return trees.find((t) => t.path === path) ?? trees.filter((t) => t.branch === ref).at(-1);
	}

	function expand(p: string, cwd: string): string {
		const home = process.env.HOME ?? "";
		if (p === "~") return home;
		if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
		return p.startsWith("/") ? p : `${cwd}/${p}`;
	}

	/** While the sandbox is on, the user approves every widening of what the session may write. */
	async function approve(ctx: ExtensionContext, title: string, message: string): Promise<void> {
		if (!sandboxOn) return;
		if (!ctx.hasUI) throw new Error("This session's sandbox is on and there is no one to ask; the user must approve worktree changes.");
		const ok = await ctx.ui.confirm(title, `${message}\n\nThe sandbox is on: this lets the session and its workers write there.`);
		if (!ok) throw new Error("The user declined; nothing changed.");
	}

	function card(d: Omit<WorktreeMergeDetails, "version">): void {
		const details: WorktreeMergeDetails = { version: 1, ...d };
		// Not a turn of its own: while a run streams, pi holds it until the turn ends (never between a
		// tool call and its result); after the run it is appended at once.
		pi.sendMessage<WorktreeMergeDetails>({ customType: WORKTREE_MERGE_MESSAGE, content: mergeNote(details), display: true, details }, { triggerTurn: false });
	}

	/** A worktree tracked mid-run joins that run's merge detection from here. */
	async function watchFromNow(tree: TrackedWorktree): Promise<void> {
		if (!turnStart) return;
		const p = await probeMerge(git, tree).catch(() => undefined);
		if (p) turnStart.set(tree.path, p);
	}

	function markMerged(tree: TrackedWorktree, merge: { target: string; sha: string; how: "tool" | "detected" }): void {
		record(withTree(set, { ...tree, status: "merged", merge: { ...merge, at: now() } }));
	}

	pi.events?.on(SANDBOX_STATE_EVENT, (data: unknown) => {
		const e = data as { version?: unknown; on?: unknown } | undefined;
		if (e && e.version === 1 && typeof e.on === "boolean") sandboxOn = e.on;
	});
	pi.events?.on(REMOTE_SESSION_EVENT, () => {
		remote = true;
	});
	pi.events?.on(WORKTREES_DISCOVER_EVENT, () => emitState());

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		pi.events?.emit(REMOTE_DISCOVER_EVENT, { version: 1 });
		pi.events?.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });
		restore(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	// Merge detection: the state at the start of a run, compared when it settles.
	pi.on("agent_start", async () => {
		if (turnStart || remote) return;
		const probes = new Map<string, MergeProbe>();
		for (const t of activeTrees(set)) {
			const p = await probeMerge(git, t).catch(() => undefined);
			if (p) probes.set(t.path, p);
		}
		turnStart = probes;
	});
	pi.on("agent_settled", async () => {
		const before = turnStart;
		turnStart = undefined;
		if (!before?.size) return;
		for (const t of activeTrees(set)) {
			const was = before.get(t.path);
			if (!was || was.merged) continue;
			const p = await probeMerge(git, t, was.target).catch(() => undefined);
			if (!p?.merged) continue;
			try {
				const { sha, ...stats } = await landedStats(git, t.path, was.targetSha, p.targetSha, p.branchSha);
				markMerged(t, { target: p.target, sha, how: "detected" });
				card({ path: t.path, branch: t.branch, target: p.target, sha, ...stats, how: "detected" });
			} catch {
				// Best-effort: an unreadable merge is still shown as merged by the pane's own check.
			}
		}
	});

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Manage the git worktrees this session works in. create {name, base?, path?} runs git worktree add -b feat/<name> (default path <parent of the main checkout>/.worktrees/<repo>-<name>, base the session cwd's HEAD); attach {path} tracks an existing worktree's top level (one another session created is fine); detach {path} stops tracking it (nothing is deleted); merge {path, target?} merges its branch into target (default master) where target is checked out and clean, else fast-forward only; list shows the set. Workers may start only in the session cwd or inside an active tracked worktree.",
		promptSnippet: "Create, attach, detach, merge and list this session's git worktrees",
		promptGuidelines: [
			"Use the worktree tool, not bash, to create or track a git worktree: workers may only start in this session's cwd or inside a worktree the session tracks.",
			"Merge a worktree's branch with worktree merge so the merge is recorded; a merge you make with plain git during a turn is detected afterwards.",
		],
		parameters: Type.Object(
			{
				action: Action,
				name: Type.Optional(Type.String({ description: "create: the worktree name; the branch is feat/<name>." })),
				base: Type.Optional(Type.String({ description: "create: commit or branch to base on (default the session cwd's HEAD)." })),
				path: Type.Optional(Type.String({ description: "create: where to put it; attach, detach, merge: the worktree (its path, or its branch name)." })),
				target: Type.Optional(Type.String({ description: "merge: the branch to merge into (default master)." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (remote) throw new Error("Worktrees are local only; this session runs its tools on a remote target.");
			sessionId = ctx.sessionManager.getSessionId() || sessionId;
			const done = (text: string, details: unknown = { trees: set?.trees ?? [] }) => ({ content: [{ type: "text" as const, text }], details });
			try {
				switch (params.action) {
					case "list":
						return done(listing());
					case "create": {
						if (!params.name) throw new Error("create needs a name.");
						await approve(ctx, "Create a worktree?", `Create worktree feat/${params.name}${params.path ? ` at ${params.path}` : ""}${params.base ? ` from ${params.base}` : ""} for this session.`);
						const f = await createWorktree(git, { repoCwd: ctx.cwd, name: params.name, ...(params.base ? { base: params.base } : {}), ...(params.path ? { path: expand(params.path, ctx.cwd) } : {}) });
						const tree: TrackedWorktree = { path: f.path, branch: f.branch, base: f.base, ...(f.baseBranch ? { baseBranch: f.baseBranch } : {}), status: "active", session: sessionId, how: "created", at: now() };
						record(withTree(set, tree));
						await watchFromNow(tree);
						return done(`Created ${f.path} on ${f.branch} from ${shortSha(f.base)}${f.baseBranch ? ` (${f.baseBranch})` : ""}.\n${listing()}`);
					}
					case "attach": {
						if (!params.path) throw new Error("attach needs a path.");
						const f = await inspectWorktree(git, canonical(expand(params.path, ctx.cwd)));
						const current = set?.trees.find((t) => t.path === f.path);
						if (current?.status === "active") return done(`${f.path} is already tracked.\n${listing()}`);
						await approve(ctx, "Attach a worktree?", `Track ${f.path} (${f.branch}) as one of this session's worktrees.`);
						const target = await defaultTarget(git, f.path);
						// The fork point from the default branch, so work committed before the attach still counts as unmerged.
						const base = target && target !== f.branch ? (await forkPoint(git, f.path, f.branch, target)) ?? f.head : f.head;
						const tree: TrackedWorktree = { path: f.path, branch: f.branch, base, ...(target && target !== f.branch ? { baseBranch: target } : {}), status: "active", session: sessionId, how: "attached", at: now() };
						record(withTree(set, tree));
						await watchFromNow(tree);
						return done(`Attached ${f.path} (${f.branch}).\n${listing()}`);
					}
					case "detach": {
						if (!params.path) throw new Error("detach needs a path or branch.");
						const t = find(params.path, ctx.cwd);
						if (!t) throw new Error(`No tracked worktree ${params.path}.\n${listing()}`);
						if (t.status !== "active") return done(`${t.path} is already ${statusText(t)}.\n${listing()}`);
						record(withTree(set, { ...t, status: "dropped" }));
						return done(`Detached ${t.path}; nothing on disk was touched.\n${listing()}`);
					}
					case "merge": {
						if (!params.path) throw new Error("merge needs a path or branch.");
						const t = find(params.path, ctx.cwd);
						if (!t) throw new Error(`No tracked worktree ${params.path}.\n${listing()}`);
						if (t.status !== "active") throw new Error(`${t.path} is ${statusText(t)}; only an active worktree is merged.`);
						const target = params.target ?? (await defaultTarget(git, t.path)) ?? "master";
						await approve(ctx, "Merge a worktree?", `Merge ${t.branch} (${t.path}) into ${target}.`);
						const m = await mergeWorktree(git, { tree: t, target });
						markMerged(t, { target: m.target, sha: m.sha, how: "tool" });
						card({ ...m, how: "tool" });
						return done(`${mergeNote(m)} (${m.fastForward ? "fast-forward" : "merge commit"}).\n${listing()}`, { merge: m, trees: set?.trees ?? [] });
					}
				}
			} catch (e) {
				if (e instanceof GitError) throw new Error(e.message);
				throw e;
			}
			throw new Error(`Unknown action ${String(params.action)}`);
		},
	});

	// The merge card in the TUI; Sova renders the same message as its own card.
	pi.registerMessageRenderer<WorktreeMergeDetails>(WORKTREE_MERGE_MESSAGE, (message, _options, theme) => {
		const d = normalizeMergeDetails(message.details);
		if (!d) return new Text(theme.fg("dim", typeof message.content === "string" ? message.content : "Worktree merged"), 0, 0);
		const head = `${theme.fg("success", "⎇ Merged")} ${theme.bold(d.branch)} → ${theme.bold(d.target)} at ${shortSha(d.sha)}`;
		const tail = theme.fg("dim", `${d.commits} commit${d.commits === 1 ? "" : "s"} · +${d.added} −${d.removed} · ${d.fastForward ? "fast-forward" : "merge commit"}${d.how === "detected" ? " · detected" : ""} · ${d.path}`);
		return new Text(`${head}\n${tail}`, 1, 0);
	});
}
