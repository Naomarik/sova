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
 * - **Promote drift** (driftNote): a promote call's drift warnings, relayed in the same digest.
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
export const TOOL_TIMEOUT_MS = 5000;
/** Files and ids shown before "+N more". */
export const FILE_CAP = 8;
export const ID_CAP = 12;
/** How many § each file in the digest's `New:` line names. */
export const NEW_ID_CAP = 3;
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

/** Draft names created by `sova-spec-draft.mjs new <name> … --write` (draftToolRuns) among these shell commands, in order. */
export function draftsCreated(commands: readonly string[]): string[] {
	const names: string[] = [];
	for (const command of commands)
		for (const r of draftToolRuns(command)) if (r.verb === "new" && r.args.includes("--write") && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.args[0] ?? "")) names.push(r.args[0]!);
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
	/** In-boundary changed files a claim maps, with their §. */
	claimed: { path: string; claims: string[] }[];
	/** null without a boundary: nothing is judged unclaimed. */
	unclaimed: string[] | null;
	/** Changed files outside the boundary that a claim's `code` maps. */
	mappedOutside: { path: string; claims: string[] }[];
	/** Changed files outside the boundary (mapped or not); null without a boundary. */
	outside?: string[] | null;
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
	if (out?.exit === 2 || !c || c.mode !== "changed") return undefined;
	return {
		claimed: pathClaims(c.claimed),
		unclaimed: Array.isArray(c.unclaimed) ? (c.unclaimed as string[]) : null,
		mappedOutside: pathClaims(c.mappedOutside),
		outside: Array.isArray(c.outside) ? (c.outside as string[]) : null,
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
	/** Why the census couldn't run, each said once; cleared when a census succeeds (absent in older state files). */
	failSaid?: string[];
	/** The manifest conflict now in progress was already reported (absent in older state files). */
	conflict?: boolean;
	/** Orphaned evidence commits already said (by the census or the write guard). */
	orphans?: string[];
	/** Revs the task's own claims are absent at (ownBasesFor at the first look): census --own-base. */
	ownBases?: string[];
	/** What the digest printed once and holds back after (absent in older state files). */
	said?: CensusSaid;
}

/** The digest's once-per-session lines, marked only on the note that printed them. */
export interface CensusSaid {
	noDraft?: boolean;
}

export const freshCensusState = (): CensusState => ({ base: null, top: null, known: [], reported: false });

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
	/** The census couldn't run: the model line (failureNote), once per cause per work tree. */
	failure?: string;
}

/** A bash call that ran the census itself already shows it. */
export function ranCensus(toolName: string, input: unknown): boolean {
	const command = toolName.toLowerCase() === "bash" ? (input as { command?: unknown } | undefined)?.command : undefined;
	return typeof command === "string" && /sova-spec\.mjs/.test(command) && /\bcensus\b/.test(command);
}

const capped = (items: readonly string[], cap: number): string =>
	items.length > cap ? `${items.slice(0, cap).join(", ")} (+${items.length - cap} more)` : items.join(", ");

/** The line for the new changed files outside the boundary that no claim maps. */
export const unmappedNote = (files: readonly string[]): string =>
	`Outside the boundary, no claim maps: ${capped(files, FILE_CAP)}: spec any whose change a user sees`;

export const NO_DRAFT_NOTE =
	"No draft yet: a behaviour change needs its claim sentence in a draft before code (`sova-spec-draft.mjs new <name> --write`, then edit the claim); work that changes no behaviour: say you claim the exemption, decided from passages you read.";

/** The model's line when the census can't run. */
export const failureNote = (why: string): string => `${DIGEST_TAG} incomplete: ${why}; run census by hand`;

/**
 * The digest for the files new since the last look, or undefined when there is nothing to say: a first
 * in-boundary change, a new file in the boundary or mapped by a claim, or a new file outside the boundary
 * that no claim maps (it may still change behavior).
 */
export function digest(v: CensusView, fresh: readonly string[], state: Pick<CensusState, "reported" | "said">, hasDraft: boolean): string | undefined {
	return digestSaying(v, fresh, state, hasDraft).text;
}

/**
 * The digest and what it printed of the once-per-session lines (`said`, the next state's). Each file in
 * `New:` names at most NEW_ID_CAP §, at most FILE_CAP files; the No draft line prints once.
 */
