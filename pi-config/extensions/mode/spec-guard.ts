/**
 * The spec minor mode's mechanical checks, so the discipline in spec-mode.md holds without the model
 * remembering it:
 *
 * - **Census on a Git delta** (CensusHook): after any tool call, bash included, compare the work tree's
 *   `git status` with what the session saw before. On the first changed file in the spec boundary, and on
 *   each new file, run the read-only `sova-spec.mjs census --changed` and hand back a short digest tagged
 *   `[spec census]` for the caller to append to that tool result. A bash heredoc edit is caught like an
 *   edit call. Without a task draft the digest says so.
 * - **The `Also changes:` line** (checkAlsoChanges): the last line of a reply on a turn that edited,
 *   committed, promoted or merged, checked against the foreign § computed from Git (`sova-spec.mjs foreign`,
 *   the worktrees merge event). The caller blocks (one re-prompt) on merge/promote turns, warns elsewhere.
 *
 * Plain node: builtins only, erasable TypeScript only, no pi types — the mode extension's hooks
 * (index.ts) and the Claude Code workers' hook script (subagents) import the same code. Everything that
 * touches the machine goes through `SpecIO`, local by default. The census state is plain JSON
 * (CensusState), so a caller whose hooks are separate processes can keep it in a file.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

const { dirname, join, relative } = posix;

export const DIGEST_TAG = "[spec census]";
export const CHECK_TAG = "[spec check]";
/** The line a reply writes, right above its last line, when the computed foreign list is wrong. */
export const ALSO_CHANGES_OVERRIDE = "Spec check override:";
export const TOOL_TIMEOUT_MS = 5000;
/** Files and ids shown before "+N more". */
export const FILE_CAP = 8;
export const ID_CAP = 12;
const SPEC_REL = ".sova/spec";

/** The hook's view of the machine the tools run on. Methods may be sync or async. */
export interface SpecIO {
	exec(command: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<{ stdout: string; code: number }>;
	exists(path: string): boolean | Promise<boolean>;
	/** Entry names; throws (or rejects) when the directory can't be read. */
	readDir(path: string): string[] | Promise<string[]>;
	/** UTF-8 text; throws (or rejects) when the file can't be read. */
	readFile(path: string): string | Promise<string>;
	/** Modification time in ms, or undefined for a missing file. */
	mtime(path: string): number | undefined | Promise<number | undefined>;
}

/** This machine: node's own spawn (no shell) and fs. */
export const localIO: SpecIO = {
	exec: (command, args, { cwd, timeout, signal }) =>
		new Promise((resolve) => {
			let stdout = "";
			const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"], timeout, signal });
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.on("error", () => resolve({ stdout: "", code: 1 }));
			child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
		}),
	exists: existsSync,
	readDir: (path) => readdirSync(path),
	readFile: (path) => readFileSync(path, "utf8"),
	mtime: (path) => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
	},
};

/** The trusted core directory, resolved as spec-mode.md's `$core` shell line does (minor.ts SPEC_CORE_SHELL). */
export function coreDir(env: Record<string, string | undefined>, home: string): string {
	let agent = env.PI_CODING_AGENT_DIR || `${home}/.pi/agent`;
	if (agent === "~" || agent.startsWith("~/")) agent = home + agent.slice(1);
	return `${agent}/extensions/spec/core`;
}

// ── The work tree as Git sees it ─────────────────────────────────────────────

/** One look at a work tree: HEAD, and each changed path (relative to the top) with its mtime. */
export interface GitView {
	top: string;
	head: string | null;
	/** path → mtime (ms; 0 for a deleted file). */
	files: Record<string, number>;
}

/** Paths out of `git status --porcelain -z`: a rename's entry carries its source as a second field. */
export function parsePorcelain(z: string): string[] {
	const parts = z.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[0] === "C") i++;
	}
	return paths;
}

