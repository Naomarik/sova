/**
 * What a merge leaves to do in the project's spec (`.sova/spec/`), for the merge note the model reads: warnings it
 * can act on, from the spec core's landing lists (`sova-spec.mjs foreign --landing`) and the drafts' evidence. It
 * only reads: git by argument list (the extension's `Git`) and the sibling spec tools run with node, never a shell.
 * Before the merge, landDocs makes the worktree's drafts official on its branch (one docs commit), or refuses it.
 * A project without a spec, or an install without the spec tools, gets nothing. Node builtins only.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "./git.ts";

/** The spec tools shipped beside this extension (`extensions/spec/core`). */
export const SPEC_CORE_DIR = join(import.meta.dirname, "..", "spec", "core");
const DRAFTS = ".sova/spec/drafts";

/** What a landing leaves behind: the core's `foreign --landing` lists. */
export interface MergeLanding {
	/** Changed files (deletions too) no claim's `code` maps. */
	unmappedChanged: { path: string; status: string; inBoundary: boolean }[];
	/** Draft records left unpromoted in the merged worktree and in worktrees whose branch the merge contains. */
	unpromotedDrafts: { draft: string; worktree: string; ids: string[] }[];
	/** § of a merge commit that differ from every parent: a hand resolution. */
	handResolved: { commit: string; ids: string[] }[];
}

/** One sentence the model can act on; a `key` marks one said once a session (a draft at its pending §). */
export interface SpecWarning {
	text: string;
	key?: string;
}

export interface MergeSpecReport {
	/** Unmapped files, unpromoted draft records, hand resolutions, orphaned evidence, or that they could not be computed. */
	warnings: SpecWarning[];
	/** The landing lists, when the core computed them. */
	landing?: MergeLanding;
	/** The target's top level (its checkout), when git lists one. */
	top?: string;
}

export interface MergeSpecRequest {
	/** The worktree's top level: its drafts are read there. */
	path: string;
	branch: string;
	/** Target tip before and after the merge, and the branch tip merged. */
	before: string;
	after: string;
	branchSha: string;
	/** The target is the repo's default branch: the landing's own drafts didn't land with it, and are kept for a fresh branch. */
	onDefault?: boolean;
}

type Node = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
const runNode: Node = (args, cwd) =>
	new Promise((done) => {
		execFile(process.execPath, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
			done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 2) : 0, stdout: String(stdout) });
		});
	});

const json = (s: string): Record<string, any> | undefined => {
	try {
		const j = JSON.parse(s);
		return j && typeof j === "object" ? j : undefined;
	} catch {
		return undefined;
	}
};
const short = (sha: string) => sha.slice(0, 7);

