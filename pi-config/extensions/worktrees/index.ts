/**
 * worktrees — the git worktrees a session works in (see README.md and §chat/worktrees).
 *
 * The set is the session's own `worktrees` custom entry (state.ts), a whole snapshot per change,
 * restored from the branch like mode's and the sandbox's. The parent agent manages it with one
 * tool, `worktree` (create, attach, detach, merge, land, list); there is no command and no pane control.
 * `land` acts on the user's go-ahead typed in this chat ("land it"): in a repo Sova's merge queue serves (served.ts) it
 * records it for the queue (landing.ts); in any other repo it is a plain merge into the main branch, as `merge` is there.
 * Workers never load this extension (subagents refuses it as a worker extension), so they never
 * have the tool.
 *
 * The subagents extension reads the set itself at every spawn (state.ts `workerCwdRefusal`); the
 * sandbox hears it on the bus (`worktrees:state`) to make active worktrees writable roots.
 *
 * Merges: `worktree merge` records one directly; a merge made with plain git during one of this
 * session's turns is detected after the turn (the branch became an ancestor of its target) and
 * recorded as `detected`. Each recorded merge appends a `worktree-merge` extension message: one
 * line for the model, a card in the TUI and in Sova. In a project with a spec, the model is also warned, once,
 * about spec work the merge left behind (spec.ts): in the tool's answer for `worktree merge`, in the message for
 * a detected merge.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dirname } from "node:path";
import { createWorktree, defaultTarget, forkPoint, GitError, type Git, inspectWorktree, landedStats, listWorktrees, mergeWorktree, type MergeProbe, probeMerge, runGit } from "./git.ts";
import { landingFile, newestUserMessage, recordGoAhead, typedGoAhead } from "./landing.ts";
import { servedFile, servedKey, servedRoot } from "./served.ts";
import { carryAgreedDrafts, landDocs, type MergeSpecReport, mergeSpecReport, specLines } from "./spec.ts";
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

const Action = StringEnum(["create", "attach", "detach", "merge", "land", "list"] as const);

/** @internal Test seam. */
export interface WorktreesOptions {
	git?: Git;
	now?: () => number;
	/** The spec report of a merge (default spec.ts `mergeSpecReport`). */
	specReport?: typeof mergeSpecReport;
	/** The docs step before a merge (default spec.ts `landDocs`). */
	docs?: typeof landDocs;
	/** The agreed drafts a new worktree takes from the main checkout (default spec.ts `carryAgreedDrafts`). */
	carry?: typeof carryAgreedDrafts;
	/** Where `land` records the go-ahead (default landing.ts `landingFile()`). */
	landingFile?: () => string;
	/** Whether Sova's merge queue serves a repo, asked with its main-checkout root at each `merge` and `land`
	    (default `queueServes`: the server's merge-served.json, read afresh). Served: `merge` into the branch the
	    queue lands into is refused and `land` records the go-ahead; unserved: both are plain merges. A boolean
	    answers for every repo; a string is the queue's target branch (served). */
	mergeQueue?: boolean | ((mainRoot: string) => boolean | string);
}

/** The default `mergeQueue` answer. A chat Sova didn't start merges plainly: it has neither `SOVA_CHAT_STATE_ROOT` nor
 *  `SOVA_CHAT_SOCK`, the socket only Sova's launch hands a chat process. One it did asks the server's merge-served.json;
 *  an absent or damaged file reads as served, and so does a chat with the socket but no state root (fail closed: a
 *  served repo never merges around its queue). → false | true | the queue's target branch. */
export function queueServes(mainRoot: string, env: NodeJS.ProcessEnv = process.env): boolean | string {
	if (!env.SOVA_CHAT_STATE_ROOT) return !!env.SOVA_CHAT_SOCK;
	const s = servedRoot(mainRoot, servedFile(env));
	return s === "unknown" ? true : s ? s.target : false;
}

