/**
 * The user's answers on a branch's Landing card (§chat.offers/sova-landing; §chat.worktrees/landing-answers):
 * Land It (a go-ahead) or Not Yet for a branch at one commit, the user's go-ahead typed in the branch's own
 * chat (`worktree land`, `by: "owner-chat"`), and Go on a Ready to land row of an Overseer card the user applied
 * (`by: "overseer-card"`, §app.overseer/card-land), kept per user outside every repository:
 *
 *   <state root>/landing.json
 *   { "v": 1, "goAheads": [ { branch, commit, session?, at, by, withoutSpecs?, in?, drafts? } ], "notYet": [ { branch, commit, session?, at, in? } ],
 *     "docsEntries": [ { branch, sha, parent, at, drafts } ] }
 *
 * `in` (optional, additive) is the session the answer was given in, when that isn't the branch's own: the Merge
 * Captain's chat, for a row of its landing card or its driver's `go` (`by: "captain-chat"`). `drafts` (Land It) is
 * the branch's spec drafts as they were then, so a later change to them holds the branch.
 *
 * Sova's server writes it (a click on a Landing card, or Go on an Overseer card's land row), and so does the
 * `worktree` tool's `land` (the user's typed word, read by `typedGoAhead`, never a message another sender sent:
 * `newestUserMessage`); the merge round's driver reads it as the user's word and appends the docs entries it commits
 * itself, the only spec-only commits a go-ahead carries across. Every writer holds the file's lock (withLandingLock).
 * Nothing enforces it: no merge needs a recorded go-ahead.
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
/** Who recorded a go-ahead: a Land It click, the user's word typed in the branch's own chat (`worktree land`), the
 *  user's word in the Merge Captain's chat (the round driver's `go`), Go on an Overseer card's Ready to land row the
 *  user applied, or (records from before the merge guard was removed) a Merge Branch press. */
export type GoAheadBy = "land-it" | "owner-chat" | "captain-chat" | "overseer-card" | "page";
export const GO_AHEAD_BY: readonly GoAheadBy[] = ["land-it", "owner-chat", "captain-chat", "overseer-card", "page"];

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
	/** The session it was given in, when not the branch's own. */
	in?: string;
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
	/** The session it was given in, when not the branch's own. */
	in?: string;
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
	if (typeof v.by !== "string" || !(GO_AHEAD_BY as readonly string[]).includes(v.by)) return null;
	const drafts = cleanDrafts(v.drafts);
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, by: v.by as GoAheadBy, ...(v.withoutSpecs === true ? { withoutSpecs: true as const } : {}), ...(str(v.in) ? { in: v.in } : {}), ...(drafts ? { drafts } : {}) };
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
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, ...(str(v.in) ? { in: v.in } : {}) };
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
export function answerAt(data: LandingData, branch: string, commit: string): { kind: "go-ahead"; goAhead: GoAhead } | { kind: "not-yet"; notYet: NotYet } | undefined {
	const go = data.goAheads.filter((g) => g.branch === branch && g.commit === commit).at(-1);
	const no = data.notYet.filter((n) => n.branch === branch && n.commit === commit).at(-1);
	if (go && (!no || Date.parse(go.at) > Date.parse(no.at))) return { kind: "go-ahead", goAhead: go };
	return no ? { kind: "not-yet", notYet: no } : undefined;
}

/** The go-ahead for this branch at exactly this commit, if it is the newest answer there (answerAt). */
export function goAheadFor(branch: string, commit: string, file: string = landingFile()): GoAhead | undefined {
	const hit = answerAt(readLanding(file), branch, commit);
	return hit?.kind === "go-ahead" ? hit.goAhead : undefined;
}

/** The invisible markers that name a user message another sender sent (§app.overseer/sent-marker): the Overseer's,
 *  a baton participant's, another session's `session_send`. Spelled again here: the extension imports nothing of Sova. */
export const SENT_MARKERS: Readonly<Record<string, string>> = {
	"sova-overseer-sent": "the Overseer",
	"sova-baton-sent": "a baton participant",
	"sova-session-sent": "another session",
};

/**
 * The newest user message on a session's branch (pi's entries, oldest first): its text, and, when a sent marker
 * names it (§chat.worktrees/land-own-word), who sent it instead of the user. Only the newest counts: an older
 * message is never looked at. → {text: ""} when there is none.
 */
export function newestUserMessage(branch: readonly unknown[]): { text: string; sentBy?: string } {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: unknown; id?: unknown; message?: { role?: unknown; content?: unknown } } | undefined;
		if (e?.type !== "message" || e.message?.role !== "user") continue;
		const c = e.message.content;
		const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("\n") : "";
		// A marker is written after its message: look only past it, toward the leaf.
		for (let j = i + 1; j < branch.length && typeof e.id === "string"; j++) {
			const m = branch[j] as { type?: unknown; customType?: unknown; data?: { targetId?: unknown } } | undefined;
			if (m?.type === "custom" && typeof m.customType === "string" && Object.hasOwn(SENT_MARKERS, m.customType) && m.data?.targetId === e.id) return { text, sentBy: SENT_MARKERS[m.customType] };
		}
		return { text };
	}
	return { text: "" };
}

/** Sova's own messages and other sessions' arrive as user messages too: none of them is the user's typed word. */
const NOT_TYPED = /^\s*(?:sova:|\[from session |\[schedule |go ahead: land )/i;
/** Before the verb: words that make it a question, a condition or a refusal rather than the word to land now. */
const NOT_NOW = /\b(?:don'?t|dont|do not|never|not|no|should|shall|why|what|how|whether|when|once|after|before|until|if|wait|hold)\b/;

/**
 * The user's go-ahead in their own words (§chat.worktrees/tool, `land`): the first line asks to land or merge
 * ("land it", "ok, merge it", "go ahead and land feat/x"), the verb within its first 40 characters and nothing
 * before it that asks, waits or refuses, and "not yet", "don't" or "do not" nowhere in that line. "without
 * specs" anywhere in the message lands it without its specs. → {withoutSpecs} | null (not a go-ahead).
 */
export function typedGoAhead(text: string): { withoutSpecs: boolean } | null {
	if (typeof text !== "string" || NOT_TYPED.test(text)) return null;
	const line = (text.trim().split("\n")[0] ?? "").toLowerCase();
	const verb = /\b(?:land|merge)\b/.exec(line);
	if (!verb || verb.index > 40 || NOT_NOW.test(line.slice(0, verb.index))) return null;
	if (/\bnot yet\b|\bdon'?t\b|\bdo not\b/.test(line)) return null;
	return { withoutSpecs: /\bwithout (?:its |the |any )?specs?\b/i.test(text) };
}
