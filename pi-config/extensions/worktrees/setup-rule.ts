/**
 * What makes a branch a setup branch: one whose changes reach the project's pipeline, the sections of
 * `.sova/project.json` the merge queue, releases and deploys act on (`merge`, `release`, `deploy`; a service only when a
 * merge check requires it), or the files of the project's release playbook folder.
 *
 * The one home of the rule. Sova's merge queue imports it for its land gate and trials; the `worktree` tool asks it
 * before a plain merge (a setup branch is merged only from its Setup card, after a passing trial). Read from Git alone,
 * at the two commits, never a worktree's files.
 *
 * Node builtins only (the extension runs in every chat) and nothing of Sova.
 */

/** Git by argv, as both callers run it; never throws (a failure is a nonzero code). */
export type SetupGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The project definition, at the repo's root. */
export const SETUP_CONTRACT_FILE = ".sova/project.json";
/** The definition's sections a setup branch changes. */
export const PIPELINE_SECTIONS = ["merge", "release", "deploy"] as const;
/** The release playbook folder when the definition names none. */
export const DEFAULT_RELEASE_PLAYBOOK = ".sova/playbooks/release";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A value's text with its keys sorted, so two equal sections compare equal. Pure. */
export function stable(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v && typeof v === "object")
		return `{${Object.keys(v as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(v ?? null);
}

/** The definition's raw JSON at a commit; null when absent or not JSON. */
async function rawAt(git: SetupGit, root: string, commit: string): Promise<Record<string, unknown> | null> {
	const r = await git(["show", `${commit}:${SETUP_CONTRACT_FILE}`], root);
	if (r.code !== 0) return null;
	try {
		return obj(JSON.parse(r.stdout));
	} catch {
		return null;
	}
}

/** The services a definition's merge checks require (its `merge.checks[].requires`). Pure. */
export function requiredServices(def: Record<string, unknown> | null): Set<string> {
	const checks = obj(def?.merge).checks;
	const out = new Set<string>();
	if (Array.isArray(checks)) for (const c of checks) for (const r of Array.isArray(obj(c).requires) ? (obj(c).requires as unknown[]) : []) if (typeof r === "string") out.add(r);
	return out;
}

/** The services added, removed or edited between two raw definitions, by name. Pure. */
export function changedServices(base: Record<string, unknown> | null, head: Record<string, unknown> | null): string[] {
	// Services are a list of {name, …} or a map keyed by name.
	const byName = (d: Record<string, unknown> | null): Map<string, string> => {
		const v = d?.services;
		if (Array.isArray(v)) return new Map(v.map((s) => [String(obj(s).name ?? ""), stable(s)] as const));
		return new Map(Object.entries(obj(v)).map(([n, s]) => [n, stable(s)] as const));
	};
	const a = byName(base);
	const b = byName(head);
	return [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n));
}

/**
 * Which pipeline sections differ between two raw definitions (absent counts as its own value). `services` counts only
 * when a service a merge check requires (on either side) was added, removed or edited: the others are conformance's. Pure.
 */
export function changedSections(base: Record<string, unknown> | null, head: Record<string, unknown> | null): string[] {
	const out: string[] = PIPELINE_SECTIONS.filter((k) => stable(base?.[k]) !== stable(head?.[k]));
	const required = new Set([...requiredServices(base), ...requiredServices(head)]);
	if (changedServices(base, head).some((n) => required.has(n))) out.unshift("services");
	return out;
}

/** The release playbook folders a change could touch: the one each side names, else the default. Pure. */
export function releaseFolders(base: Record<string, unknown> | null, head: Record<string, unknown> | null): string[] {
	const named = [obj(base?.release).playbook, obj(head?.release).playbook].filter((p): p is string => typeof p === "string" && !!p.trim());
	return [...new Set([...named.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, "")), DEFAULT_RELEASE_PLAYBOOK])];
}

/** What makes a branch a setup branch: the sections it changes and the release playbook files; empty when it isn't one. */
export interface SetupChange {
	sections: string[];
	files: string[];
}

/** The setup change between `base` (the target's head, or the merge base) and `head`; null when Git can't tell. */
export async function setupChangeOf(git: SetupGit, root: string, base: string, head: string): Promise<SetupChange | null> {
	const mb = await git(["merge-base", base, head], root);
	const from = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
	const diff = await git(["diff", "--name-only", "--no-renames", from, head], root);
	if (diff.code !== 0) return null;
	const paths = diff.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (!paths.length) return { sections: [], files: [] };
	const [a, b] = paths.includes(SETUP_CONTRACT_FILE) ? await Promise.all([rawAt(git, root, from), rawAt(git, root, head)]) : [null, null];
	const sections = paths.includes(SETUP_CONTRACT_FILE) ? changedSections(a, b) : [];
	const folders = releaseFolders(a, b);
	const files = paths.filter((p) => folders.some((f) => p === f || p.startsWith(`${f}/`)));
	return { sections, files };
}

export const isSetupChange = (c: SetupChange | null): boolean => !!c && (c.sections.length > 0 || c.files.length > 0);
