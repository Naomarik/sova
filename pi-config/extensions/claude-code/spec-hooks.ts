/**
 * Spec hooks for Claude Code workers: the worker half of the spec guard (mode/spec-guard.ts holds
 * the census digest and the last-line check, shared with the pi session's own hooks).
 *
 * The subagents spawn path installs them, while the spawning session has spec mode on, through
 * the one `--settings` JSON (withClaudeSettings merges them into the sandbox's settings, if any);
 * `--setting-sources ""` leaves flag settings in force, hooks included (probed with CLI 2.1.282).
 * Claude runs each hook as a fresh process: `node spec-hooks.ts <event> --core <dir> --state <dir>`
 * with the event's JSON on stdin, so everything that spans calls lives in one state file per
 * Claude session under `--state` (plus `<session>.log.jsonl`, one line per hook that spoke).
 *
 * - UserPromptSubmit (`turn`): a turn starts; the work tree now is its baseline (gitView).
 * - PostToolUse (`post`, any tool, Bash included): the census step (censusStep, the same one the pi
 *   session runs) on a git-status delta, its `[spec census]` digest returned as additionalContext;
 *   notes whether the turn wrote. Each tree a command works in (its cwd, every `cd <dir>` and
 *   `git -C <dir>`) keeps its HEAD from the last look; the HEAD reflog since then gives each git
 *   operation there as before → after (never HEAD^1), so a merge into master in the root from a
 *   worktree, fast-forward or not, and several merges in one command all count. Each operation goes to
 *   the parent's ledger (SOVA_SPEC_LEDGER) and is judged by spec-guard's judgeOp, as the pi check does:
 *   a merge of master into a feature branch lands nothing; a merge or promote lands its foreign §
 *   (the task's own claims out) and the landing gate's lists.
 * - Stop (`stop`): the reply's last line against the turn. After a promote or a merge the computed
 *   foreign list is the authority: every § in it must be named, each changed file no claim maps needs a
 *   `Plumbing:` line, and each draft record left unpromoted a `Deferred:` line (on the default branch a promotion,
 *   or the override line: no Deferred line passes a landing there); the reply is sent back
 *   (block) until it does, at most MERGE_BLOCKS times. Elsewhere a miss is a
 *   warning, sent back once and then let through: a turn that wrote without the exact line, one
 *   that wrote nothing with it, a line omitting a foreign § the turn's draft edits, or one naming a
 *   § the census never saw touched. Drafts are gitignored, so their edits are found by mtime
 *   (draftStamps at the turn's start) and their foreign § by `foreign --spec` (draftForeign).
 *
 * Node builtins and mode/spec-guard.ts only (both run under node's type stripping: erasable TS).
 * A hook that fails says nothing and exits 0: it never stops a worker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHECK_TAG, LANDING_REPROMPTS, LEDGER_ENV, appendLedger, censusStep, checkAlsoChanges, commandDirs, commandRoot, currentSpecPath, defaultBranch, describeProblem, directWriteNote, evidenceCommits, headAt, judgeOp, rebaseUnderway, rewriteNote, sanctionedSpecWrite, draftForeign, draftStamps, draftsTouched, findSpecRoot, freshCensusState, gitCommits, gitView,
	localIO, promoteWrites, repromptText, viewChanged, type CensusState, type GitView, type LedgerEntry, type OpLanding, type SpecIO,
} from "../mode/spec-guard.ts";
import { lastLine, parseAlsoChanges } from "../mode/also-changes.ts";

export const SPEC_HOOK_SCRIPT = fileURLToPath(import.meta.url);
/** Hook timeout, seconds: a census over a large tree stays well under it. */
const HOOK_TIMEOUT_S = 60;
/** How many times a merge/promote turn's reply is sent back before it is let through: the pi check's own count. */
export const MERGE_BLOCKS = LANDING_REPROMPTS;
/** Tools that never write: no git status for them. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "BashOutput"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Settings = Record<string, unknown>;
interface HookEntry { type: "command"; command: string; timeout: number }
interface HookMatcher { matcher?: string; hooks: HookEntry[] }

const shellQuote = (value: string): string => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** The `hooks` settings block for the three events, run by `node` (the parent's runtime); `ledger`: the parent's ledger file. */
export function specHookSettings(o: { node: string; coreDir: string; stateDir: string; script?: string; ledger?: string }): Settings {
	const command = (event: string): HookEntry => ({
		type: "command",
		command: [o.node, o.script ?? SPEC_HOOK_SCRIPT, event, "--core", o.coreDir, "--state", o.stateDir, ...(o.ledger ? ["--ledger", o.ledger] : [])].map(shellQuote).join(" "),
		timeout: HOOK_TIMEOUT_S,
	});
	return {
		hooks: {
			UserPromptSubmit: [{ hooks: [command("turn")] }],
			PostToolUse: [{ matcher: "*", hooks: [command("post")] }],
			Stop: [{ hooks: [command("stop")] }],
		},
	};
}