/** The report for one merge, or undefined when the project has no spec (at either end) or the tools are missing. */
export async function mergeSpecReport(git: Git, req: MergeSpecRequest, opts: { coreDir?: string; node?: Node } = {}): Promise<MergeSpecReport | undefined> {
	const coreDir = opts.coreDir ?? SPEC_CORE_DIR;
	const node = opts.node ?? runNode;
	const core = join(coreDir, "sova-spec.mjs");
	if (!existsSync(core)) return undefined;
	const top = (await git(["rev-parse", "--show-toplevel"], req.path)).stdout.trim() || req.path;
	const hasSpec = async (rev: string) => (await git(["cat-file", "-e", `${rev}:.sova/spec/manifest.json`], top)).code === 0;
	if (!(await hasSpec(req.after)) && !(await hasSpec(req.before))) return undefined;

	// The target before vs after, with the landing lists; the merged worktree's drafts are read whatever its HEAD.
	const f = json((await node([core, "foreign", "--base", req.before, "--head", req.after, "--landing", "--drafts", req.path, "--root", top, "--json"], top)).stdout);
	const warnings: SpecWarning[] = [];
	const landing: MergeLanding | undefined = Array.isArray(f?.unmappedChanged)
		? { unmappedChanged: f.unmappedChanged, unpromotedDrafts: f.unpromotedDrafts ?? [], handResolved: f.handResolved ?? [] }
		: undefined;
	if (landing) {
		const u = landing.unmappedChanged;
		if (u.length)
			warnings.push({ text: `${u.length} changed file${u.length === 1 ? "" : "s"} no claim maps (${u.map((x) => `${x.path}${x.status === "D" ? " deleted" : ""}`).join(", ")}): spec any whose change a user sees` });
		for (const d of landing.unpromotedDrafts) {
			const own = d.worktree === top || d.worktree === req.path;
			const them = d.ids.length === 1 ? "it" : "them";
			// A merge makes the worktree's own drafts official first (landDocs), so its own left here were left on
			// purpose (withoutDocs); they land only from a branch whose worktree holds the draft.
			const they = them === "it" ? "it" : "they", lands = them === "it" ? "it lands" : "they land";
			const what = !own
				? `${lands} when that worktree's branch lands`
				: req.onDefault
					? `${they} didn't land with the code; the draft stays in ${d.worktree}/${DRAFTS}/${d.draft} until it lands with a fresh branch from the default branch (copy it into that worktree's ${DRAFTS}/), never on it directly`
					: `${they} didn't land with the code; copy the draft into the worktree of the branch it merged into, so ${lands} with that branch`;
			warnings.push({
				text: `draft ${d.draft}${own ? "" : ` in ${d.worktree}`} has ${d.ids.length} unpromoted record${d.ids.length === 1 ? "" : "s"} (${d.ids.join(", ")}): ${what}`,
				key: `${d.worktree}\0${d.draft}\0${d.ids.join(",")}`,
			});
		}
		for (const h of landing.handResolved)
			warnings.push({ text: `merge ${short(h.commit)} resolved ${h.ids.join(", ")} by hand (it differs from both parents; see git show --cc ${short(h.commit)}): check it says what both sides meant` });
	} else {
		const why = (f?.findings as { message?: string }[] | undefined)?.map((x) => x.message).join("; ") || "no output";
		warnings.push({ text: `the merge's unmapped files and unpromoted drafts could not be computed (${why}); check them yourself` });
	}

	const targetTop = await checkoutOf(git, top, req.after);
	return { warnings, ...(landing ? { landing } : {}), ...(targetTop ? { top: targetTop } : {}) };
}

/** The worktree whose checkout is at `sha` on a branch (the merge's target), from `git worktree list`. */
async function checkoutOf(git: Git, cwd: string, sha: string): Promise<string | undefined> {
	const r = await git(["worktree", "list", "--porcelain"], cwd);
	if (r.code !== 0) return undefined;
	for (const block of r.stdout.split("\n\n")) {
		const lines = block.split("\n");
		const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
		if (path && lines.includes(`HEAD ${sha}`) && lines.some((l) => l.startsWith("branch "))) return path;
	}
	return undefined;
}

/** The drafts in a worktree, by name (a folder holding a draft.json). */
function draftNames(root: string): string[] {
	const dir = join(root, DRAFTS);
	try {
		return readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n) && existsSync(join(dir, n, "draft.json"))).sort();
	} catch {
		return [];
	}
}

/** One problem the draft tool's land found (its JSON findings). */
export interface DocsFinding {
	draft?: string | null;
	id?: string | null;
	code: string;
	message: string;
	fix?: string;
}

/** What the docs step before a merge did (§chat.worktrees/tool): nothing to land, a docs commit, or a refusal. */
export type DocsLanding =
	| { state: "none" }
	| { state: "landed"; sha: string; subject: string; drafts: string[]; counts: { added: number; changed: number; removed: number } }
	| { state: "refused"; findings: DocsFinding[]; text: string };

/**
 * Before a worktree's branch is merged, its spec drafts are made official on it: the draft tool's `land --write` at
 * the branch's head, then one commit of exactly the spec files it wrote, with its message and the trailer
 * `Sova-Spec-Landing: worktree-tool`. A project with no spec, a worktree with no draft, or an install without the spec
 * tools has nothing to do. When land refuses, nothing is written or committed, and the merge must not run.
 */
