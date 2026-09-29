/**
 * The spec minor mode's mechanical checks, so the discipline in spec-mode.md holds without the model
 * remembering it:
 *
 * - **Census on a Git delta** (CensusHook): after any tool call, bash included, compare the work tree's
 *   `git status` with what the session saw before. On the first changed file in the spec boundary, and on
 *   each new file, run the read-only `sova-spec.mjs census --changed` and hand back a short digest tagged
 *   `[spec census]` for the caller to append to that tool result. A bash heredoc edit is caught like an
 *   edit call. Without a task draft the digest says so.
 * - **Forbidden writes** (SpecWriteGuard): the current spec written by hand, or commits a draft's evidence
 *   names rewritten (a rebase after evidence), are said in the same digest by the call that did it.
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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { ALSO_CHANGES_OVERRIDE, deferredIds, lastLine, looksLikeAlsoChanges, parseAlsoChanges, parseAlsoChangesLine, plumbingPaths } from "./also-changes.ts";

export { ALSO_CHANGES_OVERRIDE, DEFERRED_LINE, deferredIds, lastLine, looksLikeAlsoChanges, parseAlsoChanges, parseAlsoChangesLine, PLUMBING_LINE, plumbingPaths, stripAlsoChanges } from "./also-changes.ts";

const { dirname, join, relative } = posix;

export const DIGEST_TAG = "[spec census]";
export const CHECK_TAG = "[spec check]";
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
	/** Paths Git holds unmerged (a merge conflict in progress). */
	unmerged?: string[];
}

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Unmerged paths out of `git status --porcelain -z`. */
export function unmergedPaths(z: string): string[] {
	const parts = z.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		if (UNMERGED.has(entry.slice(0, 2))) paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[0] === "C") i++;
	}
	return paths;
}

/** The spec manifest Git holds in conflict in this view, as a top-relative path, if any. */
export function manifestConflict(view: GitView | undefined): string | undefined {
	return view?.unmerged?.find((p) => p === `${SPEC_REL}/manifest.json` || p.endsWith(`/${SPEC_REL}/manifest.json`));
}

/** What to do about a conflicted manifest: the sanctioned command, spelled out. */
export function manifestConflictNote(top: string, manifest: string, core: string): string {
	const root = join(top, dirname(dirname(dirname(manifest))) === "." ? "" : dirname(dirname(dirname(manifest))));
	return `${DIGEST_TAG} ${manifest} is in conflict: run \`node "${join(core, "sova-spec-draft.mjs")}" merge-manifest --root ${root} --write --json\` first, then stage it. If it refuses (manifest-conflict): take master's manifest and matching claims (git checkout master -- …), re-apply the branch's spec changes in a new draft, and promote. Never take a side before merge-manifest has run.`;
}

/** Whether a rebase is under way in the work tree at `top` (its rebase-merge or rebase-apply dir exists). */
export async function rebaseUnderway(top: string, io: SpecIO = localIO, signal?: AbortSignal): Promise<boolean> {
	for (const d of ["rebase-merge", "rebase-apply"]) {
		const r = await io.exec("git", ["rev-parse", "--git-path", d], { cwd: top, timeout: TOOL_TIMEOUT_MS, signal });
		const path = r.code === 0 ? r.stdout.trim() : "";
		if (path && (await io.exists(path.startsWith("/") ? path : join(top, path)))) return true;
	}
	return false;
}