export function digestSaying(v: CensusView, fresh: readonly string[], state: Pick<CensusState, "reported" | "said">, hasDraft: boolean): { text?: string; said: CensusSaid } {
	const said: CensusSaid = { ...state.said };
	const inBoundary = new Map<string, string>();
	for (const e of v.claimed) inBoundary.set(e.path, capped(e.claims, NEW_ID_CAP));
	for (const p of v.unclaimed ?? []) inBoundary.set(p, "unclaimed");
	for (const e of v.mappedOutside) inBoundary.set(e.path, `outside the boundary, mapped by ${capped(e.claims, NEW_ID_CAP)}`);
	const freshIn = fresh.filter((p) => inBoundary.has(p));
	const first = !state.reported && inBoundary.size > 0;
	// Outside the boundary and no claim maps it: the spec's own files never count.
	const unmapped = fresh.filter((p) => v.outside?.includes(p) && !inBoundary.has(p) && !p.startsWith(".sova/"));
	if (!first && !freshIn.length && !unmapped.length) return { said: state.said ?? {} };
	const unclaimed = v.unclaimed?.length ?? 0;
	const lines = [
		`${DIGEST_TAG} ${v.claimed.length + unclaimed} changed file(s) in the boundary, ${unclaimed} unclaimed` +
			(v.mappedOutside.length ? `; ${v.mappedOutside.length} mapped outside the boundary.` : "."),
	];
	if (!hasDraft && inBoundary.size && !said.noDraft) {
		lines.push(NO_DRAFT_NOTE);
		said.noDraft = true;
	}
	if (freshIn.length) {
		const shown = freshIn.slice(0, FILE_CAP).map((p) => `${p} → ${inBoundary.get(p)}`);
		lines.push(`New: ${shown.join("; ")}${freshIn.length > FILE_CAP ? ` (+${freshIn.length - FILE_CAP} more)` : ""}`);
	}
	if (unmapped.length) lines.push(unmappedNote(unmapped));
	return { text: lines.join("\n"), said };
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
	const next: CensusState = { ...state, known: [...state.known], orphans: [...new Set([...(state.orphans ?? []), ...(call.orphansSaid ?? [])])] };
	try {
		const view = await gitView(call.cwd, io, call.signal);
		if (!view) {
			if (!state.top) return { state, result: {} };
			return failed(next, "Git view unavailable");
		}
		seen.view = view;
		if (next.top !== view.top) {
			// First look at this tree: its current changes are the baseline, not the task's.
			const main = await defaultBranch(view.top, io);
			const tip = main ? (await io.exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${main}`], { cwd: view.top, timeout: TOOL_TIMEOUT_MS })).stdout.trim() : "";
			const ownBases = await ownBasesFor(view.top, view.head, tip || undefined, io);
			Object.assign(next, freshCensusState(), { base: view.head, top: view.top, known: Object.keys(view.files), ...(ownBases.length ? { ownBases } : {}) });
			delete next.said;
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
		if (!root) return { state: next, result: {} };
		if (!(await io.exists(tool))) return failed(next, "trusted census unavailable");
		const census = async (spec?: string) => {
			const own = (next.ownBases ?? []).flatMap((rev) => ["--own-base", rev]);
			const args = [tool, "census", "--changed", "--json", "--root", root, ...(next.base ? ["--base", next.base] : []), ...own, ...(spec ? ["--spec", spec] : [])];
			const r = await io.exec("node", args, { cwd: root, timeout: TOOL_TIMEOUT_MS, signal: call.signal });
			let incomplete: string | undefined;
			try {
				const out = JSON.parse(r.stdout);
				if (out.complete === false || out.census?.draftScan?.complete === false) incomplete = Array.isArray(out.incomplete) ? out.incomplete.join(", ") : "partial draft scan";
			} catch { /* unusable output is reported below */ }
			return { view: parseCensus(r.stdout), ran: r.stdout.trim() !== "", incomplete };
		};
		const spec = await pickDraft(root, call.commands ?? [], call.sessionStart, io);
		let r = await census(spec);
		if (!r.view && spec) r = await census(); // an unreadable draft: the current spec still maps the files
		if (!r.ran || !r.view) return failed(next, !r.ran ? "the census produced no output (timeout or crash)" : "unusable census output");
		const freshRel = fresh.map((p) => underRoot(view.top, root, p)).filter((p): p is string => p !== undefined);
		const orphans = (r.view.orphanedEvidence ?? []).filter((e) => !next.orphans?.includes(e.commit));
		const { text: said, said: printed } = digestSaying(r.view, freshRel, next, Boolean(spec));
		if (said) {
			next.reported = true;
			next.said = printed;
		}
		if (orphans.length) next.orphans = [...(next.orphans ?? []), ...orphans.map((e) => e.commit)];
		const text = [orphans.length ? orphanNote(orphans) : undefined, said].filter(Boolean).join("\n");
		if (r.incomplete) {
			const fail = failed(next, r.incomplete);
			return { state: fail.state, result: { ...(text ? { text } : {}), ...fail.result } };
		}
		delete next.failSaid;
		return { state: next, result: text ? { text } : {} };
	} catch (error) {
		return failed(next, error instanceof Error ? error.message : String(error));
	}
}

/** A census that couldn't run: its line, unless this cause was already said in this tree since the last census that ran. */
/** A step whose text the caller discards (a baseline): a failure it hit stays unsaid, so the next shown step says it. */
export async function silentCensusStep(state: CensusState, call: CensusCall, core: string, io: SpecIO = localIO): Promise<CensusState> {
	const step = await censusStep(state, call, core, io);
	if (!step.result.failure) return step.state;
	const { failSaid: _, ...rest } = step.state;
	return state.failSaid ? { ...rest, failSaid: state.failSaid } : rest;
}

function failed(next: CensusState, why: string): { state: CensusState; result: CensusResult } {
	if (next.failSaid?.includes(why)) return { state: next, result: {} };
	return { state: { ...next, failSaid: [...(next.failSaid ?? []), why] }, result: { failure: failureNote(why) } };
}

/**
 * pi tools that cannot write the repository, by exact name: the census neither looks nor moves its
 * baseline after them, so the next call that can write reports every change since. Bash is never here.
 */
export const CENSUS_SKIP_TOOLS: ReadonlySet<string> = new Set([
	"read", "grep", "find", "ls", "align",
	"agent_list", "agent_models", "agent_transcript", "agent_wait", "team_list", "team_inbox", "team_roster",
	"link_inbox", "link_members", "link_offers",
]);

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
		const state = await silentCensusStep(freshCensusState(), { cwd: dir, toolName: "", input: undefined, signal }, this.core(), this.io);
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
		if (CENSUS_SKIP_TOOLS.has(call.toolName)) return Promise.resolve();
		return this.serial(async () => {
			for (const dir of callDirs(call)) await this.baseline(dir, call.signal);
		}, undefined);
	}

	after(call: CensusCall): Promise<CensusResult> {
		if (CENSUS_SKIP_TOOLS.has(call.toolName)) return Promise.resolve({});
		return this.serial(async () => {
			const texts: string[] = [];
			const failures: string[] = [];
			const done = new Set<string>();
			for (const dir of callDirs(call)) {
				const top = await this.topOf(dir, call.signal);
				if (!top || done.has(top)) continue;
				done.add(top);
				const { state, result } = await censusStep(this.states.get(top) ?? freshCensusState(), { ...call, cwd: dir }, this.core(), this.io);
				this.states.set(top, state);
				if (result.text) texts.push(result.text);
				if (result.failure) failures.push(result.failure);
			}
			return { ...(texts.length ? { text: texts.join("\n") } : {}), ...(failures.length ? { failure: failures.join("\n") } : {}) };
		}, {} as CensusResult);
	}
}

// ── Shell commands ───────────────────────────────────────────────────────────

/** A shell command's text with each heredoc body removed (the body is data, never a command). */
function withoutHeredocs(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		out.push(line);
		for (const m of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g)) {
			const strip = m[1] === "-";
			while (i + 1 < lines.length && (strip ? lines[i + 1]!.replace(/^\t+/, "") : lines[i + 1]) !== m[3]) i++;
			if (i + 1 < lines.length) i++;
		}
	}
	return out.join("\n");
}

/**
 * The simple commands of a shell command, each as its words (quotes removed, `$` references kept as
 * written): split at `;`, `&`, `|`, newlines, parentheses, backticks and `$(`, outside quotes; heredoc
 * bodies and comments dropped. A reading for recognising commands, not a shell.
 */
export function simpleCommands(command: string): string[][] {
	const text = withoutHeredocs(command);
	const commands: string[][] = [];
	let words: string[] = [];
	let word: string | undefined;
	const endWord = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "\\") {
			if (text[i + 1] === "\n") i++;
			else if (i + 1 < text.length) word = (word ?? "") + text[++i];
			continue;
		}
		if (c === "'") {
			const end = text.indexOf("'", i + 1);
			word = (word ?? "") + text.slice(i + 1, end < 0 ? text.length : end);
			i = end < 0 ? text.length : end;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let body = "";
			for (; j < text.length && text[j] !== '"'; j++) {
				if (text[j] === "\\" && j + 1 < text.length) j++;
				body += text[j];
			}
			word = (word ?? "") + body;
			i = j;
			continue;
		}
		if (c === "#" && word === undefined) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
			continue;
		}
		if (c === "$" && text[i + 1] === "(") {
			endCommand();
			i++;
			continue;
		}
		if (";&|\n()`".includes(c)) {
			endCommand();
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			continue;
		}
		word = (word ?? "") + c;
	}
	endCommand();
	return commands;
}

/** Node options that take the next word as their value. */
const NODE_VALUE_OPTIONS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C"]);

/**
 * Each run of the draft tool in a shell command: its verb and the words after it. The script is
 * `…/sova-spec-draft.mjs` or a variable (`$d`, `"$d"`, `${d}`: the tool through a path held in one),
 * run by `node` (its options skipped) or directly, after any `VAR=value` assignments. Words inside a
 * heredoc body, an echo or printf, or quotes of another command are never a run.
 */
export function draftToolRuns(command: string): { verb: string; args: string[] }[] {
	const runs: { verb: string; args: string[] }[] = [];
	for (const words of simpleCommands(command)) {
		let i = 0;
		while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]!)) i++;
		while (i < words.length && ["exec", "command", "time", "env"].includes(words[i]!)) i++;
		if (/(^|\/)node$/.test(words[i] ?? "")) {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) i += NODE_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
		}
		const script = words[i];
		if (!script || !(/(^|\/)sova-spec-draft\.mjs$/.test(script) || /^\$(\w+|\{\w+\})$/.test(script))) continue;
		const verb = words[i + 1];
		if (verb) runs.push({ verb, args: words.slice(i + 2) });
	}
	return runs;
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

