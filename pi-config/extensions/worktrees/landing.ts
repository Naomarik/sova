/**
 * The user's answers on a branch's Landing card (§chat.offers/sova-landing; §chat.worktrees/landing-answers):
 * Land It (a go-ahead) or Not Yet for a branch at one commit, kept per user outside every repository:
 *
 *   <state root>/landing.json
 *   { "v": 1, "goAheads": [ { branch, commit, session?, at, by, withoutSpecs?, drafts? } ], "notYet": [ { branch, commit, session?, at } ],
 *     "docsEntries": [ { branch, sha, parent, at, drafts } ] }
 *
 * Sova's server writes the answers (a click on a Landing card; a Land It keeps the spec drafts as they were then);
 * the merge round's driver reads them as the user's word and appends the docs entries it commits itself, the only
 * spec-only commits a go-ahead carries across. Nothing enforces it: no merge needs a recorded go-ahead.
 *
 * Node builtins only (the extension runs in every chat). Writes re-read the file, merge and replace it
 * atomically; a damaged file reads as no records.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LANDING_FILE_NAME = "landing.json";
/** Records kept per list, newest last. */
export const LANDING_KEPT = 200;
/** Who recorded a go-ahead: a Land It click, or (records from before the merge guard was removed) a Merge Branch press. */
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
	/** Land It: the branch's spec drafts as they were at the click (one hash over the files under each draft's spec/,
	    each draft's own hash, the names), so a later change to them holds the branch. */
	drafts?: DraftsSeen;
}

export interface DraftsSeen {
	hash: string;
	names: string[];
	each?: Record<string, string>;
}

/** A docs commit the merge round made on a branch at its landing, and the one parent it was made on. */
export interface DocsEntry {
	branch: string;
	sha: string;
	parent: string;
	at: string;
	drafts: string[];
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
	docsEntries?: DocsEntry[];
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
	const drafts = cleanDrafts(v.drafts);
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, by: v.by, ...(v.withoutSpecs === true ? { withoutSpecs: true as const } : {}), ...(drafts ? { drafts } : {}) };
}

const HEX = /^[0-9a-f]{64}$/;
function cleanDrafts(v: unknown): DraftsSeen | undefined {
	if (!isRec(v) || typeof v.hash !== "string" || !HEX.test(v.hash) || !Array.isArray(v.names) || !v.names.every(str)) return undefined;
	const each = isRec(v.each) && Object.entries(v.each).every(([k, h]) => str(k) && typeof h === "string" && HEX.test(h)) ? (v.each as Record<string, string>) : undefined;
	return { hash: v.hash, names: [...(v.names as string[])], ...(each ? { each: { ...each } } : {}) };
}

function cleanDocsEntry(v: unknown): DocsEntry | null {
	if (!isRec(v) || !str(v.branch) || typeof v.sha !== "string" || !SHA.test(v.sha) || typeof v.parent !== "string" || !SHA.test(v.parent) || !str(v.at)) return null;
	return { branch: v.branch, sha: v.sha, parent: v.parent, at: v.at, drafts: Array.isArray(v.drafts) ? v.drafts.filter(str) : [] };
}

function cleanNotYet(v: unknown): NotYet | null {
	if (!isRec(v) || !str(v.branch) || typeof v.commit !== "string" || !SHA.test(v.commit) || !str(v.at)) return null;
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at };
}

export function readLanding(file: string = landingFile()): LandingData {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRec(raw) || raw.v !== 1) return { v: 1, goAheads: [], notYet: [] };
		const docsEntries = (Array.isArray(raw.docsEntries) ? raw.docsEntries : []).map(cleanDocsEntry).filter((e): e is DocsEntry => !!e);
		return {
			v: 1,
			goAheads: (Array.isArray(raw.goAheads) ? raw.goAheads : []).map(cleanGoAhead).filter((g): g is GoAhead => !!g),
			notYet: (Array.isArray(raw.notYet) ? raw.notYet : []).map(cleanNotYet).filter((n): n is NotYet => !!n),
			...(docsEntries.length ? { docsEntries } : {}),
		};
	} catch {
		return { v: 1, goAheads: [], notYet: [] };
	}
}