/** The work tree at `cwd`, or undefined outside Git. Never throws. */
export async function gitView(cwd: string, io: SpecIO = localIO, signal?: AbortSignal): Promise<GitView | undefined> {
	try {
		const opts = { cwd, timeout: TOOL_TIMEOUT_MS, signal };
		const top = await io.exec("git", ["rev-parse", "--show-toplevel"], opts);
		if (top.code !== 0) return undefined;
		const root = top.stdout.trim();
		const status = await io.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { ...opts, cwd: root });
		if (status.code !== 0) return undefined;
		const head = await io.exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { ...opts, cwd: root });
		const files: Record<string, number> = {};
		for (const p of parsePorcelain(status.stdout)) files[p] = (await io.mtime(join(root, p))) ?? 0;
		return { top: root, head: head.code === 0 ? head.stdout.trim() : null, files };
	} catch {
		return undefined;
	}
}

/** Did anything change between two looks: HEAD, a path, or a changed file's mtime. */
export function viewChanged(before: GitView | undefined, after: GitView | undefined): boolean {
	if (!before || !after) return false;
	if (before.top !== after.top || before.head !== after.head) return true;
	const a = Object.keys(before.files);
	const b = Object.keys(after.files);
	return a.length !== b.length || b.some((p) => before.files[p] !== after.files[p]);
}

// ── Census on a Git delta ────────────────────────────────────────────────────