/** The repo's default branch: origin/HEAD's target, else `master`, else `main`; undefined when none exists. */
export async function defaultBranch(top: string, io: SpecIO = localIO): Promise<string | undefined> {
	const git = (args: string[]) => io.exec("git", args, { cwd: top, timeout: TOOL_TIMEOUT_MS });
	const origin = (await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
	if (origin) return origin.replace(/^origin\//, "");
	for (const name of ["master", "main"]) if ((await git(["rev-parse", "--verify", "-q", `refs/heads/${name}`])).code === 0) return name;
	return undefined;
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

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n")
			: "";

// ── Writes the draft discipline forbids ──────────────────────────────────────

/** A current-spec file (manifest.json or claims/**), never a draft's: only the draft tools and a git merge write it. */
export function currentSpecPath(path: string): boolean {
	return /(?:^|\/)\.sova\/spec\/(?:manifest\.json$|claims\/)/.test(path);
}

/** A shell command allowed to write the current spec: a draft tool (promote, merge-manifest, recover) or git itself. */
export function sanctionedSpecWrite(command: string): boolean {
	return /sova-spec-draft\.mjs/.test(command) || draftToolRuns(command).some((r) => ["promote", "recover", "merge-manifest"].includes(r.verb)) || /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+(?:merge|checkout|restore|reset|rebase|pull|cherry-pick|revert|stash|switch|am)\b/.test(command);
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
	if (typeof command !== "string" || !draftToolRuns(command).some((r) => r.verb === "promote")) return undefined;
	const warnings = driftWarningsIn(textOf(content));
	if (!warnings.length) return undefined;
	return `${DIGEST_TAG} promote's drift warnings: ${warnings.map((w, i) => `(${i + 1}) ${w}`).join(" ")}\nFor each: change the stale § in a draft and promote, or say why it stays.`;
}
