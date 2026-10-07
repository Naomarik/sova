/**
 * What a merge leaves to do in the project's spec (`.sova/spec/`), for the merge note the model reads: warnings it
 * can act on, from the spec core's landing lists (`sova-spec.mjs foreign --landing`) and the drafts' evidence. It
 * only reads: git by argument list (the extension's `Git`) and the sibling spec tools run with node, never a shell.
 * A project without a spec, or an install without the spec tools, gets nothing. Node builtins only.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
	/** The target is the repo's default branch: the landing's own drafts are promoted now. */
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
			const what = !own ? `its session promotes ${them}` : req.onDefault ? `this landed on the default branch, so promote ${them} now` : "promote what shipped";
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

	// Evidence commits the merged branch does not contain: a rebase after evidence orphaned them.
	const evidence = new Map<string, string>();
	for (const d of draftsIn(req.path)) for (const c of d.evidenceCommits) evidence.set(c, d.name);
	for (const [c, name] of evidence) {
		if ((await git(["merge-base", "--is-ancestor", c, req.branchSha], top)).code !== 0)
			warnings.push({ text: `evidence commit ${short(c)} (draft ${name}) is not on ${req.branch}: a rebase after evidence orphans it; re-record evidence against the commit that landed` });
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
