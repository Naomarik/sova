/**
 * Spec hooks for Claude Code workers: the worker half of the census (mode/spec-guard.ts holds the
 * census step and its digest, shared with the pi session's own hooks).
 *
 * The subagents spawn path installs them, while the spawning session has spec mode on, through
 * the one `--settings` JSON (withClaudeSettings merges them into the sandbox's settings, if any);
 * `--setting-sources ""` leaves flag settings in force, hooks included (probed with CLI 2.1.282).
 * Claude runs each hook as a fresh process: `node spec-hooks.ts <event> --core <dir> --state <dir>`
 * with the event's JSON on stdin, so everything that spans calls lives in one state file per
 * Claude session under `--state` (plus `<session>.log.jsonl`, one line per hook that spoke).
 *
 * - UserPromptSubmit (`turn`): primes the census baseline of the tree the turn starts in.
 * - PreToolUse (`pre`, any tool): the baseline of each other tree the call names (`cd <dir>`,
 *   `git -C <dir>`, a file path), before it runs. In a tree already known, and at a turn's start,
 *   what changed since the last look changed between the session's calls (another process): taken in
 *   silently, kept out of every note (settleCensus), unless another call of this session is running.
 * - PostToolUse and PostToolUseFailure (`post`, any tool, Bash included): the census step (censusStep,
 *   the same one the pi session runs) on a git-status delta, its `[spec census]` digest and the write
 *   guard's notes returned as additionalContext. A failed call (a Bash command that exits non-zero)
 *   comes as PostToolUseFailure and is closed the same way: its own writes still count, and it stops
 *   holding the settle off.
 * - PermissionDenied (`deny`): the call never ran, so it stops counting as running, with no census. A census that can't run is said once per cause per work tree
 *   (censusStep keeps that in the tree's CensusState, which this state file holds), until a census
 *   there succeeds again.
 *
 * Nothing runs when a turn ends. A worker started before that change still calls `stop` and may pass
 * `--ledger`: both are accepted and do nothing.
 *
 * Node builtins and mode/spec-guard.ts only (both run under node's type stripping: erasable TS).
 * A hook that fails says nothing and exits 0: it never stops a worker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	callDirs, censusStep, currentSpecPath, directWriteNote, evidenceCommits, findSpecRoot, freshCensusState, gitView, handWritten, localIO, rebaseUnderway, rewriteNote, settleCensus, silentCensusStep,
	type CensusState, type GitView, type SpecIO,
} from "../mode/spec-guard.ts";

export const SPEC_HOOK_SCRIPT = fileURLToPath(import.meta.url);
/** Hook timeout, seconds: a census over a large tree stays well under it. */
const HOOK_TIMEOUT_S = 60;
/** Tools that never write the repository, by exact name: no git status, no census for them. */
export const READ_ONLY: ReadonlySet<string> = new Set([
	"Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "BashOutput",
	// The team MCP tools write only the team's mailboxes, never the repo; a new team tool is not skipped until listed here.
	"mcp__team__team_inbox", "mcp__team__team_msg", "mcp__team__team_ask", "mcp__team__team_roster", "mcp__team__team_report", "mcp__team__wake_nudge",
]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Settings = Record<string, unknown>;
interface HookEntry { type: "command"; command: string; timeout: number }
interface HookMatcher { matcher?: string; hooks: HookEntry[] }

const shellQuote = (value: string): string => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** The `hooks` settings block for the five events, run by `node` (the parent's runtime). */
export function specHookSettings(o: { node: string; coreDir: string; stateDir: string; script?: string }): Settings {
	const command = (event: string): HookEntry => ({
		type: "command",
		command: [o.node, o.script ?? SPEC_HOOK_SCRIPT, event, "--core", o.coreDir, "--state", o.stateDir].map(shellQuote).join(" "),
		timeout: HOOK_TIMEOUT_S,
	});
	return {
		hooks: {
			UserPromptSubmit: [{ hooks: [command("turn")] }],
			PreToolUse: [{ matcher: "*", hooks: [command("pre")] }],
			PostToolUse: [{ matcher: "*", hooks: [command("post")] }],
			// A failed call (Bash exiting non-zero) skips PostToolUse: the same step closes it.
			PostToolUseFailure: [{ matcher: "*", hooks: [command("post")] }],
			// A denied call never ran: it is closed, nothing else.
			PermissionDenied: [{ matcher: "*", hooks: [command("deny")] }],
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
	/** The cwd's work tree at the last look (the turn's start, then after each tool). */
	view?: GitView;
	/** Each work tree at the last look, by top: the write guard's "before". */
	views?: Record<string, GitView>;
}
export interface HookState {
	version: 1;
	/** When the hooks first saw this session (ISO): pickDraft's fallback. */
	sessionStart: string;
	census: CensusState;
	censuses?: Record<string, CensusState>;
	/** This session's shell commands, newest last (bounded): the drafts it created. */
	commands: string[];
	turn: TurnState;
	/** Calls between their pre and post hooks, by tool_use_id (ISO start): while one runs, nothing is settled. */
	open?: Record<string, string>;
}
const MAX_COMMANDS = 200;
/** A call whose post or deny hook never came (blocked by another hook, interrupted) stops counting as running after this long. */
const OPEN_TTL_MS = 15 * 60_000;
const freshState = (): HookState => ({ version: 1, sessionStart: new Date().toISOString(), census: freshCensusState(), commands: [], turn: {} });

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
export function statePath(stateDir: string, sessionId: string): string | undefined {
	return SESSION.test(sessionId) ? path.join(stateDir, `${sessionId}.json`) : undefined;
}
export function readState(file: string): HookState {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (value?.version === 1 && value.turn && value.census && Array.isArray(value.commands)) {
			// An older state file's turn carries fields only the retired turn-end check read: dropped.
			return { ...freshState(), ...value, turn: { view: value.turn.view, views: value.turn.views } };
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

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface HookInput {
	session_id?: string;
	prompt_id?: string;
	cwd?: string;
	hook_event_name?: string;
	tool_name?: string;
	tool_use_id?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
}
export interface HookContext { core: string; state: HookState; io: SpecIO }
/** What Claude reads from stdout; undefined = print nothing. */
export type HookOutput = Record<string, unknown> | undefined;

/**
 * A turn starts: the tree as it is now is its baseline the first time; a tree already known takes in what
 * changed since the last look (settleCensus: between the session's calls, never its own).
 */
export async function onTurn(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const cwd = input.cwd ?? process.cwd();
	const { state } = ctx;
	const view = await gitView(cwd, ctx.io);
	state.turn = view ? { view, views: { [view.top]: view } } : {};
	state.censuses ??= {};
	delete state.open;
	if (!view) return undefined;
	const previous = state.census.top === view.top ? state.census : state.censuses[view.top] ?? freshCensusState();
	state.censuses[view.top] = previous.top === view.top ? await settleCensus(previous, cwd, ctx.io) : await silentCensusStep(previous, { cwd, toolName: "", input: undefined }, ctx.core, ctx.io);
	state.census = state.censuses[view.top]!;
	return undefined;
}

/**
 * Observe explicit destinations before execution; never permission-gate or block the call. A tree not
 * seen yet gets its baseline; a known one, when no other call is running, takes in what changed since
 * the last look (settleCensus).
 */
export async function onPre(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	const tool = input.tool_name ?? "";
	if (READ_ONLY.has(tool)) return undefined;
	const cwd = input.cwd ?? process.cwd();
	const { state } = ctx;
	state.turn.views ??= {};
	state.censuses ??= {};
	const now = Date.now();
	const open = Object.fromEntries(Object.entries(state.open ?? {}).filter(([id, at]) => id !== input.tool_use_id && now - Date.parse(at) < OPEN_TTL_MS));
	const alone = !Object.keys(open).length;
	for (const dir of callDirs({ cwd, toolName: tool, input: input.tool_input })) {
		const view = await gitView(dir, ctx.io).catch(() => undefined);
		if (!view) continue;
		state.turn.views[view.top] = view;
		const prior = state.census.top === view.top ? state.census : state.censuses[view.top] ?? freshCensusState();
		const next = prior.top !== view.top ? await silentCensusStep(prior, { cwd: dir, toolName: "", input: undefined }, ctx.core, ctx.io) : alone ? await settleCensus(prior, dir, ctx.io) : prior;
		state.censuses[view.top] = next;
		if (state.census.top === view.top) state.census = next;
	}
	if (input.tool_use_id) open[input.tool_use_id] = new Date(now).toISOString();
	if (Object.keys(open).length) state.open = open;
	else delete state.open;
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
	if (input.tool_use_id && state.open) {
		delete state.open[input.tool_use_id];
		if (!Object.keys(state.open).length) delete state.open;
	}
	const texts: string[] = [];
	const done = new Set<string>();
	state.censuses ??= {};
	turn.views ??= {};
	for (const dir of callDirs({ cwd, toolName: tool, input: input.tool_input })) {
		const view = await gitView(dir, ctx.io);
		if (!view || done.has(view.top)) continue;
		done.add(view.top);
		const before = turn.views[view.top] ?? (turn.view?.top === view.top ? turn.view : undefined);
		turn.views[view.top] = view;
		if (path.resolve(dir) === path.resolve(cwd)) turn.view = view;
		const g = await writeGuard(tool, input, dir, before, view, ctx).catch(() => ({ text: undefined, lost: [] as string[] }));
		const prior = path.resolve(dir) === path.resolve(cwd) && state.census.top === view.top ? state.census : state.censuses[view.top] ?? freshCensusState();
		const step = await censusStep(prior, { cwd: dir, toolName: tool, input: input.tool_input ?? {}, commands: state.commands, sessionStart: state.sessionStart, orphansSaid: g.lost }, ctx.core, ctx.io);
		state.censuses[view.top] = step.state;
		if (path.resolve(dir) === path.resolve(cwd)) state.census = step.state;
		// A failure is the model's line, set once per cause per tree (the tree's CensusState, kept here) until a census succeeds.
		texts.push(...[g.text, step.result.text, step.result.failure].filter((s): s is string => Boolean(s)));
	}
	const text = texts.join("\n");
	if (!text) return undefined;
	const hookEventName = input.hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse";
	return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

/** A denied call (PermissionDenied) never ran: it stops counting as running; no census, nothing said. */
export async function onDeny(input: HookInput, ctx: HookContext): Promise<HookOutput> {
	if (input.tool_use_id && ctx.state.open) {
		delete ctx.state.open[input.tool_use_id];
		if (!Object.keys(ctx.state.open).length) delete ctx.state.open;
	}
	return undefined;
}

/**
 * The pi session's SpecWriteGuard, for a hook that is a fresh process per call: the tree as the previous
 * hook call left it (the turn's `view`) stands in for "before". Two notes, in the guard's own words: the
 * current spec written by hand (an edit on it, or a shell command's change handWritten judges by the files),
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
	const written = await handWritten(view.top, Object.keys(view.files).filter((p) => currentSpecPath(p) && before.files[p] !== view.files[p]), ctx.io);
	if (written.length) notes.push(directWriteNote(written));
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

/**
 * One hook call: read the state, run the event, write the state, log what was said. `stop` (and any
 * other event) does nothing; `ledger` is accepted from workers started before the turn-end check went.
 */
export async function runHook(event: string, input: HookInput, o: { core: string; stateDir: string; io?: SpecIO; ledger?: string }): Promise<HookOutput> {
	const run = event === "turn" ? onTurn : event === "pre" ? onPre : event === "post" ? onPost : event === "deny" ? onDeny : undefined;
	const file = input.session_id ? statePath(o.stateDir, input.session_id) : undefined;
	if (!run || !file) return undefined;
	const ctx: HookContext = { core: o.core, state: readState(file), io: o.io ?? localIO };
	const out = await run(input, ctx);
	writeState(file, ctx.state);
	if (out) fs.appendFileSync(file.replace(/\.json$/, ".log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, tool: input.tool_name, out })}\n`, { mode: 0o600 });
	return out;
}

async function main(argv: string[]): Promise<void> {
	const event = argv[0] ?? "";
	const flag = (name: string) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : undefined; };
	const core = flag("--core"), stateDir = flag("--state");
	// `stop` comes from workers spawned before the turn-end check went: nothing to read or say.
	if (!core || !stateDir || !["turn", "pre", "post", "deny"].includes(event)) return;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
	const out = await runHook(event, input, { core, stateDir });
	if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SPEC_HOOK_SCRIPT) {
	main(process.argv.slice(2)).catch(() => { /* a hook never stops a worker */ }).finally(() => process.exit(0));
}