/**
 * `extra` merged into a `--settings` JSON (or none): keys added, and each hook event's matcher list
 * appended to the base's, so a sandbox's own hooks keep running. Throws on a base that is not a
 * JSON object (buildClaudeArgv would refuse it anyway).
 */
export function withClaudeSettings(base: string | undefined, extra: Settings): string {
	const parsed: unknown = base === undefined ? {} : JSON.parse(base);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid settingsJson: must be a JSON object");
	const out: Settings = { ...(parsed as Settings) };
	for (const [key, value] of Object.entries(extra)) {
		if (key !== "hooks" || !out.hooks || typeof out.hooks !== "object") { out[key] = value; continue; }
		const hooks = { ...(out.hooks as Record<string, HookMatcher[]>) };
		for (const [event, list] of Object.entries(value as Record<string, HookMatcher[]>)) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...list];
		out.hooks = hooks;
	}
	return JSON.stringify(out);
}


// ---------------------------------------------------------------------------
// State: one plain-JSON file per Claude session
// ---------------------------------------------------------------------------

export interface TurnState {
	/** Claude's prompt_id for the turn, when it gives one. */
	id?: string;
	/** The work tree at the last look (the turn's start, then after each tool). */
	view?: GitView;
	/** The spec root and each draft's newest spec/ mtime at the turn's start: drafts are gitignored, so git never shows their edits. */
	root?: string;
	drafts?: Record<string, number>;
	/** HEAD when the turn started: the base of what it landed. */
	head?: string | null;
	/** The turn changed a file, committed, promoted or merged. */
	wrote: boolean;
	/** The turn promoted or merged: its last line is checked against `foreign`, blocking. */
	landed: boolean;
	/** Foreign § that promote or merge landed, computed (never the model's own list). */
	foreign: string[];
	/** A promote or merge whose list couldn't be computed: `foreign` may be short, so extras aren't judged. */
	partial?: boolean;
	/** Stop-hook send-backs this turn. */
	blocks: number;
	/** HEAD of each tree top at the last look (ms `lookedAt`): the base of the next operation there. */
	heads?: Record<string, string>;
	lookedAt?: number;
	/** The default branch's tip when the turn started: the task's own claims are absent there and at the fork point. */
	tip?: string;
	/** The turn's landings, each with the gate's lists (unmapped paths, unpromoted drafts, advisory §). */
	landings?: TurnLanding[];
}
export interface TurnLanding {
	top: string;
	before: string;
	after: string;
	kind: OpLanding["kind"];
	root?: string;
	unmapped: string[];
	unpromoted: { draft: string; worktree?: string; ids: string[] }[];
	advisory: string[];
	/** It landed on the default branch: its unpromoted records take a promotion (or the override), never a Deferred line. */
	onDefault?: boolean;
}
export interface HookState {
	version: 1;
	/** When the hooks first saw this session (ISO): pickDraft's fallback. */
	sessionStart: string;
	census: CensusState;
	/** This session's shell commands, newest last (bounded): the drafts it created. */
	commands: string[];
	turn: TurnState;
}
const MAX_COMMANDS = 200;
const freshTurn = (): TurnState => ({ wrote: false, landed: false, foreign: [], blocks: 0 });
const freshState = (): HookState => ({ version: 1, sessionStart: new Date().toISOString(), census: freshCensusState(), commands: [], turn: freshTurn() });

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
export function statePath(stateDir: string, sessionId: string): string | undefined {
	return SESSION.test(sessionId) ? path.join(stateDir, `${sessionId}.json`) : undefined;
}
export function readState(file: string): HookState {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (value?.version === 1 && value.turn && value.census && Array.isArray(value.commands)) {
			return { ...freshState(), ...value, turn: { ...freshTurn(), ...value.turn } };
		}
	} catch { /* missing or corrupt: start over */ }
	return freshState();
}
export function writeState(file: string, state: HookState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** The ids of a `promote … --write --json` result's `alsoChanges`, when the output is one. */
export function alsoChangesOf(stdout: unknown): string[] | undefined {
	if (typeof stdout !== "string") return undefined;
	try {
		const value = JSON.parse(stdout);
		return Array.isArray(value?.alsoChanges) ? value.alsoChanges.filter((id: unknown): id is string => typeof id === "string") : undefined;
	} catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface HookInput {
	session_id?: string;
	prompt_id?: string;
	cwd?: string;
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	stop_hook_active?: boolean;
	last_assistant_message?: string;
}
export interface HookContext { core: string; state: HookState; io: SpecIO; ledger?: string; session?: string }
/** What Claude reads from stdout; undefined = print nothing. */
export type HookOutput = Record<string, unknown> | undefined;

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort();

/** A turn starts: the tree as it is now is its baseline (and the census's, the first time). */
export async function onTurn(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const cwd = input.cwd ?? process.cwd();
	const view = await gitView(cwd, ctx.io);
	const root = await findSpecRoot(cwd, (p) => ctx.io.exists(p));
	const main = view ? await defaultBranch(view.top, ctx.io).catch(() => undefined) : undefined;
	const tip = main ? await ctx.io.exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${main}`], { cwd: view!.top, timeout: 10_000 }).catch(() => undefined) : undefined;
	ctx.state.turn = {
		...freshTurn(), id: input.prompt_id, view, head: view?.head, ...(root ? { root, drafts: await draftStamps(root, ctx.io) } : {}),
		heads: { ...(view ? await worktreeHeads(view.top, ctx.io) : {}), ...(view?.head ? { [await realTop(view.top)]: view.head } : {}) }, lookedAt: Date.now(), ...(tip?.code === 0 && tip.stdout.trim() ? { tip: tip.stdout.trim() } : {}),
	};
	ctx.state.census = (await censusStep(ctx.state.census, { cwd, toolName: "", input: undefined }, ctx.core, ctx.io)).state;
	return undefined;
}

export async function onPost(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const tool = input.tool_name ?? "";
	if (READ_ONLY.has(tool)) return undefined;
	const cwd = input.cwd ?? process.cwd();
	const { state } = ctx;
	const turn = state.turn;
	const command = tool === "Bash" && typeof input.tool_input?.command === "string" ? input.tool_input.command : undefined;
	if (command) state.commands = [...state.commands, command].slice(-MAX_COMMANDS);
	const before = turn.view;
	const view = await gitView(cwd, ctx.io);
	if (WRITE_TOOLS.has(tool) || viewChanged(before, view) || (command && gitCommits(command))) turn.wrote = true;
	turn.view = view ?? before;
	if (command) await landOps(command, cwd, input.tool_response, ctx).catch(() => { turn.partial = true; });
	const g = await writeGuard(tool, input, cwd, before, view, ctx).catch(() => ({ text: undefined, lost: [] as string[] }));
	const guard = g.text;
	const step = await censusStep(state.census, { cwd, toolName: tool, input: input.tool_input ?? {}, commands: state.commands, sessionStart: state.sessionStart, orphansSaid: g.lost }, ctx.core, ctx.io);
	state.census = step.state;
	if (step.result.failure) return { systemMessage: [guard, step.result.failure].filter(Boolean).join("\n") };
	const text = [guard, step.result.text].filter(Boolean).join("\n");
	if (!text) return undefined;
	return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
}

/** Every worktree of the repository at `top` and its HEAD: a merge into another checkout then has its base. */
export async function worktreeHeads(top: string, io: SpecIO): Promise<Record<string, string>> {
	const r = await io.exec("git", ["worktree", "list", "--porcelain"], { cwd: top, timeout: 10_000 }).catch(() => undefined);
	const out: Record<string, string> = {};
	if (!r || r.code !== 0) return out;
	for (const block of r.stdout.split("\n\n")) {
		const lines = block.split("\n");
		const tree = lines.find((l) => l.startsWith("worktree "))?.slice(9);
		const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
		if (tree && head) out[await realTop(tree)] = head;
	}
	return out;
}
const realTop = async (p: string): Promise<string> => { try { return await fs.promises.realpath(p); } catch { return p; } };

/** The operation kinds a shell command's own git verbs can make: a tree first seen now keeps only those. */
export function commandKinds(command: string): Set<OpLanding["kind"]> {
	const kinds = new Set<OpLanding["kind"]>();
	const verb = (v: string) => new RegExp(String.raw`\bgit\b(?:\s+-[Cc]\s+\S+|\s+-c\s+\S+)*\s+${v}\b`).test(command);
	if (verb("merge") || verb("pull")) { kinds.add("merge"); kinds.add("ff"); }
	if (verb("commit") || verb("cherry-pick") || verb("revert") || verb("am")) { kinds.add("commit"); kinds.add("merge"); }
	if (verb("rebase") || verb("pull")) kinds.add("rebase");
	if (verb("reset")) kinds.add("reset");
	return kinds;
}

/** One HEAD reflog entry: the commit HEAD moved to, when (s), and git's subject for it. */
export interface ReflogEntry { sha: string; at: number; subject: string }

/** A tree's HEAD reflog, newest first (at most `n`). */
export async function headReflog(top: string, io: SpecIO, n = 50): Promise<ReflogEntry[]> {
	const r = await io.exec("git", ["log", "-g", "--date=unix", `-n${n}`, "--format=%H%x09%gd%x09%gs", "HEAD"], { cwd: top, timeout: 10_000 }).catch(() => undefined);
	if (!r || r.code !== 0) return [];
	return r.stdout.split("\n").filter(Boolean).map((l) => {
		const [sha, sel, ...rest] = l.split("\t");
		return { sha: sha!, at: Number(/@\{(\d+)\}/.exec(sel ?? "")?.[1] ?? 0), subject: rest.join("\t") };
	});
}

/** The kind of operation a reflog subject records, or undefined for one that lands nothing (a checkout). */
export function reflogKind(subject: string): OpLanding["kind"] | undefined {
	if (/^(merge|pull)\b[^:]*: Fast-forward/.test(subject)) return "ff";
	if (/^(merge|pull)\b/.test(subject) || /^commit \(merge\)/.test(subject)) return "merge";
	if (/^commit\b/.test(subject) || /^cherry-pick\b/.test(subject) || /^revert\b/.test(subject)) return "commit";
	if (/^rebase\b/.test(subject)) return "rebase";
	if (/^reset\b/.test(subject)) return "reset";
	return undefined;
}

/**
 * The operations that moved HEAD in `top` since the last look: the reflog entries after the one that was HEAD then
 * (`was`, seen no later than `since` ms), each as the HEAD before it → after it. With no `was` (a tree first seen
 * now), entries newer than `since`. Checkouts and switches move HEAD but land nothing, so they are skipped.
 */
export function opsSince(entries: readonly ReflogEntry[], was: string | undefined, since: number): { before: string; after: string; kind: OpLanding["kind"]; subject: string }[] {
	const sec = Math.floor(since / 1000);
	let stop = entries.findIndex((e) => (was ? e.sha === was && e.at <= sec : e.at < sec));
	if (stop < 0) stop = entries.length - (was ? 0 : 1);
	const out: { before: string; after: string; kind: OpLanding["kind"]; subject: string }[] = [];
	for (let i = stop - 1; i >= 0; i--) {
		const kind = reflogKind(entries[i]!.subject);
		const before = entries[i + 1]?.sha;
		if (kind && before && before !== entries[i]!.sha) out.push({ before, after: entries[i]!.sha, kind, subject: entries[i]!.subject });
	}
	return out;
}

/**
 * After a shell command: every git operation it made in each tree it works in (the cwd, `cd`, `git -C`, a promote's
 * `--root`), from that tree's HEAD reflog; each appended to the parent's ledger and judged (judgeOp). A landing
 * (a merge that isn't master absorbed, a promote, a committed promotion) makes the turn a landing one: its foreign §
 * join the turn's list and its gate lists are kept for Stop. A promote's own `alsoChanges` joins the list too.
 */
export async function landOps(command: string, cwd: string, response: unknown, ctx: HookContext): Promise<void> {
	const turn = ctx.state.turn;
	const heads = (turn.heads ??= {});
	const since = turn.lookedAt ?? 0;
	const promote = promoteWrites(command);
	const dirs = [...new Set([cwd, ...commandDirs(command, cwd), ...(promote && commandRoot(command) ? [path.resolve(cwd, commandRoot(command)!)] : [])])];
	const ops: OpLanding[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const found = await headAt(dir, ctx.io);
		const at = found && { ...found, top: await realTop(found.top) };
		if (!at || seen.has(at.top)) continue;
		seen.add(at.top);
		const was = heads[at.top];
		if (was !== at.head || !was) {
			const allowed = commandKinds(command);
			const moved = opsSince(await headReflog(at.top, ctx.io), was, since).filter((m) => was || allowed.has(m.kind));
			if (!moved.length && was && was !== at.head && /\bgit\b/.test(command)) ops.push({ top: at.top, before: was, after: at.head, kind: gitCommits(command) ? "commit" : "merge" });
			for (const m of moved) ops.push({ top: at.top, before: m.before, after: m.after, kind: m.kind });
		}
		heads[at.top] = at.head;
		if (promote && path.resolve(dir) === path.resolve(cwd, commandRoot(command) ?? cwd)) ops.push({ top: at.top, before: at.head, after: at.head, kind: "promote" });
	}
	turn.lookedAt = Date.now();
	if (ops.length) turn.wrote = true;
	for (const op of ops) {
		if (ctx.ledger) {
			const target = op.kind === "merge" || op.kind === "ff" ? (await ctx.io.exec("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: op.top, timeout: 10_000 }).catch(() => undefined))?.stdout.trim() : undefined;
			const entry: LedgerEntry = { v: 1, at: Date.now(), actor: { runtime: "claude-code", ...(ctx.session ? { session: ctx.session } : {}) }, top: op.top, before: op.before, after: op.after, kind: op.kind, ...(target ? { target } : {}) };
			appendLedger(ctx.ledger, entry);
		}
		if (op.kind === "rebase" || op.kind === "reset") continue;
		const j = await judgeOp(op, ctx.core, ctx.io, turn.tip);
		if (!j.landing) continue;
		turn.landed = turn.wrote = true;
		if (!j.foreign) turn.partial = true;
		turn.foreign = union(turn.foreign, j.foreign ?? []);
		const listed = op.kind === "promote" ? alsoChangesOf((response as { stdout?: unknown } | undefined)?.stdout) : undefined;
		if (listed) turn.foreign = union(turn.foreign, listed);
		const l = j.lists;
		if (!l) { turn.partial = true; continue; }
		const promoted = op.kind === "promote" ? landingOf((response as { stdout?: unknown } | undefined)?.stdout) : undefined;
		(turn.landings ??= []).push({
			top: op.top, before: op.before, after: op.after, kind: op.kind, root: await findSpecRoot(op.top, (p) => ctx.io.exists(p)),
			unmapped: [...new Set([...l.unmappedChanged.map((u) => u.path), ...(promoted?.unmapped ?? [])])].sort(),
			unpromoted: [...l.unpromotedDrafts, ...(promoted?.unpromoted ?? [])],
			advisory: [...new Set([...l.mappedUntouched.map((m) => m.id), ...(promoted?.advisory ?? [])])].sort(),
			...(j.onDefault ? { onDefault: true } : {}),
		});
	}
}

/** The landing lists of a `promote … --json` result. */
function landingOf(stdout: unknown): { unmapped: string[]; unpromoted: TurnLanding["unpromoted"]; advisory: string[] } | undefined {
	if (typeof stdout !== "string") return undefined;
	try {
		const v = JSON.parse(stdout);
		if (!Array.isArray(v?.unmappedChanged)) return undefined;
		return {
			unmapped: v.unmappedChanged.map((u: { path?: unknown }) => u?.path).filter((p: unknown): p is string => typeof p === "string"),
			unpromoted: (Array.isArray(v.unpromotedDrafts) ? v.unpromotedDrafts : []).filter((d: { ids?: unknown }) => Array.isArray(d?.ids)),
			advisory: (Array.isArray(v.mappedUntouched) ? v.mappedUntouched : []).map((m: { id?: unknown }) => m?.id).filter((x: unknown): x is string => typeof x === "string"),
		};
	} catch { return undefined; }
}

/**
 * The gate's lists as they stand at Stop: a file some claim in the current spec now maps is no longer unmapped,
 * and a draft record promoted since the landing is no longer unpromoted (each draft's status read again). Records
 * still unpromoted after a landing on the default branch are `unpromotedAtDefault`: no Deferred line passes them.
 */
export async function gateNow(landings: readonly TurnLanding[], core: string, io: SpecIO): Promise<{ unmapped: string[]; unpromoted: string[]; unpromotedAtDefault: string[]; advisory: string[] }> {
	const unmapped = new Set<string>(), unpromoted = new Set<string>(), atDefault = new Set<string>(), advisory = new Set<string>();
	const mapped = new Map<string, Set<string>>();
	const statusOf = new Map<string, Set<string> | undefined>();
	for (const l of landings) {
		for (const id of l.advisory) advisory.add(id);
		if (l.root && !mapped.has(l.root)) {
			const set = new Set<string>();
			try {
				const m = JSON.parse(await io.readFile(path.join(l.root, ".sova/spec/manifest.json")));
				for (const rec of Object.values(m?.claims ?? {}) as { code?: unknown }[]) for (const c of Array.isArray(rec?.code) ? rec.code : []) if (typeof c === "string") set.add(path.posix.normalize(c));
			} catch { /* no current spec: nothing newly mapped */ }
			mapped.set(l.root, set);
		}
		// Paths are relative to the spec root, as the core reports them and claims map them.
		for (const p of l.unmapped) if (!mapped.get(l.root ?? "")?.has(p)) unmapped.add(p);
		for (const d of l.unpromoted) {
			const where = d.worktree ?? l.root ?? l.top;
			const key = `${where}\0${d.draft}`;
			if (!statusOf.has(key)) {
				const r = await io.exec("node", [path.join(core, "sova-spec-draft.mjs"), "status", d.draft, "--root", where, "--json"], { cwd: where, timeout: 30_000 }).catch(() => undefined);
				let open: Set<string> | undefined;
				try {
					const s = JSON.parse(r?.stdout ?? "");
					const promoted = new Set<string>((Array.isArray(s?.promotions) ? s.promotions : []).flatMap((x: { ids?: unknown }) => (Array.isArray(x?.ids) ? x.ids : [])));
					open = new Set((Array.isArray(s?.ids) ? s.ids : []).filter((i: { id: string; current: string }) => i.current === "pending" || (i.current === "conflict" && !promoted.has(i.id))).map((i: { id: string }) => i.id));
				} catch { open = undefined; }
				statusOf.set(key, open);
			}
			const open = statusOf.get(key);
			for (const id of d.ids) if (!open || open.has(id)) (l.onDefault ? atDefault : unpromoted).add(id);
		}
	}
	return { unmapped: [...unmapped].sort(), unpromoted: [...unpromoted].sort(), unpromotedAtDefault: [...atDefault].sort(), advisory: [...advisory].sort() };
}

/**
 * The pi session's SpecWriteGuard, for a hook that is a fresh process per call: the tree as the previous
 * hook call left it (the turn's `view`) stands in for "before". Two notes, in the guard's own words: the
 * current spec written by hand (an edit on it, or a shell command that is neither a draft tool nor git),
 * and a git operation after which a draft's evidence commit is no longer on the branch.
 */
export async function writeGuard(tool: string, input: HookInput, cwd: string, before: GitView | undefined, view: GitView | undefined, ctx: HookContext): Promise<{ text?: string; lost: string[] }> {
	const ti = input.tool_input ?? {};
	if (WRITE_TOOLS.has(tool)) {
		const file = typeof ti.file_path === "string" ? ti.file_path : typeof ti.notebook_path === "string" ? ti.notebook_path : undefined;
		return { text: file && currentSpecPath(path.isAbsolute(file) ? file : path.join(cwd, file)) ? directWriteNote([file]) : undefined, lost: [] };
	}
	const command = tool === "Bash" && typeof ti.command === "string" ? ti.command : undefined;
	if (!command || !before || !view || before.top !== view.top) return { lost: [] };
	const notes: string[] = [], said: string[] = [];
	if (!sanctionedSpecWrite(command)) {
		const written = Object.keys(view.files).filter((p) => currentSpecPath(p) && before.files[p] !== view.files[p]);
		if (written.length) notes.push(directWriteNote(written));
	}
	if (before.head && view.head && before.head !== view.head) {
		const root = await findSpecRoot(cwd, (p) => ctx.io.exists(p));
		const git = (args: string[]) => ctx.io.exec("git", args, { cwd: view.top, timeout: 10_000 });
		const lost = [];
		for (const e of root ? await evidenceCommits(root, ctx.io) : [])
			if ((await git(["merge-base", "--is-ancestor", e.commit, before.head])).code === 0 && (await git(["merge-base", "--is-ancestor", e.commit, view.head])).code !== 0) lost.push(e);
		if (lost.length) notes.push(rewriteNote(lost, before.head, await rebaseUnderway(view.top, ctx.io)));
		said.push(...lost.map((e) => e.commit));
	}
	return { text: notes.length ? notes.join("\n") : undefined, lost: said };
}

/** The foreign § the drafts this turn edited change (a draft edit is a write git can't see). */
async function draftEdits(turn: TurnState, ctx: HookContext): Promise<string[] | undefined> {
	if (!turn.root || !turn.drafts) return undefined;
	const touched = draftsTouched(turn.drafts, await draftStamps(turn.root, ctx.io));
	if (!touched.length) return undefined;
	let foreign: string[] = [];
	for (const name of touched) {
		const ids = await draftForeign(turn.root, name, ctx.core, ctx.io);
		if (!ids) turn.partial = true;
		foreign = union(foreign, ids ?? []);
	}
	return foreign;
}

export async function onStop(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const turn = ctx.state.turn;
	const reply = input.last_assistant_message ?? "";
	const block = (reason: string): HookOutput => { turn.blocks++; return { decision: "block", reason }; };
	const drafted = await draftEdits(turn, ctx);
	if (drafted) turn.wrote = true;
	if (turn.landed) {
		// The computed list is the authority: sent back until it is named (or an omission overridden), boundedly.
		// When Git computed all of it, a § named beyond it (and beyond the advisory § whose code changed) is an extra,
		// which no override excuses. The landing gate: unmapped files need a Plumbing line, unpromoted records a Deferred
		// one, except at a landing on the default branch, where only a promotion or the override line passes them.
		const foreign = union(turn.foreign, drafted ?? []);
		if (turn.blocks >= MERGE_BLOCKS) return undefined;
		const gate = await gateNow(turn.landings ?? [], ctx.core, ctx.io);
		const check = checkAlsoChanges(reply, { required: true, foreign, exact: !turn.partial, advisory: gate.advisory, unmapped: gate.unmapped, unpromoted: gate.unpromoted, unpromotedAtDefault: gate.unpromotedAtDefault });
		if (check.ok) return undefined;
		return block(repromptText(check, foreign, "promoted or merged"));
	}
	// Elsewhere a warning: sent back once (stop_hook_active marks the retry), then let through.
	if (input.stop_hook_active || turn.blocks >= 1) return undefined;
	const ids = parseAlsoChanges(lastLine(reply));
	if (!turn.wrote) {
		const qa = checkAlsoChanges(reply, { required: false, foreign: [], forbidden: true });
		return qa.ok ? undefined
			: block(`${CHECK_TAG} This turn changed no files, so its reply carries no \`Also changes:\` line; drop it. If it is right because you did change files, repeat your reply unchanged.`);
	}
	// Census foreign § may be plumbing (none is fine); a foreign § the turn's draft edits is not.
	const check = checkAlsoChanges(reply, { required: true, foreign: drafted ?? [] });
	if (!check.ok) {
		return block(`${CHECK_TAG} This turn changed files: ${describeProblem(check)}. End your reply with exactly "Also changes: §X — <what>" or "Also changes: none" as its last line, nothing after it. If it is right as written, repeat your reply unchanged.`);
	}
	// The census's foreign list, when it ran: a named § it never saw touched is a new claim or a guess.
	const seen = union(ctx.state.census.foreign, drafted ?? []);
	const unseen = seen.length ? (ids ?? []).filter((id) => !seen.includes(id)) : [];
	if (unseen.length) {
		return block(`${CHECK_TAG} Your last line names ${unseen.join(", ")}, which the census never saw this session's changes touch (it saw ${seen.join(", ")}). It names foreign § only, never your new claims. Fix it, or repeat your reply unchanged if it is right.`);
	}
	return undefined;
}

