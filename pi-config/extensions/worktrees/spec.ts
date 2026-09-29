/**
 * What a merge does to the project's spec (`.sova/spec/`), for the merge note the model reads: the foreign § the
 * merge changes, computed by the spec core (`sova-spec.mjs foreign`), and warnings about spec work the merge left
 * behind. It only reads: git by argument list (the extension's `Git`) and the sibling spec tools run with node,
 * never a shell. A project without a spec, or an install without the spec tools, gets nothing. Node builtins only.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "./git.ts";

/** The spec tools shipped beside this extension (`extensions/spec/core`). */
export const SPEC_CORE_DIR = join(import.meta.dirname, "..", "spec", "core");
const DRAFTS = ".sova/spec/drafts";

/** What a landing brings besides its foreign §: the core's `foreign --landing` lists. */
export interface MergeLanding {
	/** Changed files (deletions too) no claim's `code` maps: each needs a claim, or a `Plumbing: <path> — <why>` line. */
	unmappedChanged: { path: string; status: string; inBoundary: boolean }[];
	/** § whose mapped code changed while their prose and record didn't (advisory). */
	mappedUntouched: { id: string; files: string[] }[];
	/** Draft records left unpromoted in the merged worktree and in worktrees whose branch the merge contains. */
	unpromotedDrafts: { draft: string; worktree: string; ids: string[] }[];
	/** § of a merge commit that differ from every parent: a hand resolution. */
	handResolved: { commit: string; ids: string[] }[];
}

export interface MergeSpecReport {
	/** § the merge changed that it did not create (the core's `foreign`), sorted. */
	foreign: string[];
	/** Deleted foreign § (a rename's old id, with where it went); they stay in `foreign`. */
	deleted?: { id: string; renamedTo?: string }[];
	/** One sentence each: unmapped files, unpromoted draft records, hand resolutions, code after the last spec work, orphaned evidence. */
	warnings: string[];
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
	const warnings: string[] = [];
	const foreign = Array.isArray(f?.foreign) ? (f.foreign as string[]) : [];
	if (!Array.isArray(f?.foreign)) warnings.push(`the foreign § of this merge could not be computed (${(f?.findings as { message?: string }[] | undefined)?.map((x) => x.message).join("; ") || "no output"}); name them from the spec diff yourself`);
	const deleted = ((Array.isArray(f?.changes) ? f.changes : []) as { id: string; change: string; renamedTo?: string }[])
		.filter((c) => c.change.split("+").includes("deleted"))
		.map((c) => ({ id: c.id, ...(c.renamedTo ? { renamedTo: c.renamedTo } : {}) }));
	const landing: MergeLanding | undefined = Array.isArray(f?.unmappedChanged)
		? { unmappedChanged: f.unmappedChanged, mappedUntouched: f.mappedUntouched ?? [], unpromotedDrafts: f.unpromotedDrafts ?? [], handResolved: f.handResolved ?? [] }
		: undefined;
	if (landing) {
		if (landing.unmappedChanged.length)
			warnings.push(`${landing.unmappedChanged.length} changed file${landing.unmappedChanged.length === 1 ? "" : "s"} no claim maps (${landing.unmappedChanged.map((u) => `${u.path}${u.status === "D" ? " deleted" : ""}`).join(", ")}): spec each one whose change a user sees with a claim listing it in \`code\`, or name it on a line "Plumbing: <path> — <why>" above your last line`);
		for (const d of landing.unpromotedDrafts)
			warnings.push(`draft ${d.draft} has ${d.ids.length} unpromoted record${d.ids.length === 1 ? "" : "s"} (${d.ids.join(", ")}): promote what shipped, or name the § left stale on a line "Deferred: ${d.ids.join(", ")} — <why>" above your last line`);
		for (const h of landing.handResolved)
			warnings.push(`merge ${short(h.commit)} resolved ${h.ids.join(", ")} by hand (it differs from both parents; see git show --cc ${short(h.commit)}): check it says what both sides meant`);
	} else if (Array.isArray(f?.foreign)) warnings.push("the merge's unmapped files and unpromoted drafts could not be computed; check them yourself");
	const drafts = draftsIn(req.path);