export default function worktrees(pi: ExtensionAPI, options: WorktreesOptions = {}) {
	const git = options.git ?? runGit;
	const now = options.now ?? Date.now;
	const specReport = options.specReport ?? mergeSpecReport;
	const docsOf = options.docs ?? landDocs;
	const carryOf = options.carry ?? carryAgreedDrafts;
	const goAheadFile = options.landingFile ?? (() => landingFile());
	const mergeQueue = options.mergeQueue ?? ((root: string) => queueServes(root));

	/** Whether the queue serves the repo `cwd` is in: false, or the queue's target branch (true: served, target unknown). */
	async function servedAt(cwd: string): Promise<boolean | string> {
		if (typeof mergeQueue === "boolean") return mergeQueue;
		const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
		if (r.code !== 0) throw new GitError(`Not a git repository: ${cwd}`);
		return mergeQueue(servedKey(dirname(r.stdout.trim())));
	}

	/** A plain merge of a worktree's branch into `target`: its spec drafts made official on it first (unless
	    `withoutDocs`; drafts that don't fit stop it), then the merge, the record when tracked, and the card. */
	async function plainMerge(t: { path: string; branch: string }, tracked: TrackedWorktree | undefined, target: string, withoutDocs: boolean) {
		const docs = withoutDocs ? undefined : await docsOf(git, { path: t.path, branch: t.branch, target });
		if (docs?.state === "refused") throw new Error(docs.text);
		const { before, branchSha, ...m } = await mergeWorktree(git, { tree: t, target });
		if (tracked) markMerged(tracked, { target: m.target, sha: m.sha, how: "tool" });
		const spec = await reportOf(t.path, t.branch, before, m.sha, branchSha, target);
		card({ ...m, how: "tool" });
		const specText = spec ? specLines(spec, said).map((l) => `\n${l}`).join("") : "";
		const docsText = docs?.state === "landed" ? `\nIts spec drafts were made official first, as one docs commit ${shortSha(docs.sha)} (${docs.counts.added} new, ${docs.counts.changed} changed${docs.counts.removed ? `, ${docs.counts.removed} removed` : ""}: ${docs.drafts.join(", ")}).` : "";
		return { m, text: `${mergeNote(m)} (${m.fastForward ? "fast-forward" : "merge commit"}).${docsText}${specText}`, details: { merge: m, ...(spec ? { spec } : {}), ...(docs && docs.state !== "none" ? { docs } : {}) } };
	}
	let set: WorktreesActive | undefined;
	let sessionId = "";
	let sandboxOn = false;
	let remote = false;
	/** Each active worktree's merge state when the current run started; cleared when it settles. */
	let turnStart: Map<string, MergeProbe> | undefined;
	/** The once-a-session spec warnings already said (spec.ts `specLines`). */
	let said = new Set<string>();

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

	/** The spec report of a merge; best-effort, so a failure never fails the merge. */
	async function reportOf(path: string, branch: string, before: string, after: string, branchSha: string, target: string): Promise<MergeSpecReport | undefined> {
		const main = await defaultTarget(git, path).catch(() => undefined);
		return specReport(git, { path, branch, before, after, branchSha, onDefault: target === main }).catch(() => undefined);
	}

	/** The card; its message is the merge line, then any spec warnings (a tool merge says those in its answer). */
	function card(d: Omit<WorktreeMergeDetails, "version">, warnings: string[] = []): void {
		const details: WorktreeMergeDetails = { version: 1, ...d };
		// Not a turn of its own: while a run streams, pi holds it until the turn ends (never between a
		// tool call and its result); after the run it is appended at once.
		pi.sendMessage<WorktreeMergeDetails>({ customType: WORKTREE_MERGE_MESSAGE, content: [mergeNote(details), ...warnings].join("\n"), display: true, details }, { triggerTurn: false });
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
		said = new Set();
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
				const spec = await reportOf(t.path, t.branch, was.targetSha, p.targetSha, p.branchSha, p.target);
				card({ path: t.path, branch: t.branch, target: p.target, sha, ...stats, how: "detected" }, spec ? specLines(spec, said) : []);
			} catch {
				// Best-effort: an unreadable merge is still shown as merged by the pane's own check.
			}
		}
	});

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Manage the git worktrees this session works in. create {name, base?, path?} runs git worktree add -b feat/<name> (default path <parent of the main checkout>/.worktrees/<repo>-<name>, base the session cwd's HEAD); attach {path} tracks an existing worktree's top level (one another session created is fine); detach {path} stops tracking it (nothing is deleted); merge {path, target?} merges its branch into another branch (into main or master only as this turn's Sova landing note allows; the branch's spec drafts are made official first unless withoutDocs); land {path?} lands the branch at its head commit the way this turn's Sova landing note says, on the user's word typed in this chat (\"land it\", \"merge it\"; default the worktree this session's folder is in; only when the user's newest message says so, with nothing uncommitted); list shows the set. Workers may start only in the session cwd or inside an active tracked worktree.",
		promptSnippet: "Create, attach, detach, merge, land and list this session's git worktrees",
		promptGuidelines: [
			"Use the worktree tool, not bash, to create or track a git worktree: workers may only start in this session's cwd or inside a worktree the session tracks.",
			"Merge a branch into main or master only as this turn's Sova landing note for that repo allows.",
			"When the user types in this chat that its branch should land (\"land it\", \"merge it\"), commit what is left, then call worktree land at once: it lands the branch the way this turn's Sova landing note says.",
			"When a [merge-queue] message says the merge thread needs the user, ask them its question in your reply and relay their answer in their words with the project verbs tool's merge.reply {ask, text}; never answer it yourself.",
		],
		parameters: Type.Object(
			{
				action: Action,
				name: Type.Optional(Type.String({ description: "create: the worktree name; the branch is feat/<name>." })),
				base: Type.Optional(Type.String({ description: "create: commit or branch to base on (default the session cwd's HEAD)." })),
				path: Type.Optional(Type.String({ description: "create: where to put it; attach, detach, merge, land: the worktree (its path, or its branch name; land defaults to the worktree this session's folder is in)." })),
				target: Type.Optional(Type.String({ description: "merge: the branch to merge into (default master)." })),
				withoutDocs: Type.Optional(Type.Boolean({ description: "merge: leave the branch's spec drafts behind instead of making them official before the merge. Pass it only when the user says to." })),
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
						// Decisions agreed in the main checkout ride with the new branch, to become official when it lands.
						const carried = await carryOf(git, { from: ctx.cwd, to: f.path }).catch(() => [] as string[]);
						const tree: TrackedWorktree = { path: f.path, branch: f.branch, base: f.base, ...(f.baseBranch ? { baseBranch: f.baseBranch } : {}), status: "active", session: sessionId, how: "created", at: now() };
						record(withTree(set, tree));
						await watchFromNow(tree);
						return done(`Created ${f.path} on ${f.branch} from ${shortSha(f.base)}${f.baseBranch ? ` (${f.baseBranch})` : ""}.${carried.length ? `\nCopied the main checkout's agreed spec draft${carried.length === 1 ? "" : "s"} into it, to land with this branch: ${carried.join(", ")}.` : ""}\n${listing()}`);
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
					case "land": {
						const newest = newestUserMessage(ctx.sessionManager.getBranch());
						// Another sender's message is never the user's word, whatever it says (§chat.worktrees/land-own-word).
						if (newest.sentBy)
							throw new Error(
								`The newest message in this chat was sent by ${newest.sentBy}, not typed by the user, so it isn't their go-ahead to land, whatever it says. Nothing was recorded. Only the user's own word lands a branch: "land it" typed by them in this chat, or their Land button.`,
							);
						const word = typedGoAhead(newest.text);
						if (!word) throw new Error("Only the user's own word lands a branch: their newest message in this chat must say to land or merge it (\"land it\"). Nothing was recorded; ask them to type it here.");
						const tracked = params.path ? find(params.path, ctx.cwd) : undefined;
						if (params.path && !tracked) throw new Error(`No tracked worktree ${params.path}.\n${listing()}`);
						const top = tracked?.path ?? canonical((await git(["rev-parse", "--show-toplevel"], ctx.cwd)).stdout.trim() || ctx.cwd);
						const f = await inspectWorktree(git, top);
						const main = await defaultTarget(git, f.path);
						if (f.branch === main || f.branch === "master" || f.branch === "main") throw new Error(`${f.path} is on ${f.branch}, which branches land into: there is nothing to land. Nothing was recorded.`);
						const dirty = await git(["status", "--porcelain"], f.path);
						if (dirty.code !== 0) throw new GitError(`git status failed in ${f.path}: ${dirty.stderr.trim()}`);
						const files = dirty.stdout.split("\n").filter(Boolean).length;
						if (files) throw new Error(`${f.branch} has ${files} uncommitted file${files === 1 ? "" : "s"}: the go-ahead is for a commit. Commit or remove them, then call worktree land again. Nothing was recorded.`);
						const served = await servedAt(f.path);
						const asked = word.via === "github-pr" ? "pull request" : word.via === "gitlab-mr" ? "merge request" : null;
						// q12: "open a PR/MR" is never blocked. Unserved, the chat opens it itself; served, the queue does.
						if (asked && served === false)
							return done(`Sova's merge queue doesn't serve this repo, so nothing was queued: open the request yourself, as the user asked, with gh pr create or glab mr create, whichever origin's host uses (after pushing ${f.branch}).`, { landing: null, trees: set?.trees ?? [] });
						if (served === false) {
							// No merge queue here: the user's word is a plain merge into the main checkout's branch.
							const checkouts = await listWorktrees(git, f.path);
							const mainBranch = checkouts[0]?.branch;
							const target = mainBranch && mainBranch !== f.branch ? mainBranch : main;
							if (!target) throw new Error(`${f.path}'s repository has no master or main branch to merge ${f.branch} into. Nothing was merged.`);
							const own = tracked ?? set?.trees.find((t) => t.path === f.path && t.status === "active");
							await approve(ctx, "Merge a worktree?", `Merge ${f.branch} (${f.path}) into ${target}.`);
							const r = await plainMerge(f, own, target, word.withoutSpecs);
							return done(`${r.text}\nNo merge queue serves this repo, so the user's word merged it here.\n${listing()}`, { ...r.details, trees: set?.trees ?? [] });
						}
						recordGoAhead({ branch: f.branch, commit: f.head, ...(sessionId ? { session: sessionId } : {}), at: new Date(now()).toISOString(), by: "owner-chat", ...(word.withoutSpecs ? { withoutSpecs: true as const } : {}), ...(word.withoutReview ? { withoutReview: true as const } : {}), ...(word.via ? { via: word.via } : {}) }, goAheadFile());
						return done(
							`Queued ${f.branch} at ${shortSha(f.head)} to land${asked ? " as a request on origin's host (a merge request on GitLab, a pull request on GitHub)" : ""}${word.withoutSpecs ? ", without its specs" : ""}${word.withoutReview ? ", without review" : ""}. Sova's merge queue merges it onto the newest master in its own copy, runs the checks and lands exactly that commit; it tells this chat when it lands or if it needs a fix. Tell the user it is queued; nothing else is needed from them. A newer commit on ${f.branch} isn't included unless they land it again.`,
							{ landing: { branch: f.branch, commit: f.head, withoutSpecs: word.withoutSpecs, withoutReview: word.withoutReview, ...(word.via ? { via: word.via } : {}) }, trees: set?.trees ?? [] },
						);
					}
					case "merge": {
						if (!params.path) throw new Error("merge needs a path or branch.");
						const t = find(params.path, ctx.cwd);
						if (!t) throw new Error(`No tracked worktree ${params.path}.\n${listing()}`);
						if (t.status !== "active") throw new Error(`${t.path} is ${statusText(t)}; only an active worktree is merged.`);
						const target = params.target ?? (await defaultTarget(git, t.path)) ?? "master";
						const served = await servedAt(t.path);
						if (served !== false && (served === target || (await landsThroughQueue(git, t.path, target))))
							throw new Error(`${target} is the branch others land into: branches reach it only through Sova's merge queue, never a merge from a chat. Nothing was merged. When the work is finished, tell the user they can type "land it" here (or press Land).`);
						await approve(ctx, "Merge a worktree?", `Merge ${t.branch} (${t.path}) into ${target}.`);
						const r = await plainMerge(t, t, target, !!params.withoutDocs);
						return done(`${r.text}\n${listing()}`, { ...r.details, trees: set?.trees ?? [] });
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

/** Whether `target` is the branch the project's branches land into: master, main, the main checkout's branch, or the
 *  merge queue's declared target (`.sova/project.json` `merge.target`, as the main checkout's HEAD or the target
 *  branch itself commits it; absent or unreadable: only the other three). */
async function landsThroughQueue(git: Git, cwd: string, target: string): Promise<boolean> {
	if (target === "master" || target === "main") return true;
	const r = await git(["worktree", "list", "--porcelain"], cwd);
	const first = r.code === 0 ? (r.stdout.split("\n\n")[0] ?? "") : "";
	const main = /^branch refs\/heads\/(.+)$/m.exec(first)?.[1];
	if (main === target) return true;
	const mainPath = /^worktree (.+)$/m.exec(first)?.[1] ?? cwd;
	for (const rev of ["HEAD", `refs/heads/${target}`]) {
		const shown = await git(["show", `${rev}:.sova/project.json`], mainPath);
		if (shown.code !== 0) continue;
		try {
			const declared = (JSON.parse(shown.stdout) as { merge?: { target?: unknown } } | null)?.merge?.target;
			if (declared === target) return true;
		} catch {
			// not JSON: nothing declared
		}
	}
	return false;
}