/** One hook call: read the state, run the event, write the state, log what was said. */
export async function runHook(event: string, input: HookInput, o: { core: string; stateDir: string; io?: SpecIO; ledger?: string }): Promise<HookOutput> {
	const file = input.session_id ? statePath(o.stateDir, input.session_id) : undefined;
	if (!file) return undefined;
	const ledger = o.ledger ?? process.env[LEDGER_ENV];
	const ctx: HookContext = { core: o.core, state: readState(file), io: o.io ?? localIO, ...(ledger ? { ledger } : {}), session: input.session_id };
	const out = event === "turn" ? await onTurn(input, ctx) : event === "post" ? await onPost(input, ctx) : event === "stop" ? await onStop(input, ctx) : undefined;
	writeState(file, ctx.state);
	if (out) fs.appendFileSync(file.replace(/\.json$/, ".log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, tool: input.tool_name, out })}\n`, { mode: 0o600 });
	return out;
}

async function main(argv: string[]): Promise<void> {
	const event = argv[0] ?? "";
	const flag = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
	const core = flag("--core"), stateDir = flag("--state"), ledger = flag("--ledger");
	if (!core || !stateDir) return;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
	const out = await runHook(event, input, { core, stateDir, ...(ledger ? { ledger } : {}) });
	if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SPEC_HOOK_SCRIPT) {
	main(process.argv.slice(2)).catch(() => { /* a hook never stops a worker */ }).finally(() => process.exit(0));
}
