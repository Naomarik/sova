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
const MAX_DRAFTS = 20;

export interface MergeSpecReport {
	/** § the merge changed that it did not create (the core's `foreign`), sorted. */
	foreign: string[];
	/** One sentence each: unpromoted draft records, code after the last spec work, orphaned evidence. */
	warnings: string[];
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

	const f = json((await node([core, "foreign", "--base", req.before, "--head", req.after, "--root", top, "--json"], top)).stdout);
	const warnings: string[] = [];
	const foreign = Array.isArray(f?.foreign) ? (f.foreign as string[]) : [];
	if (!Array.isArray(f?.foreign)) warnings.push(`the foreign § of this merge could not be computed (${(f?.findings as { message?: string }[] | undefined)?.map((x) => x.message).join("; ") || "no output"}); name them from the spec diff yourself`);

	const drafts = draftsIn(req.path);
	const draftTool = join(coreDir, "sova-spec-draft.mjs");
	for (const d of drafts.slice(0, MAX_DRAFTS)) {
		if (!existsSync(draftTool)) break;
		const s = json((await node([draftTool, "status", d.name, "--root", req.path, "--json"], req.path)).stdout);
		const open = ((s?.ids ?? []) as { id: string; current: string }[]).filter((i) => i.current === "pending" || i.current === "conflict");
		if (open.length) warnings.push(`draft ${d.name} has ${open.length} unpromoted record${open.length === 1 ? "" : "s"} (${open.map((i) => i.id).join(", ")}): promote what shipped, or say why not`);
	}
	if (drafts.length > MAX_DRAFTS) warnings.push(`${drafts.length - MAX_DRAFTS} more drafts in ${DRAFTS} were not checked`);

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
	return { foreign, warnings };
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

/** The lines added to the merge note: always the foreign § line, then one per warning. */
export function specLines(r: MergeSpecReport): string[] {
	return [`Foreign § this merge changes: ${r.foreign.length ? r.foreign.join(", ") : "none"}`, ...r.warnings.map((w) => `Spec warning: ${w}`)];
}