	// Evidence commits the merged branch does not contain: a rebase after evidence orphaned them.
	const evidence = new Map<string, string>();
	for (const d of drafts) for (const c of d.evidenceCommits) evidence.set(c, d.name);
	for (const [c, name] of evidence) {
		if ((await git(["merge-base", "--is-ancestor", c, req.branchSha], top)).code !== 0)
			warnings.push(`evidence commit ${short(c)} (draft ${name}) is not on ${req.branch}: a rebase after evidence orphans it; re-record evidence against the commit that landed`);
	}

	// Code committed after the branch's last spec work (a spec commit, or a commit evidence names).
	const commits = (await git(["rev-list", "--reverse", "--no-merges", `${req.before}..${req.branchSha}`], top)).stdout.split("\n").filter(Boolean);
	const kinds: { sha: string; spec: boolean; code: boolean }[] = [];
	for (const sha of commits) {
		const files = (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], top)).stdout.split("\n").filter(Boolean);
		kinds.push({ sha, spec: files.some((p) => p.startsWith(".sova/spec/")) || evidence.has(sha), code: files.some((p) => !p.startsWith(".sova/")) });
	}
	let last = -1;
	kinds.forEach((k, i) => {
		if (k.spec) last = i;
	});
	const after = last < 0 ? [] : kinds.slice(last + 1).filter((k) => k.code && !evidence.has(k.sha));
	if (after.length)
		warnings.push(`${after.length} code commit${after.length === 1 ? "" : "s"} after the last spec commit ${short(kinds[last]!.sha)} (${after.map((k) => short(k.sha)).join(", ")}): spec what they changed, or say they change no behavior`);
	const targetTop = await checkoutOf(git, top, req.after);
	return { foreign, deleted, warnings, ...(landing ? { landing } : {}), ...(targetTop ? { top: targetTop } : {}) };
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

/** Drafts in a worktree and the commits their evidence names; unreadable ones are skipped. */
function draftsIn(root: string): { name: string; evidenceCommits: string[] }[] {
	const dir = join(root, DRAFTS);
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n)).sort();
	} catch {
		return [];
	}
	const out: { name: string; evidenceCommits: string[] }[] = [];
	for (const name of names) {
		try {
			const d = JSON.parse(readFileSync(join(dir, name, "draft.json"), "utf8"));
			const commits = (Array.isArray(d?.evidence) ? d.evidence : []).map((e: { commit?: unknown }) => e?.commit).filter((c: unknown): c is string => typeof c === "string" && /^[0-9a-f]{40,64}$/.test(c));
			out.push({ name, evidenceCommits: [...new Set<string>(commits)] });
		} catch {
			// not a draft
		}
	}
	return out;
}

/**
 * The lines added to the merge note: always the foreign § line, then the deleted § (a rename's new id shown), the
 * § whose code changed under unchanged prose (advisory), then one per warning.
 */
export function specLines(r: MergeSpecReport): string[] {
	const untouched = r.landing?.mappedUntouched ?? [];
	return [
		`Foreign § this merge changes: ${r.foreign.length ? r.foreign.join(", ") : "none"}`,
		...(r.deleted?.length ? [`Deleted § (still foreign): ${r.deleted.map((d) => (d.renamedTo ? `${d.id} → ${d.renamedTo}` : d.id)).join(", ")}`] : []),
		...(untouched.length ? [`Code changed under unchanged §: ${untouched.map((u) => `${u.id} (${u.files.join(", ")})`).join("; ")}: read each; name one on your last line only if its behavior changed`] : []),
		...r.warnings.map((w) => `Spec warning: ${w}`),
	];
}
