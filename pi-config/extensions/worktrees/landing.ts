/**
 * Landing go-aheads (§chat/offers, the Landing offer; §chat.worktrees/merge-guard): the user's go-ahead
 * to land a branch at one exact commit, kept per user outside every repository, so a branch can't
 * grant its own:
 *
 *   <state root>/landing.json
 *   { "v": 1, "goAheads": [ { branch, commit, session?, at, by, withoutSpecs? } ], "notYet": [ { branch, commit, session?, at } ] }
 *
 * Sova's server writes it (a Land It click on a Landing card, the operator's own Merge Branch); the
 * merge round's driver and this extension's `worktree merge` read it. A project turns the guard on in
 * its offers file (`"mainMerges": "go-ahead"`), read from the target branch itself, so a branch can't
 * switch it off for its own merge.
 *
 * Node builtins only (the extension runs in every chat). Writes re-read the file, merge and replace it
 * atomically; a damaged file reads as no records.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Git } from "./git.ts";

export const LANDING_FILE_NAME = "landing.json";
/** The offers file's key that turns the guard on, and its one value. */
export const MAIN_MERGES_KEY = "mainMerges";
export const MAIN_MERGES_GO_AHEAD = "go-ahead";
/** The branches the guard covers. */
export const MAIN_BRANCHES = ["main", "master"] as const;
/** Records kept per list, newest last. */
export const LANDING_KEPT = 200;
/** The merge captain's profile id (server/merge-board.ts CAPTAIN_PROFILE). */
export const CAPTAIN_PROFILE = "merge-captain";
/** The session's profile entry (shared/profiles.ts PROFILE_ENTRY). */
export const PROFILE_ENTRY = "sova-profile";

export const LANDING_REFUSAL =
	"This project lands branches on master only with the user's go-ahead for this exact commit. Once the branch is Ready to land, the merge captain queues it and Sova shows its landing card; until then there is no card to press.";

export type GoAheadBy = "land-it" | "page";

export interface GoAhead {
	branch: string;
	/** The full head sha the go-ahead is for. */
	commit: string;
	/** The session whose branch it is. */
	session?: string;
	/** ISO time. */
	at: string;
	by: GoAheadBy;
	/** Merge Without Specs…: the user agreed its spec drafts stay behind. */
	withoutSpecs?: true;
}

export interface NotYet {
	branch: string;
	commit: string;
	session?: string;
	at: string;
}

export interface LandingData {
	v: 1;
	goAheads: GoAhead[];
	notYet: NotYet[];
}

/** pi's agent dir as pi resolves it: $PI_CODING_AGENT_DIR (a leading ~ expanded), else ~/.pi/agent. */
function agentDirOf(env: NodeJS.ProcessEnv): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
	return resolve(dir);
}

/** The file: under the state root of the server that started this chat (`SOVA_CHAT_STATE_ROOT`), else `<agent dir>/sova`. */
export function landingFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.SOVA_CHAT_STATE_ROOT || join(agentDirOf(env), "sova"), LANDING_FILE_NAME);
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

function cleanGoAhead(v: unknown): GoAhead | null {
	if (!isRec(v) || !str(v.branch) || typeof v.commit !== "string" || !SHA.test(v.commit) || !str(v.at)) return null;
	if (v.by !== "land-it" && v.by !== "page") return null;
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, by: v.by, ...(v.withoutSpecs === true ? { withoutSpecs: true as const } : {}) };
}

function cleanNotYet(v: unknown): NotYet | null {
	if (!isRec(v) || !str(v.branch) || typeof v.commit !== "string" || !SHA.test(v.commit) || !str(v.at)) return null;
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at };
}

export function readLanding(file: string = landingFile()): LandingData {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRec(raw) || raw.v !== 1) return { v: 1, goAheads: [], notYet: [] };
		return {
			v: 1,
			goAheads: (Array.isArray(raw.goAheads) ? raw.goAheads : []).map(cleanGoAhead).filter((g): g is GoAhead => !!g),
			notYet: (Array.isArray(raw.notYet) ? raw.notYet : []).map(cleanNotYet).filter((n): n is NotYet => !!n),
		};
	} catch {
		return { v: 1, goAheads: [], notYet: [] };
	}
}

function writeLanding(file: string, data: LandingData): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ v: 1, goAheads: data.goAheads.slice(-LANDING_KEPT), notYet: data.notYet.slice(-LANDING_KEPT) }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/** Record the user's go-ahead for a branch at one commit (a newer one for the same branch and commit replaces it). */
export function recordGoAhead(rec: GoAhead, file: string = landingFile()): void {
	const ok = cleanGoAhead(rec);
	if (!ok) throw new Error("Not a go-ahead: it needs a branch and a full commit sha.");
	const d = readLanding(file);
	d.goAheads = [...d.goAheads.filter((g) => !(g.branch === ok.branch && g.commit === ok.commit)), ok];
	d.notYet = d.notYet.filter((n) => !(n.branch === ok.branch && n.commit === ok.commit));
	writeLanding(file, d);
}