/** A manifest conflict inside a rebase: merge-manifest is for merges; the rebase itself is the mistake. */
export const REBASE_CONFLICT_NOTE =
	"A rebase is under way: abort it (`git rebase --abort`) and merge master in instead (never rebase after evidence, PROMOTE.md); run merge-manifest on that merge's conflict.";

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
		const unmerged = unmergedPaths(status.stdout);
		return { top: root, head: head.code === 0 ? head.stdout.trim() : null, files, ...(unmerged.length ? { unmerged } : {}) };
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
 * shell commands), else the newest draft created at or after the session start, else, in a linked
 * worktree (a task's own tree, its drafts the task's whoever made them: a worker's census sees the
 * parent's draft, F7), the newest draft there; else none.
 */
export async function pickDraft(root: string, commands: readonly string[], sessionStart: string | undefined, io: SpecIO = localIO): Promise<string | undefined> {
	const specOf = (name: string) => `${SPEC_REL}/drafts/${name}/spec`;
	const has = async (name: string) => Boolean(await io.exists(join(root, specOf(name), "manifest.json")));
	for (const name of draftsCreated(commands).reverse()) if (await has(name)) return specOf(name);
	const opts = { cwd: root, timeout: TOOL_TIMEOUT_MS };
	const gitDir = (await io.exec("git", ["rev-parse", "--absolute-git-dir"], opts).catch(() => undefined))?.stdout.trim();
	const common = (await io.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts).catch(() => undefined))?.stdout.trim();
	const linked = Boolean(gitDir && common && gitDir !== common);
	const parsed = sessionStart ? Date.parse(sessionStart) : NaN;
	const since = linked ? 0 : parsed;
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
	/** Changed files outside the boundary (mapped or not); null without a boundary. */
	outside?: string[] | null;
	childUnderForeign: { id: string; parent: string }[];
	/** Draft evidence commits HEAD lacks (a rebase or reset rewrote them). */
	orphanedEvidence?: EvidenceCommit[];
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
		outside: Array.isArray(c.outside) ? (c.outside as string[]) : null,
		childUnderForeign: Array.isArray(c.childUnderForeign) ? (c.childUnderForeign as { id: string; parent: string }[]) : [],
		orphanedEvidence: Array.isArray(c.orphanedEvidence)
			? (c.orphanedEvidence as EvidenceCommit[]).filter((e) => e && typeof e.draft === "string" && typeof e.commit === "string").map((e) => ({ draft: e.draft, commit: e.commit, ids: Array.isArray(e.ids) ? e.ids : [] }))
			: [],
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
	/** The manifest conflict now in progress was already reported (absent in older state files). */
	conflict?: boolean;
	/** Orphaned evidence commits already said (by the census or the write guard). */
	orphans?: string[];
	/** Revs the task's own claims are absent at (ownBasesFor at the first look): census --own-base. */
	ownBases?: string[];
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
	/** Evidence commits the write guard already said were rewritten, on this call. */
	orphansSaid?: readonly string[];
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

/** The line for a changed file outside the boundary that no claim maps. */
export const unmappedNote = (file: string): string =>
	`${file} is outside the boundary and no claim maps it: if it changes user-visible behavior, spec it (a claim that lists it in \`code\`), else say it's plumbing.`;

export const NO_DRAFT_NOTE =
	"No draft yet: a behaviour change needs its claim sentence in a draft before code (`sova-spec-draft.mjs new <name> --write`, then edit the claim); work that changes no behaviour: say you claim the exemption, decided from `scope` output.";

/**
 * The digest for the files new since the last look, or undefined when there is nothing to say: a first
 * in-boundary change, a new file in the boundary or mapped by a claim, a new file outside the boundary
 * that no claim maps (it may still change behavior: said once per file), or a new foreign §.
 */
export function digest(v: CensusView, fresh: readonly string[], state: Pick<CensusState, "reported" | "foreign">, hasDraft: boolean): string | undefined {
	const inBoundary = new Map<string, string>();
	for (const e of v.claimed) inBoundary.set(e.path, e.claims.join(", "));
	for (const p of v.unclaimed ?? []) inBoundary.set(p, "unclaimed");
	for (const e of v.mappedOutside) inBoundary.set(e.path, `outside the boundary, mapped by ${e.claims.join(", ")}`);
	const freshIn = fresh.filter((p) => inBoundary.has(p));
	const newForeign = v.foreign.filter((id) => !state.foreign.includes(id));
	const first = !state.reported && inBoundary.size > 0;
	// Outside the boundary and no claim maps it: the spec's own files never count.
	const unmapped = fresh.filter((p) => v.outside?.includes(p) && !inBoundary.has(p) && !p.startsWith(".sova/"));
	if (!first && !freshIn.length && !newForeign.length && !unmapped.length) return undefined;
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
	for (const p of unmapped.slice(0, FILE_CAP)) lines.push(unmappedNote(p));
	if (unmapped.length > FILE_CAP) lines.push(`(+${unmapped.length - FILE_CAP} more such files)`);
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
 * return the digest. A manifest.json Git holds in conflict is reported once per conflict, first, with
 * the sanctioned command. Returns the next state (a new object); never throws or rejects.
 */
export async function censusStep(state: CensusState, call: CensusCall, core: string, io: SpecIO = localIO): Promise<{ state: CensusState; result: CensusResult }> {
	const seen: { view?: GitView } = {};
	const step = await censusDelta(state, call, core, io, seen);
	const manifest = manifestConflict(seen.view);
	if (!manifest || !seen.view) return step.state.conflict ? { state: { ...step.state, conflict: false }, result: step.result } : step;
	if (step.state.conflict) return step;
	const rebasing = await rebaseUnderway(seen.view.top, io, call.signal).catch(() => false);
	const note = rebasing ? `${DIGEST_TAG} ${manifest} is in conflict. ${REBASE_CONFLICT_NOTE}` : manifestConflictNote(seen.view.top, manifest, core);
	return { state: { ...step.state, conflict: true }, result: { ...step.result, text: step.result.text ? `${note}\n${step.result.text}` : note } };
}

async function censusDelta(state: CensusState, call: CensusCall, core: string, io: SpecIO, seen: { view?: GitView }): Promise<{ state: CensusState; result: CensusResult }> {
	const next: CensusState = { ...state, known: [...state.known], foreign: [...state.foreign], orphans: [...new Set([...(state.orphans ?? []), ...(call.orphansSaid ?? [])])] };
	try {
		const view = await gitView(call.cwd, io, call.signal);
		if (!view) return { state, result: {} };
		seen.view = view;
		if (next.top !== view.top) {
			// First look at this tree: its current changes are the baseline, not the task's.
			const main = await defaultBranch(view.top, io);
			const tip = main ? (await io.exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${main}`], { cwd: view.top, timeout: TOOL_TIMEOUT_MS })).stdout.trim() : "";
			const ownBases = await ownBasesFor(view.top, view.head, tip || undefined, io);
			Object.assign(next, freshCensusState(), { base: view.head, top: view.top, known: Object.keys(view.files), ...(ownBases.length ? { ownBases } : {}) });
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
			const own = (next.ownBases ?? []).flatMap((rev) => ["--own-base", rev]);
			const args = [tool, "census", "--changed", "--json", "--root", root, ...(next.base ? ["--base", next.base] : []), ...own, ...(spec ? ["--spec", spec] : [])];
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
		const orphans = (r.view.orphanedEvidence ?? []).filter((e) => !next.orphans?.includes(e.commit));
		const said = digest(r.view, freshRel, next, Boolean(spec));
		if (said) {
			next.reported = true;
			next.foreign = [...new Set([...next.foreign, ...r.view.foreign])];
		}
		if (orphans.length) next.orphans = [...(next.orphans ?? []), ...orphans.map((e) => e.commit)];
		const text = [orphans.length ? orphanNote(orphans) : undefined, said].filter(Boolean).join("\n");
		return { state: next, result: text ? { text } : {} };
	} catch (error) {
		if (next.failed) return { state: next, result: {} };
		next.failed = true;
		return { state: next, result: { failure: `spec census hook: ${error instanceof Error ? error.message : String(error)}` } };
	}
}

/** The directories a tool call writes in: a shell command's (commandDirs), an edit's file's, and the cwd. */
export function callDirs(call: Pick<CensusCall, "cwd" | "toolName" | "input">): string[] {
	const tool = call.toolName.toLowerCase();
	const input = call.input as { command?: unknown; path?: unknown; file_path?: unknown } | undefined;
	const dirs = [call.cwd];
	if (tool === "bash" && typeof input?.command === "string") dirs.push(...commandDirs(input.command, call.cwd));
	const file = typeof input?.path === "string" ? input.path : typeof input?.file_path === "string" ? input.file_path : undefined;
	if (file && tool !== "bash" && tool !== "read") dirs.push(dirname(file.startsWith("/") ? file : join(call.cwd, file)));
	return [...new Set(dirs)];
}

/**
 * One session's census in one process, per work tree: each tree a call writes in (callDirs) has its own
 * state, its baseline taken before the call first touches it (`before`), so a parent editing a worktree
 * by bash (`cd <wt> && …`) gets that tree's digest (F6). Calls are serialized, so parallel tool results
 * can't both report the same change.
 */
export class CensusHook {
	private states = new Map<string, CensusState>();
	private chain: Promise<unknown> = Promise.resolve();
	private readonly io: SpecIO;
	private readonly core: () => string;

	constructor(options: { io?: SpecIO; core: () => string }) {
		this.io = options.io ?? localIO;
		this.core = options.core;
	}

	/** A new session (or a switch to another): nothing seen yet. */
	reset(): void {
		this.states = new Map();
	}

	private async topOf(dir: string, signal?: AbortSignal): Promise<string | undefined> {
		const r = await this.io.exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: TOOL_TIMEOUT_MS, signal }).catch(() => undefined);
		return r && r.code === 0 ? r.stdout.trim() : undefined;
	}

	private serial<T>(work: () => Promise<T>, fallback: T): Promise<T> {
		const next = this.chain.then(work).catch(() => fallback);
		this.chain = next;
		return next;
	}

	/** Take a tree's baseline if it has none yet. */
	private async baseline(dir: string, signal?: AbortSignal): Promise<void> {
		const top = await this.topOf(dir, signal);
		if (!top || this.states.has(top)) return;
		const { state } = await censusStep(freshCensusState(), { cwd: dir, toolName: "", input: undefined, signal }, this.core(), this.io);
		this.states.set(top, state);
	}

	/** Take the baseline now (a run's start), so the run's first edit is already a delta. */
	prime(cwd: string): Promise<CensusResult> {
		return this.serial(async () => {
			await this.baseline(cwd);
			return {};
		}, {});
	}

	/** Before a call: the baseline of each tree it will write in and the session hasn't seen yet. */
	before(call: CensusCall): Promise<void> {
		return this.serial(async () => {
			for (const dir of callDirs(call)) await this.baseline(dir, call.signal);
		}, undefined);
	}

	after(call: CensusCall): Promise<CensusResult> {
		return this.serial(async () => {
			const texts: string[] = [];
			let failure: string | undefined;
			const done = new Set<string>();
			for (const dir of callDirs(call)) {
				const top = await this.topOf(dir, call.signal);
				if (!top || done.has(top)) continue;
				done.add(top);
				const { state, result } = await censusStep(this.states.get(top) ?? freshCensusState(), { ...call, cwd: dir }, this.core(), this.io);
				this.states.set(top, state);
				if (result.text) texts.push(result.text);
				failure ??= result.failure;
			}
			return { ...(texts.length ? { text: texts.join("\n") } : {}), ...(failure ? { failure } : {}) };
		}, {} as CensusResult);
	}
}

// ── The `Also changes:` line ─────────────────────────────────────────────────

// The grammar and its parser: also-changes.ts (shared with the Claude Code hook and the harness scorer).

export type AlsoChangesProblem = "missing" | "not-last" | "malformed" | "forbidden" | "omits" | "none-but-changed" | "extra";

export interface AlsoChangesCheck {
	ok: boolean;
	/** What is wrong with the line itself, if anything. */
	problem?: AlsoChangesProblem;
	/** The grammar error, for `malformed`. */
	format?: string;
	/** Computed foreign § the line doesn't name. */
	missing: string[];
	/** § the line names that the computed list doesn't (checked only when the list is `exact`). */
	extra: string[];
	/** Changed files no claim maps that no `Plumbing:` line names (the landing gate). */
	unmapped: string[];
	/** Unpromoted draft records' § that no `Deferred:` line names (the landing gate). */
	undeferred: string[];
	/** The reply carries the override line. */
	overridden: boolean;
}

export interface AlsoChangesOptions {
	/** The turn edited, committed, promoted or merged: the line is required. */
	required: boolean;
	/** Computed from Git; every one must be named. */
	foreign: readonly string[];
	/** That list is complete: a § the line names beyond it (and beyond `advisory`) is an extra. */
	exact?: boolean;
	/** § the line may name without being extras (mapped code changed, text untouched: advisory). */
	advisory?: readonly string[];
	/** A turn that must not carry the line (a Q&A turn): a line there is a problem. */
	forbidden?: boolean;
	/** Landing gate: changed files no claim maps; each needs a mapping claim or a `Plumbing:` line. */
	unmapped?: readonly string[];
	/** Landing gate: unpromoted draft records' §; each needs a `Deferred:` line (or a promotion). */
	unpromoted?: readonly string[];
}

/**
 * Check a reply. `required`: the turn edited, committed, promoted or merged; `forbidden`: a Q&A turn,
 * where the line must not appear (spec-mode.md). The line is parsed by also-changes.ts (a format error is
 * its own problem, never a wrong list). Every computed foreign § must be named; with `exact`, a § beyond
 * the list and `advisory` is an extra. On a landing, each unmapped changed file needs a `Plumbing:` line
 * and each unpromoted record's § a `Deferred:` line.
 * The override line (ALSO_CHANGES_OVERRIDE) excuses only an OMISSION: a computed § the agent shows it must
 * not name (one this task created, in an earlier commit, promotion or merge). It never excuses an extra.
 */
export function checkAlsoChanges(reply: string, options: AlsoChangesOptions): AlsoChangesCheck {
	const overridden = reply.split("\n").some((l) => l.trim().startsWith(ALSO_CHANGES_OVERRIDE) && l.trim().length > ALSO_CHANGES_OVERRIDE.length + 1);
	const plumbing = plumbingPaths(reply);
	const deferred = deferredIds(reply);
	const unmapped = (options.unmapped ?? []).filter((p) => !plumbing.includes(p));
	const undeferred = (options.unpromoted ?? []).filter((id) => !deferred.includes(id));
	const base: AlsoChangesCheck = { ok: true, missing: [], extra: [], unmapped, undeferred, overridden };
	const gate = (check: AlsoChangesCheck): AlsoChangesCheck => ({ ...check, ok: check.ok && !unmapped.length && !undeferred.length });
	const line = lastLine(reply);
	if (!options.required) {
		const written = reply.split("\n").some((l) => looksLikeAlsoChanges(l));
		return options.forbidden && written ? { ...base, ok: false, problem: "forbidden" } : base;
	}
	const parsed = parseAlsoChangesLine(line);
	if (!parsed?.ok) {
		const problem: AlsoChangesProblem = parsed ? "malformed" : reply.split("\n").some((l) => looksLikeAlsoChanges(l)) ? "not-last" : "missing";
		return { ...base, ok: false, problem, ...(parsed && !parsed.ok ? { format: parsed.error } : {}), missing: [...options.foreign] };
	}
	const ids = parsed.ids;
	const missing = options.foreign.filter((id) => !ids.includes(id));
	const extra = options.exact ? ids.filter((id) => !options.foreign.includes(id) && !(options.advisory ?? []).includes(id)) : [];
	if (!missing.length && !extra.length) return gate(base);
	const problem: AlsoChangesProblem = missing.length ? (ids.length ? "omits" : "none-but-changed") : "extra";
	return gate({ ...base, ok: overridden && !extra.length, problem, missing, extra });
}

const PROBLEM_TEXT: Record<AlsoChangesProblem, string> = {
	missing: "your reply has no `Also changes:` line",
	"not-last": "your `Also changes:` line is not the very last line",
	malformed: "your `Also changes:` line breaks the format",
	forbidden: "this turn changed nothing, so it takes no `Also changes:` line: drop it",
	omits: "your `Also changes:` line omits",
	"none-but-changed": "your line says none, but it lands",
	extra: "",
};

/** The sentence for § a line names beyond the computed list; the override never excuses it. */
export const extraText = (ids: readonly string[]): string =>
	`${ids.join(", ")} ${ids.length === 1 ? "isn't" : "aren't"} changed by this diff: if its user-visible behavior changed, update its claim in a draft and promote; otherwise drop it from the line`;

/** The landing gate's sentences: unmapped files and unpromoted records. */
export const unmappedText = (paths: readonly string[]): string =>
	`${capped(paths, FILE_CAP)} changed and no claim maps ${paths.length === 1 ? "it" : "them"}: spec each that changes user-visible behavior (a claim listing it in \`code\`, promoted), or name it on a line "Plumbing: <path> — <why>" above the last line; UI text, colour, CLI output and footer rendering are never plumbing`;
export const undeferredText = (ids: readonly string[]): string =>
	`draft records left unpromoted: ${capped(ids, ID_CAP)}: promote what shipped, or say which § stay stale on a line "Deferred: §X — <why>" above the last line`;

/** What's wrong, for the re-prompt and the warning: the line's problem, the extras, then the landing gate. */
export function describeProblem(check: AlsoChangesCheck): string {
	const parts: string[] = [];
	if (check.problem === "omits" || check.problem === "none-but-changed") parts.push(`${PROBLEM_TEXT[check.problem]} ${check.missing.join(", ")}`);
	else if (check.problem === "malformed") parts.push(`${PROBLEM_TEXT.malformed}: ${check.format ?? "see the format"} (${ALSO_CHANGES_FORMAT})`);
	else if (check.problem && check.problem !== "extra") parts.push(PROBLEM_TEXT[check.problem]);
	if (check.extra.length) parts.push(extraText(check.extra));
	if (check.unmapped.length) parts.push(unmappedText(check.unmapped));
	if (check.undeferred.length) parts.push(undeferredText(check.undeferred));
	return parts.join("; ");
}

/** The format, in one phrase, for a malformed line. */
export const ALSO_CHANGES_FORMAT = 'items separated by ";", each starting with the § it names ("Also changes: §a.b/c, /d — <what>; §e/f — <what>"), or "Also changes: none"';

/** The hidden message that re-prompts a landing turn. */
export function repromptText(check: AlsoChangesCheck, foreign: readonly string[], what: string): string {
	if (check.problem === "forbidden") return `${CHECK_TAG} ${describeProblem(check)}. Reply again, briefly, without that line.`;
	const list = foreign.length ? foreign.join(", ") : "none";
	const shape = foreign.length ? `Also changes: ${foreign.map((id) => `${id} — <what changed>`).join("; ")}` : "Also changes: none";
	return [
		`${CHECK_TAG} This turn ${what}. The foreign § it lands, computed from Git: ${list}.`,
		`${describeProblem(check)}.`,
		`Reply again, briefly, ending with exactly this last line, nothing after it: "${shape}". A § the user asked you to change is still foreign; § this task created are not.`,
		`If a computed § must not be named (one this task created, in an earlier commit, promotion or merge), say why on a line "${ALSO_CHANGES_OVERRIDE} <why>" right above the last line; it never excuses naming a § the list lacks.`,
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

/** The directories a shell command works in: each `cd <dir>`, `git -C <dir>` and `--root <dir>`; else the cwd. */
export function commandDirs(command: string, cwd: string): string[] {
	const dirs: string[] = [];
	const word = String.raw`("([^"]+)"|'([^']+)'|([^\s;&|]+))`;
	for (const re of [new RegExp(String.raw`(?:^|[;&|(]\s*)cd\s+` + word, "g"), new RegExp(String.raw`\bgit\s+-C\s+` + word, "g"), new RegExp(String.raw`--root[=\s]+` + word, "g")])
		for (const m of command.matchAll(re)) {
			const dir = m[2] ?? m[3] ?? m[4];
			if (dir) dirs.push(dir.startsWith("/") ? dir : join(cwd, dir));
		}
	return dirs.length ? dirs : [cwd];
}

/** The `--root <dir>` a spec tool command names, if any. */
export function commandRoot(command: string): string | undefined {
	const m = /--root[=\s]+("([^"]+)"|'([^']+)'|(\S+))/.exec(command);
	return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

/** What core's `foreign` says about a range (`--landing` adds the gate lists; `--own-base` the task's own). */
export interface RangeLists {
	foreign: string[];
	/** The task's own ids the range touched or created (already out of `foreign`). */
	own: string[];
	unmappedChanged: { path: string; status?: string; inBoundary?: boolean }[];
	mappedUntouched: { id: string; files?: string[] }[];
	unpromotedDrafts: { draft: string; worktree?: string; ids: string[] }[];
	handResolved: { commit: string; ids: string[] }[];
}

export interface RangeOptions {
	/** Revs the task's own claims are absent at (fork point, default tip at run start): subtracted. */
	ownBases?: readonly string[];
	/** Ask for the landing gate's lists too. */
	landing?: boolean;
	/** A draft's `spec/` dir (relative to the root) as the head. */
	spec?: string;
	signal?: AbortSignal;
}

const arr = <T>(v: unknown, ok: (x: unknown) => boolean): T[] => (Array.isArray(v) ? (v.filter(ok) as T[]) : []);

/**
 * The foreign § (and, with `landing`, the gate lists) the current spec at `root` changed from `base` to
 * `head` (the work tree without it; with `spec`, a draft is the head): `sova-spec.mjs foreign`, the task's
 * own ids subtracted when `ownBases` are given. undefined when it can't say (no tool, a bad rev, no spec).
 */
export async function rangeLists(root: string, base: string, head: string | undefined, core: string, io: SpecIO = localIO, options: RangeOptions = {}): Promise<RangeLists | undefined> {
	const tool = join(core, "sova-spec.mjs");
	if (!(await io.exists(tool))) return undefined;
	const args = [
		tool,
		"foreign",
		"--base",
		base,
		...(head ? ["--head", head] : options.spec ? ["--spec", options.spec] : []),
		...[...new Set(options.ownBases ?? [])].flatMap((rev) => ["--own-base", rev]),
		...(options.landing ? ["--landing"] : []),
		"--root",
		root,
		"--json",
	];
	const r = await io.exec("node", args, { cwd: root, timeout: TOOL_TIMEOUT_MS, signal: options.signal });
	try {
		const out = JSON.parse(r.stdout) as Record<string, unknown>;
		if (out.exit === 2 || !Array.isArray(out.foreign)) return undefined;
		const own = arr<string>(out.own, (x) => typeof x === "string");
		return {
			foreign: arr<string>(out.foreign, (x) => typeof x === "string").filter((id) => !own.includes(id)),
			own,
			unmappedChanged: arr(out.unmappedChanged, (x) => typeof (x as { path?: unknown })?.path === "string"),
			mappedUntouched: arr(out.mappedUntouched, (x) => typeof (x as { id?: unknown })?.id === "string"),
			unpromotedDrafts: arr<{ draft: string; ids: string[] }>(out.unpromotedDrafts, (x) => Array.isArray((x as { ids?: unknown })?.ids)),
			handResolved: arr(out.handResolved, (x) => Array.isArray((x as { ids?: unknown })?.ids)),
		};
	} catch {
		return undefined;
	}
}

/** Just the foreign § of a range (see rangeLists). */
export async function foreignBetween(
	root: string,
	base: string,
	head: string | undefined,
	core: string,
	io: SpecIO = localIO,
	signal?: AbortSignal,
	spec?: string,
	ownBases?: readonly string[],
): Promise<string[] | undefined> {
	return (await rangeLists(root, base, head, core, io, { signal, spec, ownBases }))?.foreign;
}

/**
 * The revs the task's own claims are absent at: the default branch's tip when the run (or session)
 * started, and the fork point of `head` from it. A claim absent at both is the task's (created on its
 * branch, whenever); one master added (present at the tip) stays foreign.
 */
export async function ownBasesFor(top: string, head: string | null | undefined, defaultTip: string | undefined, io: SpecIO = localIO): Promise<string[]> {
	if (!defaultTip) return [];
	const bases = [defaultTip];
	if (head) {
		const fork = await io.exec("git", ["merge-base", head, defaultTip], { cwd: top, timeout: TOOL_TIMEOUT_MS });
		if (fork.code === 0 && fork.stdout.trim()) bases.push(fork.stdout.trim());
	}
	return [...new Set(bases)];
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
 * current changed since isn't counted); a draft made by an older tool has none, and `fallbackBase` (the
 * run's starting HEAD) stands in. undefined when nothing can be computed: the caller then checks the
 * line's form only, never "none" against an empty list.
 */
export async function draftForeign(
	root: string,
	name: string,
	core: string,
	io: SpecIO = localIO,
	signal?: AbortSignal,
	fallbackBase?: string,
	ownBases?: readonly string[],
): Promise<string[] | undefined> {
	try {
		const draft = JSON.parse(await io.readFile(join(root, SPEC_REL, "drafts", name, "draft.json"))) as { base?: { commit?: unknown } };
		const base = typeof draft.base?.commit === "string" && draft.base.commit ? draft.base.commit : fallbackBase;
		if (!base) return undefined;
		return await foreignBetween(root, base, undefined, core, io, signal, `${SPEC_REL}/drafts/${name}/spec`, ownBases);
	} catch {
		return undefined;
	}
}

// ── A turn across trees ──────────────────────────────────────────────────────

/** One work tree as a run found it: the session's own, or a worktree it tracks (a worker may write there). */
export interface TreeStart {
	view: GitView;
	/** The spec root inside it, if any. */
	root?: string;
	/** Each draft's newest spec/ mtime (drafts are ignored by Git). */
	drafts: Record<string, number>;
	/** The default branch's tip when the run found the tree: an own-claim base (ownBasesFor). */
	defaultTip?: string;
}

/** What a run did to one tree. */
export interface TreeTurn {
	/** Anything changed: HEAD, a changed path or its mtime, a draft. */
	changed: boolean;
	/** The current spec (not a draft) changed: a promotion landed there, committed or not. */
	specChanged: boolean;
	/** The foreign § it changed (current spec since the run's HEAD, and each edited draft); undefined when not computable. */
	foreign?: string[];
	/** Its manifest.json is in a Git conflict now: what to do (manifestConflictNote). */
	conflict?: string;
	/** The comparison itself failed: the check must say so, never stay silent. */
	error?: string;
}

export async function treeStart(dir: string, io: SpecIO = localIO): Promise<TreeStart | undefined> {
	const view = await gitView(dir, io);
	if (!view) return undefined;
	const root = await findSpecRoot(view.top, (p) => io.exists(p));
	const main = root ? await defaultBranch(view.top, io) : undefined;
	const tip = main ? (await io.exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${main}`], { cwd: view.top, timeout: TOOL_TIMEOUT_MS })).stdout.trim() : "";
	return { view, ...(root ? { root } : {}), drafts: root ? await draftStamps(root, io) : {}, ...(tip ? { defaultTip: tip } : {}) };
}

/** The repo's default branch: origin/HEAD's target, else `master`, else `main`; undefined when none exists. */
export async function defaultBranch(top: string, io: SpecIO = localIO): Promise<string | undefined> {
	const git = (args: string[]) => io.exec("git", args, { cwd: top, timeout: TOOL_TIMEOUT_MS });
	const origin = (await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
	if (origin) return origin.replace(/^origin\//, "");
	for (const name of ["master", "main"]) if ((await git(["rev-parse", "--verify", "-q", `refs/heads/${name}`])).code === 0) return name;
	return undefined;
}

/**
 * What a tree's current spec landed from `base` to its work tree (`head` its HEAD now). A merge lands
 * the TARGET's own diff: on the default branch the whole diff is what landed. On any other branch a
 * merge that brought the default branch in (its second parent is an ancestor of the default branch's
 * tip) is absorbed, not landed: it is no spec change of this tree's, and its § drop out of the list
 * unless a commit of the branch's own, or an uncommitted change, changes them too.
 */
export async function landedSpec(
	top: string,
	root: string,
	base: string,
	head: string | null,
	dirtySpec: boolean,
	isSpec: (path: string) => boolean,
	core: string,
	io: SpecIO = localIO,
	options: { committed?: boolean; ownBases?: readonly string[] } = {},
): Promise<{ specChanged: boolean; foreign?: string[] }> {
	const git = (args: string[]) => io.exec("git", args, { cwd: top, timeout: TOOL_TIMEOUT_MS });
	const touches = async (from: string, to: string) => {
		const diff = await git(["diff", "--name-only", "-z", from, to]);
		return diff.code === 0 && diff.stdout.split("\0").some(isSpec);
	};
	// committed: the range base..head itself (one operation's), never the work tree.
	const all = async () => foreignBetween(root, base, options.committed && head ? head : undefined, core, io, undefined, undefined, options.ownBases);
	if (!head || head === base) return dirtySpec ? { specChanged: true, foreign: await all() } : { specChanged: false, foreign: [] };
	const main = await defaultBranch(top, io);
	const branch = (await git(["symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim();
	if (!main || branch === main) {
		const specChanged = dirtySpec || (await touches(base, head));
		return specChanged ? { specChanged, foreign: await all() } : { specChanged, foreign: [] };
	}
	const tip = (await git(["rev-parse", "--verify", "-q", `refs/heads/${main}`])).stdout.trim();
	const commits = (await git(["rev-list", "--first-parent", "--parents", `${base}..${head}`])).stdout.trim().split("\n").filter(Boolean);
	const absorbed = new Set<string>();
	const own = new Set<string>();
	let ownTouched = dirtySpec;
	for (const line of commits) {
		const [commit, parent, merged] = line.split(" ");
		if (!commit || !parent || !(await touches(parent, commit))) continue;
		const absorbing = Boolean(merged && tip && (await git(["merge-base", "--is-ancestor", merged, tip])).code === 0);
		if (!absorbing) ownTouched = true;
		for (const id of (await foreignBetween(root, parent, commit, core, io, undefined, undefined, options.ownBases)) ?? []) (absorbing ? absorbed : own).add(id);
	}
	if (!ownTouched) return { specChanged: false, foreign: [] };
	const every = await all();
	if (!every || !absorbed.size) return { specChanged: true, ...(every ? { foreign: every } : {}) };
	const uncommitted = dirtySpec ? ((await foreignBetween(root, head, undefined, core, io, undefined, undefined, options.ownBases)) ?? []) : [];
	return { specChanged: true, foreign: every.filter((id) => !absorbed.has(id) || own.has(id) || uncommitted.includes(id)) };
}

/**
 * Compare a tree with how the run found it. Never throws. `commits: false` ignores HEAD's movement (only
 * the work tree's own changes count): for the session's tree when this session made no commit, merge or
 * promotion there, so a commit someone else lands meanwhile (another task on master) is never this turn's.
 */
export async function treeTurn(start: TreeStart, core: string, io: SpecIO = localIO, options: { commits?: boolean } = {}): Promise<TreeTurn> {
	try {
		const end = await gitView(start.view.top, io);
		if (options.commits === false && end) start = { ...start, view: { ...start.view, head: end.head } };
		const manifest = manifestConflict(end);
		const conflict = manifest && end ? { conflict: manifestConflictNote(end.top, manifest, core) } : {};
		const drafts = start.root ? draftsTouched(start.drafts, await draftStamps(start.root, io)) : [];
		const changed = viewChanged(start.view, end) || drafts.length > 0;
		if (!changed || !end) return { changed, specChanged: false, foreign: [], ...conflict };
		const specRel = start.root ? relative(start.view.top, join(start.root, SPEC_REL)) : SPEC_REL;
		const isSpec = (p: string) => p.startsWith(`${specRel}/`) && !p.startsWith(`${specRel}/drafts/`);
		const dirtySpec = Object.entries(end.files).some(([p, m]) => isSpec(p) && start.view.files[p] !== m);
		const base = start.view.head;
		if (!start.root || !base) return { changed, specChanged: dirtySpec, ...conflict };
		const ownBases = await ownBasesFor(end.top, end.head, start.defaultTip, io);
		const landed = await landedSpec(end.top, start.root, base, end.head, dirtySpec, isSpec, core, io, { ownBases });
		const specChanged = landed.specChanged;
		const ids = new Set<string>();
		let known = false;
		if (landed.foreign) {
			known = true;
			for (const id of landed.foreign) ids.add(id);
		}
		for (const name of drafts) {
			const edited = await draftForeign(start.root, name, core, io, undefined, base, ownBases);
			if (edited) {
				known = true;
				for (const id of edited) ids.add(id);
			}
		}
		return { changed, specChanged, ...(known ? { foreign: [...ids].sort() } : {}), ...conflict };
	} catch (error) {
		return { changed: false, specChanged: false, error: `${start.view.top}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Whether `commit` is an ancestor of (or equal to) `of`, in the repo at `dir`; false on any error. */
export async function isAncestor(dir: string, commit: string, of: string, io: SpecIO = localIO): Promise<boolean> {
	const r = await io.exec("git", ["merge-base", "--is-ancestor", commit, of], { cwd: dir, timeout: TOOL_TIMEOUT_MS }).catch(() => undefined);
	return r?.code === 0;
}

/** A directory's work-tree top and HEAD (two cheap rev-parses, no status), or undefined outside Git. */
export async function headAt(dir: string, io: SpecIO = localIO): Promise<{ top: string; head: string } | undefined> {
	try {
		const top = await io.exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: TOOL_TIMEOUT_MS });
		const head = await io.exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir, timeout: TOOL_TIMEOUT_MS });
		return top.code === 0 && head.code === 0 ? { top: top.stdout.trim(), head: head.stdout.trim() } : undefined;
	} catch {
		return undefined;
	}
}

/** One git operation of this session's in a tree: HEAD just before it and just after. */
export interface OpRange {
	before: string;
	after: string;
}

/**
 * The session's own tree, attributed per operation: its uncommitted changes as treeTurn sees them
 * (HEAD's movement ignored), plus, for each git operation this session ran there (a commit, merge or
 * promotion), what landed between the HEAD just before it and just after it. A commit another actor
 * lands on the same branch meanwhile falls outside every range, so it is never this turn's.
 */
export async function opsTurn(start: TreeStart, ranges: readonly OpRange[], core: string, io: SpecIO = localIO): Promise<TreeTurn> {
	const base = await treeTurn(start, core, io, { commits: false });
	const moved = ranges.filter((r) => r.before && r.after && r.before !== r.after);
	if (!moved.length || base.error || !start.root) return moved.length ? { ...base, changed: true } : base;
	try {
		const specRel = relative(start.view.top, join(start.root, SPEC_REL));
		const isSpec = (p: string) => p.startsWith(`${specRel}/`) && !p.startsWith(`${specRel}/drafts/`);
		let specChanged = base.specChanged;
		const ids = new Set(base.foreign ?? []);
		let known = base.foreign !== undefined;
		for (const r of moved) {
			const landed = await landedSpec(start.view.top, start.root, r.before, r.after, false, isSpec, core, io, { committed: true });
			if (landed.specChanged) specChanged = true;
			if (landed.foreign) {
				known = true;
				for (const id of landed.foreign) ids.add(id);
			}
		}
		return { ...base, changed: true, specChanged, ...(known ? { foreign: [...ids].sort() } : {}) };
	} catch (error) {
		return { ...base, changed: true, error: `${start.view.top}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** One git operation that may land spec or code: the session's own (ops) or a worker's (the ledger). */
export interface OpLanding {
	top: string;
	before: string;
	/** HEAD after; equal to `before` for an uncommitted promote (the work tree is the head). */
	after: string;
	kind: "commit" | "merge" | "ff" | "promote" | "rebase" | "reset";
	/** Who ran it: "self" for this session, else the worker's actor. */
	actor?: string;
}

/** What one operation landed. */
export interface OpJudgement {
	/** A landing: a merge that isn't the default branch absorbed, a promote, or a commit that changed the current spec. */
	landing: boolean;
	specChanged: boolean;
	/** Foreign § it landed (own subtracted); undefined when not computable. */
	foreign?: string[];
	/** The landing gate's lists, for a landing. */
	lists?: RangeLists;
}

/**
 * Judge one operation's range in its tree. A merge (or fast-forward) lands unless it only brought the
 * default branch into another branch (absorbed: every merged-in side is on the default tip). A promote
 * always lands. A commit lands when it changed the current spec (a committed promotion). The lists come
 * from the range itself (before..after, or the work tree for an uncommitted promote), own claims out.
 */
export async function judgeOp(op: OpLanding, core: string, io: SpecIO = localIO, defaultTip?: string): Promise<OpJudgement> {
	const root = await findSpecRoot(op.top, (p) => io.exists(p));
	const git = (args: string[]) => io.exec("git", args, { cwd: op.top, timeout: TOOL_TIMEOUT_MS });
	const main = await defaultBranch(op.top, io);
	const tip = defaultTip ?? (main ? (await git(["rev-parse", "--verify", "-q", `refs/heads/${main}`])).stdout.trim() : "");
	const branch = (await git(["symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim();
	const moved = op.after !== op.before;
	let absorbing = false;
	if ((op.kind === "merge" || op.kind === "ff") && moved && tip && branch && branch !== main) {
		const merges = (await git(["rev-list", "--first-parent", "--parents", `${op.before}..${op.after}`])).stdout.trim().split("\n").filter(Boolean);
		const sides = merges.map((l) => l.split(" ")[2]).filter(Boolean);
		if (!sides.length) absorbing = (await git(["merge-base", "--is-ancestor", op.after, tip])).code === 0;
		else {
			absorbing = true;
			for (const side of sides) if ((await git(["merge-base", "--is-ancestor", side, tip])).code !== 0) absorbing = false;
		}
	}
	if (!root) return { landing: (op.kind === "merge" || op.kind === "ff" || op.kind === "promote") && !absorbing, specChanged: false };
	const ownBases = await ownBasesFor(op.top, op.after, tip || undefined, io);
	const specRel = relative(op.top, join(root, SPEC_REL));
	const isSpec = (p: string) => p.startsWith(`${specRel}/`) && !p.startsWith(`${specRel}/drafts/`);
	let specChanged = false;
	let foreign: string[] | undefined = [];
	if (moved) {
		const landed = await landedSpec(op.top, root, op.before, op.after, false, isSpec, core, io, { committed: true, ownBases });
		specChanged = landed.specChanged;
		foreign = landed.foreign;
	}
	if (op.kind === "promote" && !moved) {
		const lists = await rangeLists(root, op.before, undefined, core, io, { ownBases, landing: true });
		return { landing: true, specChanged: true, foreign: lists?.foreign, ...(lists ? { lists } : {}) };
	}
	const landing = op.kind === "promote" || ((op.kind === "merge" || op.kind === "ff") && !absorbing) || (op.kind === "commit" && specChanged);
	if (!landing || !moved) return { landing, specChanged, ...(foreign ? { foreign } : {}) };
	const lists = await rangeLists(root, op.before, op.after, core, io, { ownBases, landing: true });
	return { landing, specChanged, ...(foreign ? { foreign } : {}), ...(lists ? { lists } : {}) };
}

/** What a run's check has gathered so far: shared by the parent (index.ts) and pi workers (spec-worker.ts). */
export interface TurnTally {
	changed: boolean;
	landing: boolean;
	ids: Set<string>;
	advisory: Set<string>;
	unmapped: Set<string>;
	unpromoted: Set<string>;
	/** Landings described for the re-prompt ("commit by ag_07 in repo", …). */
	landed: string[];
	errors: string[];
	conflicts: string[];
	/** Git computed every part of the list … */
	exact: boolean;
	/** … and at least one part exists. */
	gitBased: boolean;
}

export const freshTally = (changed = false, landing = false): TurnTally => ({
	changed,
	landing,
	ids: new Set(),
	advisory: new Set(),
	unmapped: new Set(),
	unpromoted: new Set(),
	landed: [],
	errors: [],
	conflicts: [],
	exact: true,
	gitBased: false,
});

/** Add a computed foreign list (undefined: not computable, so the list is no longer exact). */
export function tallyForeign(t: TurnTally, foreign: readonly string[] | undefined): void {
	if (!foreign) t.exact = false;
	else t.gitBased = true;
	for (const id of foreign ?? []) t.ids.add(id);
}

/** Paths the current spec at a root (its work tree's manifest.json) maps in some claim's `code`; empty when unreadable. */
export async function mappedNow(root: string, io: SpecIO = localIO): Promise<Set<string>> {
	try {
		const m = JSON.parse(await io.readFile(join(root, SPEC_REL, "manifest.json"))) as { claims?: Record<string, { code?: unknown }> };
		return new Set(Object.values(m.claims ?? {}).flatMap((c) => (Array.isArray(c?.code) ? c.code.filter((p): p is string => typeof p === "string") : [])));
	} catch {
		return new Set();
	}
}

/**
 * Judge each operation (judgeOp) into the tally: a landing adds its gate lists. An unmapped file a claim
 * of the current spec maps by now (a promotion later in the run) is covered, as the Stop hook re-checks it.
 */
export async function tallyOps(t: TurnTally, ops: readonly OpLanding[], defaultTips: (top: string) => string | undefined, core: string, io: SpecIO = localIO): Promise<void> {
	for (const op of ops) {
		let j: OpJudgement;
		try {
			j = await judgeOp(op, core, io, defaultTips(op.top));
		} catch (error) {
			t.errors.push(`${op.top}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		t.changed = true;
		if (j.landing) {
			t.landing = true;
			const where = op.top.split("/").pop() ?? op.top;
			if (op.actor && op.actor !== "self") t.landed.push(`${op.kind} by ${op.actor} in ${where}`);
			else if (op.kind === "commit") t.landed.push(`changed the current spec in ${where}`);
			if (j.lists?.unmappedChanged.length) {
				const root = await findSpecRoot(op.top, (p) => io.exists(p));
				const mapped = root ? await mappedNow(root, io) : new Set<string>();
				for (const e of j.lists.unmappedChanged) if (!mapped.has(e.path)) t.unmapped.add(e.path);
			}
			for (const d of j.lists?.unpromotedDrafts ?? []) for (const id of d.ids) t.unpromoted.add(id);
			for (const m of j.lists?.mappedUntouched ?? []) t.advisory.add(m.id);
		}
		tallyForeign(t, j.foreign);
	}
}

/** One tree against a baseline (treeTurn) into the tally; a current spec that changed there is a landing unless `promoted` covers it. */
export async function tallyTree(t: TurnTally, start: TreeStart, core: string, io: SpecIO = localIO, options: { commits?: boolean; promoted?: boolean; label?: string } = {}): Promise<void> {
	const r = await treeTurn(start, core, io, { commits: options.commits });
	if (r.error) t.errors.push(r.error);
	if (r.conflict) t.conflicts.push(r.conflict);
	if (!r.changed) return;
	t.changed = true;
	tallyForeign(t, r.foreign);
	if (r.specChanged && !options.promoted) {
		t.landing = true;
		t.landed.push(`changed the current spec in ${start.view.top.split("/").pop()}${options.label ?? ""}`);
	}
}

/** The reply against the tally: required on a change or landing, forbidden on a Q&A run (not a relay). */
export function tallyCheck(t: TurnTally, reply: string, options: { relay?: boolean } = {}): { check: AlsoChangesCheck; foreign: string[]; required: boolean } {
	const foreign = [...t.ids].sort();
	const required = t.changed || t.landing;
	const check = checkAlsoChanges(reply, {
		required,
		forbidden: !required && !options.relay,
		foreign,
		exact: t.exact && t.gitBased,
		advisory: [...t.advisory],
		...(t.landing ? { unmapped: [...t.unmapped].sort(), unpromoted: [...t.unpromoted].sort() } : {}),
	});
	return { check, foreign, required };
}

/** Re-prompts a run gets: landings as the Claude Code Stop hook's MERGE_BLOCKS; a Q&A line once. */
export const LANDING_REPROMPTS = 2;

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
			: "";

/**
 * `Also changes:` lines a worker's report carried into the parent's session: a custom message (a
 * subagent's completion, a team report) or the result of a tool that runs workers. Returns the §
 * they name, or undefined when none named one ("none" reports no change). Not the user's words, and not other tools' output.
 */
export function reportedAlsoChanges(entries: readonly unknown[]): string[] | undefined {
	let found = false;
	const ids = new Set<string>();
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; content?: unknown; message?: { role?: string; toolName?: string; content?: unknown } };
		let text = "";
		if (e.type === "custom_message" && e.customType !== "spec-check") text = textOf(e.content);
		else if (e.type === "message" && e.message?.role === "toolResult" && /agent|team|subagent|worker/i.test(e.message.toolName ?? "")) text = textOf(e.message.content);
		for (const line of text.split("\n")) {
			const named = parseAlsoChanges(line.trim());
			// "Also changes: none" (a planning worker's, say) makes no change turn; a named § does.
			if (!named?.length) continue;
			found = true;
			for (const id of named) ids.add(id);
		}
	}
	return found ? [...ids].sort() : undefined;
}

/**
 * Whether a worker's report arrived among these entries: a custom message from the subagents or teams
 * extension, or a worker tool's result. Such a run relays work done while the session was idle.
 */
export function workerReported(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		const e = entry as { type?: string; customType?: string; message?: { role?: string; toolName?: string } };
		if (e.type === "custom_message") return /subagent|team|worker/i.test(e.customType ?? "") && e.customType !== "spec-check";
		return e.type === "message" && e.message?.role === "toolResult" && /agent|team|subagent|worker/i.test(e.message.toolName ?? "");
	});
}

// ── Writes the draft discipline forbids ──────────────────────────────────────

/** A current-spec file (manifest.json or claims/**), never a draft's: only the draft tools and a git merge write it. */
export function currentSpecPath(path: string): boolean {
	return /(?:^|\/)\.sova\/spec\/(?:manifest\.json$|claims\/)/.test(path);
}

/** A shell command allowed to write the current spec: a draft tool (promote, merge-manifest, recover) or git itself. */
export function sanctionedSpecWrite(command: string): boolean {
	return /sova-spec-draft\.mjs/.test(command) || /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+(?:merge|checkout|restore|reset|rebase|pull|cherry-pick|revert|stash|switch|am)\b/.test(command);
}

export const directWriteNote = (paths: readonly string[]): string =>
	`${DIGEST_TAG} you wrote the current spec directly (${capped(paths, FILE_CAP)}): undo it; change claims in a draft and promote (manifest conflicts: merge-manifest).`;

/** One draft's commit evidence: the commit and the § it verifies. */
export interface EvidenceCommit {
	draft: string;
	commit: string;
	ids: string[];
}

/** Every commit a draft's evidence names, at a spec root. Unreadable drafts are skipped. */
export async function evidenceCommits(root: string, io: SpecIO = localIO): Promise<EvidenceCommit[]> {
	const out: EvidenceCommit[] = [];
	let names: string[];
	try {
		names = await io.readDir(join(root, SPEC_REL, "drafts"));
	} catch {
		return out;
	}
	for (const draft of names) {
		try {
			const d = JSON.parse(await io.readFile(join(root, SPEC_REL, "drafts", draft, "draft.json"))) as { evidence?: unknown };
			for (const e of Array.isArray(d.evidence) ? (d.evidence as { mode?: unknown; commit?: unknown; ids?: unknown }[]) : [])
				if (e?.mode === "commit" && typeof e.commit === "string") {
					const ids = Array.isArray(e.ids) ? e.ids.map((i) => (i as { id?: unknown })?.id).filter((id): id is string => typeof id === "string") : [];
					const had = out.find((x) => x.draft === draft && x.commit === e.commit);
					if (had) had.ids.push(...ids.filter((id) => !had.ids.includes(id)));
					else out.push({ draft, commit: e.commit, ids });
				}
		} catch {
			// Not a draft, or unreadable.
		}
	}
	return out;
}

const lostText = (lost: readonly EvidenceCommit[]): string =>
	`${DIGEST_TAG} never rebase after evidence (PROMOTE.md): ${lost.map((e) => `draft ${e.draft}'s evidence commit ${e.commit.slice(0, 12)}${e.ids.length ? ` (${capped(e.ids, ID_CAP)})` : ""}`).join("; ")} is no longer on this branch.`;

const REBASE_ABORT = "Abort it (`git rebase --abort`) and merge master in instead.";
/** A reset only ever with the work tree clean: no uncommitted work is lost. */
const restore = (tip: string) => `With no uncommitted changes (commit them first), restore the old tip: \`git reset --hard ${tip}\`; then merge master in instead.`;

/** The write guard's line, on the call that rewrote the commits: abort a rebase under way, else restore the exact old tip. */
export function rewriteNote(lost: readonly EvidenceCommit[], old: string, rebasing: boolean): string {
	return `${lostText(lost)} ${rebasing ? REBASE_ABORT : restore(old)}`;
}

/** The census's line for evidence HEAD lacks (census `orphanedEvidence`), when the write guard didn't say it. */
export const orphanNote = (lost: readonly EvidenceCommit[]): string =>
	`${lostText(lost)} If a rebase is under way: ${REBASE_ABORT} If not: find the pre-rebase tip in \`git reflog\`. ${restore("<that tip>")}`;

/** The current-spec files Git shows changed in a tree, with their mtimes. */
async function specFiles(top: string, io: SpecIO, signal?: AbortSignal): Promise<Record<string, number>> {
	const r = await io.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", `:(glob)**/${SPEC_REL}/manifest.json`, `:(glob)**/${SPEC_REL}/claims/**`], {
		cwd: top,
		timeout: TOOL_TIMEOUT_MS,
		signal,
	});
	const files: Record<string, number> = {};
	if (r.code === 0) for (const p of parsePorcelain(r.stdout)) files[p] = (await io.mtime(join(top, p))) ?? 0;
	return files;
}

interface GuardTree {
	top: string;
	head: string;
	spec: Record<string, number>;
	evidence: EvidenceCommit[];
}

/**
 * Two writes the draft discipline forbids, said the moment they happen, in the `[spec census]` digest:
 * the current spec changed by hand (an edit or write call on it, or a shell command that is no draft
 * tool and no git operation), and commits a draft's evidence names rewritten (a rebase, reset or amend:
 * the evidence commit was on the branch before the call and isn't after). `before` looks at the trees a
 * call works in, `after` compares; both never throw. One instance per session; calls keyed by id.
 */
export class SpecWriteGuard {
	private readonly io: SpecIO;
	private readonly open = new Map<string, Promise<GuardTree[]>>();

	constructor(options: { io?: SpecIO } = {}) {
		this.io = options.io ?? localIO;
	}

	before(id: string, call: CensusCall): Promise<void> {
		const command = call.toolName.toLowerCase() === "bash" ? (call.input as { command?: unknown } | undefined)?.command : undefined;
		if (typeof command !== "string") return Promise.resolve();
		const look = this.look(commandDirs(command, call.cwd), command, call.signal).catch((): GuardTree[] => []);
		this.open.set(id, look);
		return look.then(() => undefined);
	}

	/** The note for this call, if any, and the evidence commits it said were rewritten (for the census's dedupe). */
	async after(id: string, call: CensusCall): Promise<{ text?: string; lost: string[] }> {
		const lost: string[] = [];
		const text = await this.check(id, call, lost);
		return { text, lost };
	}

	private async check(id: string, call: CensusCall, said: string[]): Promise<string | undefined> {
		try {
			const tool = call.toolName.toLowerCase();
			const input = call.input as { path?: unknown; file_path?: unknown; command?: unknown } | undefined;
			if (tool === "edit" || tool === "write" || tool === "multiedit") {
				const path = typeof input?.path === "string" ? input.path : typeof input?.file_path === "string" ? input.file_path : undefined;
				return path && currentSpecPath(path.startsWith("/") ? path : join(call.cwd, path)) ? directWriteNote([path]) : undefined;
			}
			const pending = this.open.get(id);
			this.open.delete(id);
			const command = typeof input?.command === "string" ? input.command : undefined;
			if (!pending || command === undefined) return undefined;
			const notes: string[] = [];
			for (const tree of await pending) {
				const git = (args: string[]) => this.io.exec("git", args, { cwd: tree.top, timeout: TOOL_TIMEOUT_MS, signal: call.signal });
				if (!sanctionedSpecWrite(command)) {
					const now = await specFiles(tree.top, this.io, call.signal);
					const written = Object.keys(now).filter((p) => tree.spec[p] !== now[p]);
					if (written.length) notes.push(directWriteNote(written));
				}
				if (!tree.evidence.length) continue;
				const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
				const now = head.code === 0 ? head.stdout.trim() : "";
				if (!now || now === tree.head) continue;
				const lost: EvidenceCommit[] = [];
				for (const e of tree.evidence)
					if ((await git(["merge-base", "--is-ancestor", e.commit, tree.head])).code === 0 && (await git(["merge-base", "--is-ancestor", e.commit, now])).code !== 0) lost.push(e);
				if (!lost.length) continue;
				said.push(...lost.map((e) => e.commit));
				notes.push(rewriteNote(lost, tree.head, await rebaseUnderway(tree.top, this.io, call.signal)));
			}
			return notes.length ? notes.join("\n") : undefined;
		} catch {
			return undefined;
		}
	}

	private async look(dirs: readonly string[], command: string, signal?: AbortSignal): Promise<GuardTree[]> {
		const trees: GuardTree[] = [];
		for (const dir of dirs) {
			const at = await headAt(dir, this.io);
			if (!at || trees.some((t) => t.top === at.top)) continue;
			const root = /\bgit\b/.test(command) ? await findSpecRoot(dir, (p) => this.io.exists(p)) : undefined;
			trees.push({ top: at.top, head: at.head, spec: await specFiles(at.top, this.io, signal), evidence: root ? await evidenceCommits(root, this.io) : [] });
		}
		return trees;
	}
}

// ── promote's drift warnings ─────────────────────────────────────────────────

/** The JSON array starting at `text[i]` (a `[`), or undefined. */
function jsonArrayAt(text: string, i: number): unknown[] | undefined {
	let depth = 0;
	let quoted = false;
	for (let j = i; j < text.length; j++) {
		const ch = text[j];
		if (quoted) {
			if (ch === "\\") j++;
			else if (ch === '"') quoted = false;
		} else if (ch === '"') quoted = true;
		else if (ch === "[") depth++;
		else if (ch === "]" && --depth === 0) {
			try {
				const value = JSON.parse(text.slice(i, j + 1));
				return Array.isArray(value) ? value : undefined;
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** promote's `driftWarnings` in a tool's output: the `--json` field, or the text form's `warn drift:` lines. */
export function driftWarningsIn(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/"driftWarnings"\s*:\s*\[/g)) for (const w of jsonArrayAt(text, m.index + m[0].length - 1) ?? []) if (typeof w === "string") out.push(w);
	for (const m of text.matchAll(/^\s*warn drift: (.+)$/gm)) out.push(m[1].trim());
	return [...new Set(out)];
}

/** For a promote call's result (preview or --write): its drift warnings, relayed as a warning (never a block). */
export function driftNote(toolName: string, input: unknown, content: unknown): string | undefined {
	const command = toolName.toLowerCase() === "bash" ? (input as { command?: unknown } | undefined)?.command : undefined;
	if (typeof command !== "string" || !/sova-spec-draft\.mjs["']?\s+promote\b/.test(command)) return undefined;
	const warnings = driftWarningsIn(textOf(content));
	if (!warnings.length) return undefined;
	return `${CHECK_TAG} promote's drift warnings (a warning, not a block): ${warnings.map((w, i) => `(${i + 1}) ${w}`).join(" ")}\nFor each: change the stale § in a draft and promote (name it in \`Also changes:\`), or say why it stays.`;
}

// ── The workers' ledger (M4) ─────────────────────────────────────────────────

/** The env var the spawn path sets on every spec-on worker and member: the parent's ledger file. */
export const LEDGER_ENV = "SOVA_SPEC_LEDGER";

/** One git operation a worker's hooks saw move a HEAD, as a line of the parent's ledger. */
export interface LedgerEntry {
	v: 1;
	/** ms since the epoch. */
	at: number;
	actor: { runtime: "pi" | "claude-code"; session?: string };
	/** The tree top the HEAD moved in. */
	top: string;
	before: string;
	after: string;
	kind: "commit" | "merge" | "promote" | "ff" | "rebase" | "reset";
	/** For a merge: the target branch (when known). */
	target?: string;
	ref?: string;
}

/** The ledger file of a parent session: `<agentDir>/sova/spec-ledger/<parentSessionId>.jsonl`. */
export function ledgerPath(agentDir: string, parentSessionId: string): string {
	return join(agentDir, "sova", "spec-ledger", `${parentSessionId.replace(/[^\w.-]/g, "_")}.jsonl`);
}

/** Append one entry (creating the file); never throws. */
export function appendLedger(path: string, entry: LedgerEntry): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch {
		// The ledger is best effort: a worker's op then counts only through the parent's own tree compare.
	}
}

/** Entries at or after `since` (ms); malformed lines skipped; [] without a file. */
export function readLedger(path: string, since = 0): LedgerEntry[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: LedgerEntry[] = [];
	for (const line of text.split("\n")) {
		try {
			const e = JSON.parse(line) as LedgerEntry;
			if (e?.v === 1 && typeof e.top === "string" && typeof e.before === "string" && typeof e.after === "string" && typeof e.at === "number" && e.at >= since) out.push(e);
		} catch {
			// a partial or foreign line
		}
	}
	return out;
}
