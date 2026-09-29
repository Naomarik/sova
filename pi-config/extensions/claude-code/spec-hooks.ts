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
 *   notes whether the turn wrote, and the foreign § a `promote --write` lists (`alsoChanges`) or a
 *   `git merge` into the default branch landed (`sova-spec.mjs foreign`, that branch before vs after; a merge of
 *   master into a feature branch lands nothing).
 * - Stop (`stop`): the reply's last line against the turn. After a promote or a merge the computed
 *   foreign list is the authority: every § in it must be named, and the reply is sent back (block)
 *   until it is or it carries the override line, at most MERGE_BLOCKS times. Elsewhere a miss is a
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
	CHECK_TAG, censusStep, checkAlsoChanges, defaultBranch, describeProblem, draftForeign, draftStamps, draftsTouched, findSpecRoot, foreignBetween, freshCensusState, gitCommits, gitMerges, gitView,
	lastLine, localIO, parseAlsoChanges, promoteWrites, repromptText, viewChanged, type CensusState, type GitView, type SpecIO,
} from "../mode/spec-guard.ts";

export const SPEC_HOOK_SCRIPT = fileURLToPath(import.meta.url);
/** Hook timeout, seconds: a census over a large tree stays well under it. */
const HOOK_TIMEOUT_S = 60;
/** How many times a merge/promote turn's reply is sent back before it is let through. */
export const MERGE_BLOCKS = 2;
/** Tools that never write: no git status for them. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "BashOutput"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Settings = Record<string, unknown>;
interface HookEntry { type: "command"; command: string; timeout: number }
interface HookMatcher { matcher?: string; hooks: HookEntry[] }

const shellQuote = (value: string): string => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** The `hooks` settings block for the three events, run by `node` (the parent's runtime). */
export function specHookSettings(o: { node: string; coreDir: string; stateDir: string; script?: string }): Settings {
	const command = (event: string): HookEntry => ({
		type: "command",
		command: [o.node, o.script ?? SPEC_HOOK_SCRIPT, event, "--core", o.coreDir, "--state", o.stateDir].map(shellQuote).join(" "),
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
	/** Stop-hook send-backs this turn. */
	blocks: number;
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
export interface HookContext { core: string; state: HookState; io: SpecIO }
/** What Claude reads from stdout; undefined = print nothing. */
export type HookOutput = Record<string, unknown> | undefined;

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort();

/** A turn starts: the tree as it is now is its baseline (and the census's, the first time). */
export async function onTurn(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const cwd = input.cwd ?? process.cwd();
	const view = await gitView(cwd, ctx.io);
	const root = await findSpecRoot(cwd, (p) => ctx.io.exists(p));
	ctx.state.turn = { ...freshTurn(), id: input.prompt_id, view, head: view?.head, ...(root ? { root, drafts: await draftStamps(root, ctx.io) } : {}) };
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
	if (command && view) {
		const root = await findSpecRoot(cwd, (p) => ctx.io.exists(p));
		if (root && promoteWrites(command)) {
			// The promote's own list; without --json output, what the spec changed since just before it (never since the
			// turn began: a `git merge master` earlier in the turn brought master's § in, and they are not this promote's).
			const listed = alsoChangesOf((input.tool_response as { stdout?: unknown } | undefined)?.stdout);
			const base = before?.head ?? turn.head;
			const computed = listed ?? (base ? await foreignBetween(root, base, undefined, ctx.core, ctx.io) : undefined);
			turn.landed = turn.wrote = true;
			turn.foreign = union(turn.foreign, computed ?? []);
		}
		// A merge lands only on the default branch; merging master INTO a feature branch brings master's own § in.
		if (root && gitMerges(command) && before?.head && view.head && view.head !== before.head && (await landsOnTarget(view.top, ctx.io))) {
			turn.landed = turn.wrote = true;
			turn.foreign = union(turn.foreign, (await foreignBetween(root, before.head, view.head, ctx.core, ctx.io)) ?? []);
		}
	}
	const step = await censusStep(state.census, { cwd, toolName: tool, input: input.tool_input ?? {}, commands: state.commands, sessionStart: state.sessionStart }, ctx.core, ctx.io);
	state.census = step.state;
	if (step.result.failure) return { systemMessage: step.result.failure };
	if (!step.result.text) return undefined;
	return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: step.result.text } };
}

/** The checkout at `top` is on the default branch (spec-guard's defaultBranch: origin/HEAD, else master, else main). */
export async function landsOnTarget(top: string, io: SpecIO): Promise<boolean> {
	const branch = await io.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: top, timeout: 10_000 }).catch(() => undefined);
	if (!branch || branch.code !== 0) return false;
	const target = await defaultBranch(top, io).catch(() => undefined);
	return !!target && branch.stdout.trim() === target;
}

/** The foreign § the drafts this turn edited change (a draft edit is a write git can't see). */
async function draftEdits(turn: TurnState, ctx: HookContext): Promise<string[] | undefined> {
	if (!turn.root || !turn.drafts) return undefined;
	const touched = draftsTouched(turn.drafts, await draftStamps(turn.root, ctx.io));
	if (!touched.length) return undefined;
	let foreign: string[] = [];
	for (const name of touched) foreign = union(foreign, (await draftForeign(turn.root, name, ctx.core, ctx.io)) ?? []);
	return foreign;
}

export async function onStop(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const turn = ctx.state.turn;
	const reply = input.last_assistant_message ?? "";
	const block = (reason: string): HookOutput => { turn.blocks++; return { decision: "block", reason }; };
	const drafted = await draftEdits(turn, ctx);
	if (drafted) turn.wrote = true;
	if (turn.landed) {
		// The computed list is the authority: sent back until it is named (or overridden), boundedly.
		const foreign = union(turn.foreign, drafted ?? []);
		const check = checkAlsoChanges(reply, { required: true, foreign });
		if (check.ok || turn.blocks >= MERGE_BLOCKS) return undefined;
		return block(repromptText(check, foreign, "promoted or merged"));
	}
	// Elsewhere a warning: sent back once (stop_hook_active marks the retry), then let through.
	if (input.stop_hook_active || turn.blocks >= 1) return undefined;
	const ids = parseAlsoChanges(lastLine(reply));
	if (!turn.wrote) {
		return ids === undefined ? undefined
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
export async function runHook(event: string, input: HookInput, o: { core: string; stateDir: string; io?: SpecIO }): Promise<HookOutput> {
	const file = input.session_id ? statePath(o.stateDir, input.session_id) : undefined;
	if (!file) return undefined;
	const ctx: HookContext = { core: o.core, state: readState(file), io: o.io ?? localIO };
	const out = event === "turn" ? await onTurn(input, ctx) : event === "post" ? await onPost(input, ctx) : event === "stop" ? await onStop(input, ctx) : undefined;
	writeState(file, ctx.state);
	if (out) fs.appendFileSync(file.replace(/\.json$/, ".log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, tool: input.tool_name, out })}\n`, { mode: 0o600 });
	return out;
}

async function main(argv: string[]): Promise<void> {
	const event = argv[0] ?? "";
	const flag = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
	const core = flag("--core"), stateDir = flag("--state");
	if (!core || !stateDir) return;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
	const out = await runHook(event, input, { core, stateDir });
	if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SPEC_HOOK_SCRIPT) {
	main(process.argv.slice(2)).catch(() => { /* a hook never stops a worker */ }).finally(() => process.exit(0));
}