/** Record the user's Not Yet for a branch at one commit. */
export function recordNotYet(rec: NotYet, file: string = landingFile()): void {
	const ok = cleanNotYet(rec);
	if (!ok) throw new Error("Not a Not Yet: it needs a branch and a full commit sha.");
	const d = readLanding(file);
	d.notYet = [...d.notYet.filter((n) => !(n.branch === ok.branch && n.commit === ok.commit)), ok];
	writeLanding(file, d);
}

/** How many clean master merges a go-ahead carries through (§chat.worktrees/merge-guard). */
export const CARRY_MAX = 20;

/** What a go-ahead may carry over: the repository (any checkout of it) and the target branch. */
export interface Carry {
	git: Git;
	cwd: string;
	/** The branch merged in, `master` or `main`. */
	target: string;
}

/**
 * The commit `merge` was made from when it is a clean merge of `target` into it (§chat.worktrees/merge-guard):
 * exactly two parents, the first that commit and the second already on `target`, and its tree exactly
 * the one `git merge-tree --write-tree` makes of those two parents (no conflict, nothing edited by hand).
 * undefined for any other commit, or when git can't tell.
 */
export async function cleanMergeParent(git: Git, cwd: string, merge: string, target: string): Promise<string | undefined> {
	const line = await git(["rev-list", "--parents", "-n", "1", merge], cwd);
	const ids = line.code === 0 ? line.stdout.trim().split(/\s+/) : [];
	if (ids.length !== 3) return undefined;
	const [, first, second] = ids as [string, string, string];
	const onTarget = await git(["merge-base", "--is-ancestor", second, `refs/heads/${target}`], cwd);
	if (onTarget.code !== 0) return undefined;
	const [tree, made] = await Promise.all([git(["rev-parse", "--verify", "-q", `${merge}^{tree}`], cwd), git(["merge-tree", "--write-tree", "--no-messages", first, second], cwd)]);
	if (tree.code !== 0 || made.code !== 0) return undefined;
	const want = tree.stdout.trim();
	return want && made.stdout.split("\n")[0]?.trim() === want ? first : undefined;
}

/**
 * The go-ahead for this branch at this commit, if any (§chat.worktrees/merge-guard). With `carry`, one
 * recorded at an earlier commit counts too when every commit since is a clean merge of the target
 * (cleanMergeParent), up to CARRY_MAX of them: the merge round's own master merge never costs the user's
 * press. The worktree tool, Merge Branch and (through its copy) the merge round all ask this.
 */
export async function goAheadFor(branch: string, commit: string, file: string = landingFile(), carry?: Carry): Promise<GoAhead | undefined> {
	const all = readLanding(file).goAheads.filter((g) => g.branch === branch);
	const at = (sha: string) => all.filter((g) => g.commit === sha).at(-1);
	let sha = commit;
	for (let i = 0; ; i++) {
		const hit = at(sha);
		if (hit) return hit;
		if (!carry || i >= CARRY_MAX || !all.length) return undefined;
		const parent = await cleanMergeParent(carry.git, carry.cwd, sha, carry.target).catch(() => undefined);
		if (!parent) return undefined;
		sha = parent;
	}
}

/** Whether the project's offers file, as the target branch holds it, turns the guard on. Pure. */
export function mainMergesOn(offersText: string | null): boolean {
	if (offersText === null) return false;
	try {
		const raw = JSON.parse(offersText) as unknown;
		return isRec(raw) && raw[MAIN_MERGES_KEY] === MAIN_MERGES_GO_AHEAD;
	} catch {
		return false;
	}
}

/** The offers file as `target` holds it, read through git (never the working tree a branch could edit); null when none. */
export async function offersOnTarget(git: Git, cwd: string, target: string): Promise<string | null> {
	const r = await git(["show", `refs/heads/${target}:.sova/offers.json`], cwd);
	return r.code === 0 ? r.stdout : null;
}

/** Whether a merge into `target` needs the user's go-ahead: a main branch of a project that turned the guard on. */
export async function mergeNeedsGoAhead(git: Git, cwd: string, target: string): Promise<boolean> {
	if (!(MAIN_BRANCHES as readonly string[]).includes(target)) return false;
	return mainMergesOn(await offersOnTarget(git, cwd, target));
}

/** The session's profile id from its branch's newest `sova-profile` entry (null: Default or none). */
export function profileIdOf(branch: readonly unknown[]): string | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (!isRec(e) || e.type !== "custom" || e.customType !== PROFILE_ENTRY) continue;
		const data = e.data;
		if (!isRec(data)) return null;
		const p = data.profile;
		return isRec(p) && typeof p.id === "string" ? p.id : null;
	}
	return null;
}