/** The project root: the nearest directory at or above cwd holding `.sova/spec/manifest.json`. */
export async function findSpecRoot(cwd: string, exists: SpecIO["exists"] = existsSync): Promise<string | undefined> {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (await exists(join(dir, SPEC_REL, "manifest.json"))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

const DRAFT_NEW = /sova-spec-draft\.mjs["']?\s+new\s+["']?([a-z0-9][a-z0-9_-]{0,63})\b/g;

/** Draft names created by `sova-spec-draft.mjs new <name> … --write` among these shell commands, in order. */
export function draftsCreated(commands: readonly string[]): string[] {
	const names: string[] = [];
	for (const command of commands) if (/--write\b/.test(command)) for (const m of command.matchAll(DRAFT_NEW)) names.push(m[1]);
	return names;
}

/** The bash commands the assistant ran on a pi session branch (pi's message entries, read structurally). */
export function bashCommands(branch: readonly unknown[]): string[] {
	const commands: string[] = [];
	for (const entry of branch) {
		const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
		if ((entry as { type?: string }).type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as { type?: string; name?: string; arguments?: { command?: unknown } }[]) {
			const command = part?.type === "toolCall" && part.name === "bash" ? part.arguments?.command : undefined;
			if (typeof command === "string") commands.push(command);
		}
	}
	return commands;
}

/**
 * The task's draft, as a project-relative `--spec` dir: the last draft this session created (from its
 * shell commands), else the newest draft created at or after the session start, else none.
 */
export async function pickDraft(root: string, commands: readonly string[], sessionStart: string | undefined, io: SpecIO = localIO): Promise<string | undefined> {
	const specOf = (name: string) => `${SPEC_REL}/drafts/${name}/spec`;
	const has = async (name: string) => Boolean(await io.exists(join(root, specOf(name), "manifest.json")));
	for (const name of draftsCreated(commands).reverse()) if (await has(name)) return specOf(name);
	const since = sessionStart ? Date.parse(sessionStart) : NaN;
	if (Number.isNaN(since)) return undefined;
	let names: string[];
	try {
		names = await io.readDir(join(root, SPEC_REL, "drafts"));
	} catch {
		return undefined;
	}
	let best: { name: string; at: number } | undefined;
	for (const name of names) {
		try {
			const at = Date.parse(JSON.parse(await io.readFile(join(root, SPEC_REL, "drafts", name, "draft.json"))).createdAt);
			if (at >= since && (!best || at > best.at) && (await has(name))) best = { name, at };
		} catch {
			// Not a draft, or unreadable: not the task's.
		}
	}
	return best && specOf(best.name);
}

/** The parts of a `census --changed --json` the digest reports. */
export interface CensusView {
	foreignNote: string;
	foreign: string[];
	/** In-boundary changed files a claim maps, with their §. */
	claimed: { path: string; claims: string[] }[];
	/** null without a boundary: nothing is judged unclaimed. */
	unclaimed: string[] | null;
	/** Changed files outside the boundary that a claim's `code` maps. */
	mappedOutside: { path: string; claims: string[] }[];
	childUnderForeign: { id: string; parent: string }[];
}

const pathClaims = (value: unknown): { path: string; claims: string[] }[] =>
	Array.isArray(value)
		? value.filter((e) => e && typeof e.path === "string").map((e) => ({ path: e.path as string, claims: Array.isArray(e.claims) ? (e.claims as string[]) : [] }))
		: [];

/** The census from the tool's stdout, or undefined for anything to stay silent on (exit 2, no census). */
export function parseCensus(stdout: string): CensusView | undefined {
	let out: { exit?: unknown; census?: Record<string, unknown> | null };
	try {
		out = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const c = out?.census;
	if (out?.exit === 2 || !c || c.mode !== "changed" || typeof c.foreignNote !== "string" || !Array.isArray(c.foreign)) return undefined;
	return {
		foreignNote: c.foreignNote,
		foreign: c.foreign as string[],
		claimed: pathClaims(c.claimed),
		unclaimed: Array.isArray(c.unclaimed) ? (c.unclaimed as string[]) : null,
		mappedOutside: pathClaims(c.mappedOutside),
		childUnderForeign: Array.isArray(c.childUnderForeign) ? (c.childUnderForeign as { id: string; parent: string }[]) : [],
	};
}

/** One session's census state, plain JSON. */
export interface CensusState {
	/** HEAD when the session was first seen: the census base, so committed work still counts. */
	base: string | null;
	top: string | null;
	/** Changed paths already seen (the baseline's included). */
	known: string[];
	/** Whether an in-boundary change was reported yet. */
	reported: boolean;
	/** Foreign § already listed. */
	foreign: string[];
	/** A failure was reported once. */
	failed: boolean;
}

export const freshCensusState = (): CensusState => ({ base: null, top: null, known: [], reported: false, foreign: [], failed: false });

/** One tool call, as the census needs it; no pi types. */
export interface CensusCall {
	cwd: string;
	toolName: string;
	input: unknown;
	signal?: AbortSignal;
	/** Shell commands this session ran so far (draft detection). */
	commands?: readonly string[];
	/** When the session started (ISO), for the newest-draft fallback. */
	sessionStart?: string;
}

export interface CensusResult {
	/** The digest to append to the tool result. */
	text?: string;
	/** A failure to report to the user once; the tool result stays as it was. */
	failure?: string;
}

/** A bash call that ran the census itself already shows it. */
export function ranCensus(toolName: string, input: unknown): boolean {
	const command = toolName.toLowerCase() === "bash" ? (input as { command?: unknown } | undefined)?.command : undefined;
	return typeof command === "string" && /sova-spec\.mjs/.test(command) && /\bcensus\b/.test(command);
}

const capped = (items: readonly string[], cap: number): string =>
	items.length > cap ? `${items.slice(0, cap).join(", ")} (+${items.length - cap} more)` : items.join(", ");

export const NO_DRAFT_NOTE =
	"No draft yet: a behaviour change needs its claim sentence in a draft before code (`sova-spec-draft.mjs new <name> --write`, then edit the claim); work that changes no behaviour: say you claim the exemption, decided from `scope` output.";

/**
 * The digest for the files new since the last look, or undefined when there is nothing to say: a first
 * in-boundary change, a new file in the boundary or mapped by a claim, or a new foreign §.
 */
export function digest(v: CensusView, fresh: readonly string[], state: Pick<CensusState, "reported" | "foreign">, hasDraft: boolean): string | undefined {
	const inBoundary = new Map<string, string>();
	for (const e of v.claimed) inBoundary.set(e.path, e.claims.join(", "));
	for (const p of v.unclaimed ?? []) inBoundary.set(p, "unclaimed");
	for (const e of v.mappedOutside) inBoundary.set(e.path, `outside the boundary, mapped by ${e.claims.join(", ")}`);
	const freshIn = fresh.filter((p) => inBoundary.has(p));
	const newForeign = v.foreign.filter((id) => !state.foreign.includes(id));
	const first = !state.reported && inBoundary.size > 0;
	if (!first && !freshIn.length && !newForeign.length) return undefined;
	const unclaimed = v.unclaimed?.length ?? 0;
	const lines = [
		`${DIGEST_TAG} ${v.claimed.length + unclaimed} changed file(s) in the boundary, ${unclaimed} unclaimed; ${v.foreign.length} foreign § touched` +
			(v.mappedOutside.length ? `; ${v.mappedOutside.length} mapped outside the boundary.` : "."),
	];
	if (!hasDraft && inBoundary.size) lines.push(NO_DRAFT_NOTE);
	if (freshIn.length) {
		const shown = freshIn.slice(0, FILE_CAP).map((p) => `${p} → ${inBoundary.get(p)}`);
		lines.push(`New: ${shown.join("; ")}${freshIn.length > FILE_CAP ? ` (+${freshIn.length - FILE_CAP} more)` : ""}`);
	}
	if (newForeign.length) lines.push(`Foreign §: ${capped(newForeign, ID_CAP)}`, `Rule: ${v.foreignNote}.`);
	if (v.childUnderForeign.length) lines.push(`New claims under a foreign §: ${capped(v.childUnderForeign.map((p) => `${p.id} → ${p.parent}`), ID_CAP)}`);
	return lines.join("\n");
}

/** A git-top-relative path as the spec root sees it, or undefined outside the root. */
function underRoot(top: string, root: string, path: string): string | undefined {
	const rel = relative(top, root);
	if (!rel) return path;
	return path.startsWith(`${rel}/`) ? path.slice(rel.length + 1) : undefined;
}

/**
 * One step of the census: look at the tree, and when paths are new since `state`, run the census and
 * return the digest. Returns the next state (a new object); never throws or rejects.
 */
export async function censusStep(state: CensusState, call: CensusCall, core: string, io: SpecIO = localIO): Promise<{ state: CensusState; result: CensusResult }> {
	const next: CensusState = { ...state, known: [...state.known], foreign: [...state.foreign] };
	try {
		const view = await gitView(call.cwd, io, call.signal);
		if (!view) return { state, result: {} };
		if (next.top !== view.top) {
			// First look at this tree: its current changes are the baseline, not the task's.
			Object.assign(next, freshCensusState(), { base: view.head, top: view.top, known: Object.keys(view.files) });
			return { state: next, result: {} };
		}
		const known = new Set(next.known);
		const fresh: string[] = [];
		const see = (p: string) => {
			if (p && !known.has(p)) {
				known.add(p);
				fresh.push(p);
			}
		};
		for (const p of Object.keys(view.files)) see(p);
		if (next.base && view.head && view.head !== next.base) {
			// Committed work leaves `git status`: what the commits since the base changed counts too.
			const diff = await io.exec("git", ["diff", "--name-only", "-z", next.base, view.head], { cwd: view.top, timeout: TOOL_TIMEOUT_MS, signal: call.signal });
			if (diff.code === 0) for (const p of diff.stdout.split("\0")) see(p);
		}
		if (!fresh.length) return { state: next, result: {} };
		next.known.push(...fresh);
		if (ranCensus(call.toolName, call.input)) return { state: next, result: {} };
		const root = await findSpecRoot(call.cwd, (p) => io.exists(p));
		const tool = join(core, "sova-spec.mjs");
		if (!root || !(await io.exists(tool))) return { state: next, result: {} };
		const census = async (spec?: string) => {
			const args = [tool, "census", "--changed", "--json", "--root", root, ...(next.base ? ["--base", next.base] : []), ...(spec ? ["--spec", spec] : [])];
			const r = await io.exec("node", args, { cwd: root, timeout: TOOL_TIMEOUT_MS, signal: call.signal });
			return { view: parseCensus(r.stdout), ran: r.stdout.trim() !== "" };
		};
		const spec = await pickDraft(root, call.commands ?? [], call.sessionStart, io);
		let r = await census(spec);
		if (!r.view && spec) r = await census(); // an unreadable draft: the current spec still names what is foreign
		if (!r.ran) {
			if (next.failed) return { state: next, result: {} };
			next.failed = true;
			return { state: next, result: { failure: "spec census hook: the census produced no output (timeout or crash); run it by hand" } };
		}
		if (!r.view) return { state: next, result: {} };
		const freshRel = fresh.map((p) => underRoot(view.top, root, p)).filter((p): p is string => p !== undefined);
		const text = digest(r.view, freshRel, next, Boolean(spec));
		if (!text) return { state: next, result: {} };
		next.reported = true;
		next.foreign = [...new Set([...next.foreign, ...r.view.foreign])];
		return { state: next, result: { text } };
	} catch (error) {
		if (next.failed) return { state: next, result: {} };
		next.failed = true;
		return { state: next, result: { failure: `spec census hook: ${error instanceof Error ? error.message : String(error)}` } };
	}
}

/** One session's census in one process: calls are serialized, so parallel tool results can't both report the same change. */
export class CensusHook {
	private state: CensusState = freshCensusState();
	private chain: Promise<unknown> = Promise.resolve();
	private readonly io: SpecIO;
	private readonly core: () => string;

	constructor(options: { io?: SpecIO; core: () => string }) {
		this.io = options.io ?? localIO;
		this.core = options.core;
	}

	/** A new session (or a switch to another): nothing seen yet. */
	reset(): void {
		this.state = freshCensusState();
	}

	/** Take the baseline now (a run's start), so the run's first edit is already a delta. */
	prime(cwd: string): Promise<CensusResult> {
		return this.after({ cwd, toolName: "", input: undefined });
	}

	after(call: CensusCall): Promise<CensusResult> {
		const next = this.chain
			.then(async () => {
				const { state, result } = await censusStep(this.state, call, this.core(), this.io);
				this.state = state;
				return result;
			})
			.catch((): CensusResult => ({}));
		this.chain = next;
		return next;
	}
}

// ── The `Also changes:` line ─────────────────────────────────────────────────

const SECTION_ID = /§[A-Za-z0-9][\w.\-/]*[\w-]/g;

/** The reply's last non-empty line, trimmed. */
export function lastLine(text: string): string {
	const lines = text.trimEnd().split("\n");
	return (lines[lines.length - 1] ?? "").trim();
}

/** `Also changes: none` → []; `Also changes: §a — x; §b — y` → the ids; anything else → undefined. */
export function parseAlsoChanges(line: string): string[] | undefined {
	const m = /^Also changes: (.+)$/.exec(line.replace(/^[*_`]+|[*_`]+$/g, ""));
	if (!m) return undefined;
	const body = m[1].trim();
	if (body === "none") return [];
	const ids = body.match(SECTION_ID);
	return ids && ids.length ? [...new Set(ids)] : undefined;
}

/**
 * The reply without its closing `Also changes:` line (and an override line right above it): for readers
 * that show or classify a reply (feeds, summaries, previews), where the line is bookkeeping, not content.
 */
export function stripAlsoChanges(text: string): string {
	const lines = text.trimEnd().split("\n");
	if (!lines.length || parseAlsoChanges(lines[lines.length - 1].trim()) === undefined) return text;
	lines.pop();
	if (lines.length && lines[lines.length - 1].trim().startsWith(ALSO_CHANGES_OVERRIDE)) lines.pop();
	return lines.join("\n").trimEnd();
}

export type AlsoChangesProblem = "missing" | "not-last" | "malformed" | "omits" | "none-but-changed";

export interface AlsoChangesCheck {
	ok: boolean;
	problem?: AlsoChangesProblem;
	/** Computed foreign § the line doesn't name. */
	missing: string[];
	/** The reply carries the override line. */
	overridden: boolean;
}

/**
 * Check a reply's last line. `required`: the turn edited, committed, promoted or merged; a turn that
 * didn't needs no line (and spec-mode.md says not to write one). `foreign`: computed from Git; every one
 * must be named. An override line above the last line (ALSO_CHANGES_OVERRIDE) passes a wrong list.
 */
export function checkAlsoChanges(reply: string, options: { required: boolean; foreign: readonly string[] }): AlsoChangesCheck {
	const overridden = reply.split("\n").some((l) => l.trim().startsWith(ALSO_CHANGES_OVERRIDE) && l.trim().length > ALSO_CHANGES_OVERRIDE.length + 1);
	const pass: AlsoChangesCheck = { ok: true, missing: [], overridden };
	if (!options.required) return pass;
	const line = lastLine(reply);
	const ids = parseAlsoChanges(line);
	if (ids === undefined) {
		const problem: AlsoChangesProblem = /^\W*Also changes\b/.test(line)
			? "malformed"
			: reply.split("\n").some((l) => parseAlsoChanges(l.trim()) !== undefined)
				? "not-last"
				: "missing";
		return { ok: false, problem, missing: [...options.foreign], overridden };
	}
	const missing = options.foreign.filter((id) => !ids.includes(id));
	if (!missing.length) return pass;
	return { ok: overridden, problem: ids.length ? "omits" : "none-but-changed", missing, overridden };
}

const PROBLEM_TEXT: Record<AlsoChangesProblem, string> = {
	missing: "your reply has no `Also changes:` line",
	"not-last": "your `Also changes:` line is not the very last line",
	malformed: 'your last line is not exactly "Also changes: §X — <what>; …" or "Also changes: none"',
	omits: "your `Also changes:` line omits",
	"none-but-changed": "your line says none, but it lands",
};

/** One sentence naming what's wrong, for the re-prompt and the warning. */
export function describeProblem(check: AlsoChangesCheck): string {
	if (!check.problem) return "";
	const base = PROBLEM_TEXT[check.problem];
	return check.problem === "omits" || check.problem === "none-but-changed" ? `${base} ${check.missing.join(", ")}` : base;
}

/** The hidden message that re-prompts a merge/promote turn once. */
export function repromptText(check: AlsoChangesCheck, foreign: readonly string[], what: string): string {
	const list = foreign.length ? foreign.join(", ") : "none";
	const shape = foreign.length ? `Also changes: ${foreign.map((id) => `${id} — <what changed>`).join("; ")}` : "Also changes: none";
	return [
		`${CHECK_TAG} This turn ${what}. The foreign § it lands, computed from Git: ${list}.`,
		`${describeProblem(check)}.`,
		`Reply again, briefly, ending with exactly this last line, nothing after it: "${shape}". A § the user asked you to change is still foreign; a worker's reported § count too.`,
		`If the computed list is wrong (for example a § this task created in an earlier merge), say why on a line "${ALSO_CHANGES_OVERRIDE} <why>" right above the last line.`,
	].join("\n");
}

// ── What a turn did ──────────────────────────────────────────────────────────

/** `sova-spec-draft.mjs … promote … --write`: a promotion that writes the current spec. */
export function promoteWrites(command: string): boolean {
	return /sova-spec-draft\.mjs["']?\s+promote\b/.test(command) && /--write\b/.test(command);
}

/** `git commit` / `git merge` in a shell command (not merge-base, merge-file, …). */
export function gitCommits(command: string): boolean {
	return /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+commit\b/.test(command);
}
export function gitMerges(command: string): boolean {
	return /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+merge(?![-\w])/.test(command);
}

/** The `--root <dir>` a spec tool command names, if any. */
export function commandRoot(command: string): string | undefined {
	const m = /--root[=\s]+("([^"]+)"|'([^']+)'|(\S+))/.exec(command);
	return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/**
 * The foreign § the current spec at `root` changed from `base` to `head` (the work tree without it):
 * `sova-spec.mjs foreign`; with `spec` (a draft's `spec/` dir, relative to the root) the draft is the head.
 * undefined when it can't say (no tool, a bad rev, no spec).
 */
export async function foreignBetween(
	root: string,
	base: string,
	head: string | undefined,
	core: string,
	io: SpecIO = localIO,
	signal?: AbortSignal,
	spec?: string,
): Promise<string[] | undefined> {
	const tool = join(core, "sova-spec.mjs");
	if (!(await io.exists(tool))) return undefined;
	const args = [tool, "foreign", "--base", base, ...(head ? ["--head", head] : spec ? ["--spec", spec] : []), "--root", root, "--json"];
	const r = await io.exec("node", args, { cwd: root, timeout: TOOL_TIMEOUT_MS, signal });
	try {
		const out = JSON.parse(r.stdout) as { exit?: unknown; foreign?: unknown };
		if (out.exit === 2 || !Array.isArray(out.foreign)) return undefined;
		return out.foreign.filter((id): id is string => typeof id === "string");
	} catch {
		return undefined;
	}
}

/** Newest mtime under a directory, 0 when empty or unreadable. */
async function newest(dir: string, io: SpecIO): Promise<number> {
	let names: string[];
	try {
		names = await io.readDir(dir);
	} catch {
		return (await io.mtime(dir)) ?? 0;
	}
	let max = 0;
	for (const name of names) max = Math.max(max, await newest(join(dir, name), io));
	return max;
}

/**
 * Each draft's newest `spec/` file mtime. Drafts are ignored by Git (.sova/spec/.gitignore), so a
 * git-status look never shows them: two stamps taken around a run tell which drafts it edited.
 */
export async function draftStamps(root: string, io: SpecIO = localIO): Promise<Record<string, number>> {
	const stamps: Record<string, number> = {};
	let names: string[];
	try {
		names = await io.readDir(join(root, SPEC_REL, "drafts"));
	} catch {
		return stamps;
	}
	for (const name of names) {
		const spec = join(root, SPEC_REL, "drafts", name, "spec");
		if (await io.exists(spec)) stamps[name] = await newest(spec, io);
	}
	return stamps;
}

/** Drafts new or edited between two stamps. */
export function draftsTouched(before: Record<string, number> | undefined, after: Record<string, number>): string[] {
	return Object.keys(after)
		.filter((name) => before?.[name] !== after[name])
		.sort();
}

/**
 * The foreign § a draft changes against the commit it was made from (draft.json `base.commit`, so what
 * current changed since isn't counted). undefined when the draft or its base can't be read.
 */
export async function draftForeign(root: string, name: string, core: string, io: SpecIO = localIO, signal?: AbortSignal): Promise<string[] | undefined> {
	try {
		const draft = JSON.parse(await io.readFile(join(root, SPEC_REL, "drafts", name, "draft.json"))) as { base?: { commit?: unknown } };
		const base = draft.base?.commit;
		if (typeof base !== "string" || !base) return undefined;
		return await foreignBetween(root, base, undefined, core, io, signal, `${SPEC_REL}/drafts/${name}/spec`);
	} catch {
		return undefined;
	}
}