function writeLanding(file: string, data: LandingData): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	// The round's docs entries are kept as read: an answer written here never drops one.
	const docs = data.docsEntries?.length ? { docsEntries: data.docsEntries.slice(-LANDING_KEPT) } : {};
	writeFileSync(tmp, `${JSON.stringify({ v: 1, goAheads: data.goAheads.slice(-LANDING_KEPT), notYet: data.notYet.slice(-LANDING_KEPT), ...docs }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/** How long a writer waits for the file's lock, and when a lock left behind counts as stale. */
export const LANDING_LOCK_WAIT_MS = 5_000;
export const LANDING_LOCK_STALE_MS = 10_000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Every writer of landing.json (Sova's server here, the merge round's driver, round.mjs withLandingLock, the same
 * protocol) holds `<file>.lock`, made with O_EXCL, while it re-reads, merges and replaces the file, so a go-ahead and
 * the round's docs entry written at once never drop each other. A lock older than LANDING_LOCK_STALE_MS is taken over.
 */
export function withLandingLock<T>(file: string, fn: () => T): T {
	mkdirSync(dirname(file), { recursive: true });
	const lock = `${file}.lock`;
	const end = Date.now() + LANDING_LOCK_WAIT_MS;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LANDING_LOCK_STALE_MS) {
					unlinkSync(lock);
					continue;
				}
			} catch {
				continue; // gone meanwhile: try again
			}
			if (Date.now() > end) throw new Error(`${LANDING_FILE_NAME} stayed locked for ${LANDING_LOCK_WAIT_MS / 1000} s (${lock}).`);
			pause(10);
		}
	}
	try {
		return fn();
	} finally {
		try {
			unlinkSync(lock);
		} catch {}
	}
}

/** Record the user's go-ahead for a branch at one commit (a newer one for the same branch and commit replaces it). */
export function recordGoAhead(rec: GoAhead, file: string = landingFile()): void {
	const ok = cleanGoAhead(rec);
	if (!ok) throw new Error("Not a go-ahead: it needs a branch and a full commit sha.");
	withLandingLock(file, () => {
		const d = readLanding(file);
		d.goAheads = [...d.goAheads.filter((g) => !(g.branch === ok.branch && g.commit === ok.commit)), ok];
		d.notYet = d.notYet.filter((n) => !(n.branch === ok.branch && n.commit === ok.commit));
		writeLanding(file, d);
	});
}

/** Record the user's Not Yet for a branch at one commit. */
export function recordNotYet(rec: NotYet, file: string = landingFile()): void {
	const ok = cleanNotYet(rec);
	if (!ok) throw new Error("Not a Not Yet: it needs a branch and a full commit sha.");
	withLandingLock(file, () => {
		const d = readLanding(file);
		d.notYet = [...d.notYet.filter((n) => !(n.branch === ok.branch && n.commit === ok.commit)), ok];
		writeLanding(file, d);
	});
}

/**
 * The user's newest answer for this branch at exactly this commit: a go-ahead, or Not Yet. Both may be recorded
 * at one commit (Not Yet doesn't clear a go-ahead); the later `at` wins, and Not Yet wins a tie or a time that
 * can't be read. The merge round's driver keeps a copy (round.mjs landingAnswer), held equal by a test.
 */
export function answerAt(data: LandingData, branch: string, commit: string): { kind: "go-ahead"; goAhead: GoAhead } | { kind: "not-yet" } | undefined {
	const go = data.goAheads.filter((g) => g.branch === branch && g.commit === commit).at(-1);
	const no = data.notYet.filter((n) => n.branch === branch && n.commit === commit).at(-1);
	if (go && (!no || Date.parse(go.at) > Date.parse(no.at))) return { kind: "go-ahead", goAhead: go };
	return no ? { kind: "not-yet" } : undefined;
}

/** The go-ahead for this branch at exactly this commit, if it is the newest answer there (answerAt). */
export function goAheadFor(branch: string, commit: string, file: string = landingFile()): GoAhead | undefined {
	const hit = answerAt(readLanding(file), branch, commit);
	return hit?.kind === "go-ahead" ? hit.goAhead : undefined;
}