export async function landDocs(git: Git, req: { path: string; branch: string; target?: string }, opts: { coreDir?: string; node?: Node } = {}): Promise<DocsLanding> {
	const tool = join(opts.coreDir ?? SPEC_CORE_DIR, "sova-spec-draft.mjs");
	const node = opts.node ?? runNode;
	if (!existsSync(join(req.path, ".sova", "spec", "manifest.json")) || !draftNames(req.path).length || !existsSync(tool)) return { state: "none" };
	const head = (await git(["rev-parse", "HEAD"], req.path)).stdout.trim();
	if (!/^[0-9a-f]{40,64}$/.test(head)) return { state: "none" };
	// The spec's own files must be as committed: the docs commit holds exactly what land wrote.
	const dirty = (await git(["status", "--porcelain", "--", ".sova/spec"], req.path)).stdout.trim();
	if (dirty) return refusedOf(req.branch, [{ code: "spec-uncommitted", message: `the spec has uncommitted changes (${dirty.split("\n")[0].trim()})`, fix: "commit or undo them first" }]);
	// A merge that can't run anyway (it doesn't merge cleanly, or it can only fast-forward and can't) gets no docs commit.
	const targetSha = req.target ? (await git(["rev-parse", "--verify", "-q", `refs/heads/${req.target}`], req.path)).stdout.trim() : "";
	const clean = async (sha: string) => !targetSha || (await git(["merge-tree", "--write-tree", "--no-messages", targetSha, sha], req.path)).code === 0;
	if (!(await clean(head))) return { state: "none" };
	// draft.json is all land writes in a draft: kept, so a docs commit taken back puts the drafts back as they were.
	const kept = new Map(draftNames(req.path).map((n) => [n, readFileSync(join(req.path, DRAFTS, n, "draft.json"))]));
	const verification = `Made official at the merge of ${req.branch} at ${short(head)} by the worktree tool`;
	const j = json((await node([tool, "land", "--commit", head, "--by", "the worktree tool's merge", "--verification", verification, "--write", "--root", req.path, "--json"], req.path)).stdout);
	if (!j || typeof j.exit !== "number") return refusedOf(req.branch, [{ code: "land-no-answer", message: "the draft tool's land gave no answer" }]);
	if (j.exit === 0 && j.nothingToLand) return { state: "none" };
	if (j.exit !== 0 || !j.written) return refusedOf(req.branch, Array.isArray(j.findings) ? j.findings : [{ code: "land-refused", message: "the draft tool's land refused" }]);
	const paths = (Array.isArray(j.paths) ? j.paths : []).filter((p: unknown): p is string => typeof p === "string" && p.startsWith(".sova/spec/") && !p.startsWith(`${DRAFTS}/`));
	if (!paths.length) return { state: "none" };
	const add = await git(["add", "--", ...paths], req.path);
	if (add.code !== 0) throw new Error(`Staging the docs failed: ${add.stderr.trim()}`);
	const msg = j.commitMessage ?? {};
	const c = await git(["commit", "--no-verify", "-m", String(msg.subject || `Spec: land drafts at ${short(head)}`), "-m", String(msg.body || verification), "-m", "Sova-Spec-Landing: worktree-tool"], req.path);
	if (c.code !== 0) throw new Error(`Committing the docs failed: ${c.stderr.trim()}`);
	const sha = (await git(["rev-parse", "HEAD"], req.path)).stdout.trim();
	// The docs that landed on the target meanwhile clash with these: the docs commit is taken back, nothing changed.
	if (!(await clean(sha))) {
		const mt = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", targetSha, sha], req.path);
		const files = mt.stdout.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.startsWith(".sova/spec/"));
		const back = await git(["reset", "--keep", head], req.path);
		if (back.code !== 0) throw new Error(`The docs commit ${short(sha)} clashes with ${req.target} and couldn't be taken back: ${back.stderr.trim()}`);
		for (const [n, buf] of kept) writeFileSync(join(req.path, DRAFTS, n, "draft.json"), buf);
		const landed = new Set<string>((Array.isArray(j.drafts) ? j.drafts : []).flatMap((d: { ids?: unknown }) => (Array.isArray(d?.ids) ? d.ids : [])));
		const ids = files.flatMap((f) => {
			try {
				return [...readFileSync(join(req.path, f), "utf8").matchAll(/^#{1,2} (§[^\s]+)/gm)].map((m) => m[1]).filter((id) => landed.has(id));
			} catch {
				return [];
			}
		});
		return refusedOf(req.branch, (ids.length ? [...new Set(ids)] : [null]).map((id) => ({ id, code: "conflict", message: `${id ?? "the drafts"} changed on ${req.target} since the drafts were made (${files.join(", ") || "the spec"})`, fix: "merge it into this branch, then run the draft tool's refresh on the draft and rewrite what it marks" })));
	}
	const counts = { added: Number(j.counts?.added) || 0, changed: Number(j.counts?.changed) || 0, removed: Number(j.counts?.removed) || 0 };
	return { state: "landed", sha, subject: String(msg.subject ?? ""), drafts: (Array.isArray(j.drafts) ? j.drafts : []).map((d: { name?: unknown }) => String(d?.name)), counts };
}

function refusedOf(branch: string, findings: DocsFinding[]): DocsLanding {
	const list = findings.slice(0, 8).map((f) => `${f.id ?? (f.draft ? `draft ${f.draft}` : f.code)}${f.draft && f.id ? ` (draft ${f.draft})` : ""}: ${f.message}${f.fix ? `; fix: ${f.fix}` : ""}`);
	return {
		state: "refused",
		findings,
		text: `Nothing was merged: ${branch}'s spec drafts don't fit, so they can't land with it, and nothing was written. ${list.join(". ")}${findings.length > 8 ? `. And ${findings.length - 8} more` : ""}. Fix them in the drafts (that needs no commit), then merge again. Merge with withoutDocs: true only when the user says to leave the drafts behind.`,
	};
}

/**
 * The lines added to the merge note, one `Spec warning: …` per warning. A keyed one (a draft at its pending §) is
 * said once: with `said`, a key already in it is left out and a new one is added.
 */
export function specLines(r: MergeSpecReport, said?: Set<string>): string[] {
	const out: string[] = [];
	for (const w of r.warnings) {
		if (w.key !== undefined && said) {
			if (said.has(w.key)) continue;
			said.add(w.key);
		}
		out.push(`Spec warning: ${w.text}`);
	}
	return out;
}

/**
 * Decisions agreed in the main checkout ride with a new worktree's branch (§chat.worktrees/tool): each draft there
 * holding a record not yet official that carries `agreed` is copied, whole, into the new worktree's drafts, unless
 * one of that name is there already, so it becomes official when that branch lands. The main checkout keeps its copy.
 * Read through the draft tool (`drafts`) and the spec's own record reader. → the names copied
 */
export async function carryAgreedDrafts(git: Git, req: { from: string; to: string }, opts: { coreDir?: string; node?: Node } = {}): Promise<string[]> {
	const coreDir = opts.coreDir ?? SPEC_CORE_DIR;
	const tool = join(coreDir, "sova-spec-draft.mjs");
	const node = opts.node ?? runNode;
	const top = (await git(["rev-parse", "--show-toplevel"], req.from)).stdout.trim();
	if (!top || top === req.to || !draftNames(top).length || !existsSync(tool) || !existsSync(join(req.to, ".sova", "spec", "manifest.json"))) return [];
	const j = json((await node([tool, "drafts", "--root", top, "--json"], top)).stdout);
	const rows: { name?: unknown; pending?: unknown }[] = Array.isArray(j?.drafts) ? j.drafts : [];
	const { readSpecFs } = await import(join(coreDir, "layout.mjs"));
	const out: string[] = [];
	for (const r of rows) {
		const name = typeof r.name === "string" ? r.name : "";
		const pending = Array.isArray(r.pending) ? r.pending.filter((x): x is string => typeof x === "string") : [];
		if (!name || !pending.length || existsSync(join(req.to, DRAFTS, name))) continue;
		const spec = readSpecFs(top, `${DRAFTS}/${name}/spec`);
		if (spec?.state !== "present" || !pending.some((id) => spec.records?.[id]?.agreed)) continue;
		cpSync(join(top, DRAFTS, name), join(req.to, DRAFTS, name), { recursive: true, errorOnExist: true });
		out.push(name);
	}
	return out;
}
