/**
 * The user's go-aheads to land a branch at one commit, kept per user outside every repository:
 *
 *   <state root>/landing.json
 *   { "v": 1, "goAheads": [ { branch, commit, session?, at, by, withoutSpecs?, withoutReview?, via?, in?, drafts? } ] }
 *
 * The `worktree` tool's `land` writes one (`by: "owner-chat"`) for the user's word typed in the branch's own chat
 * (read by `typedGoAhead`, never a message another sender sent: `newestUserMessage`). Sova's merge queue reads those
 * records and queues the branch at that commit (server/merge-queue/ingest.ts). `withoutSpecs`: its drafts stay
 * behind; `withoutReview`: no review step; `via`: "open a PR" / "open an MR" typed, so it lands as that request whatever
 * the project's way of landing is. The other `by` values are older records, read so a file holding them
 * stays valid; an older file's `notYet` and `docsEntries` lists are ignored. Every writer holds the file's lock (withLandingLock).
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
/** Who recorded a go-ahead: the user's word typed in the branch's own chat (`worktree land`, "owner-chat"); the other
 *  values are older records' (kept readable). */
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
	/** "land it without its specs": the user agreed its spec drafts stay behind. */
	withoutSpecs?: true;
	/** "land it, skip review": the merge queue lands it without its review step. */
	withoutReview?: true;
	/** "open a PR" / "open an MR": it lands as a GitHub pull request or a GitLab merge request, whatever the project's
	    way of landing is. */
	via?: RequestVia;
	/** The session it was given in, when not the branch's own. */
	in?: string;
	/** The branch's spec drafts as they were at the approval (one hash over the files under each draft's spec/,
	    each draft's own hash, the names), so a later change to them holds the branch. */
	drafts?: DraftsSeen;
}

/** The request the user's words asked for. */
export type RequestVia = "github-pr" | "gitlab-mr";
export const REQUEST_VIAS: readonly RequestVia[] = ["github-pr", "gitlab-mr"];

export interface DraftsSeen {
	hash: string;
	names: string[];
	each?: Record<string, string>;
}

export interface LandingData {
	v: 1;
	goAheads: GoAhead[];
}

/** pi's agent dir as pi resolves it: $PI_CODING_AGENT_DIR (a leading ~ expanded), else ~/.pi/agent. */
function agentDirOf(env: NodeJS.ProcessEnv): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
	return resolve(dir);
}

/** Sova's state root as a chat sees it: the server that started this chat's (`SOVA_CHAT_STATE_ROOT`), else `<agent dir>/sova`. */
export function chatStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.SOVA_CHAT_STATE_ROOT || join(agentDirOf(env), "sova");
}

/** The file: under the state root of the server that started this chat (`SOVA_CHAT_STATE_ROOT`), else `<agent dir>/sova`. */
export function landingFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(chatStateRoot(env), LANDING_FILE_NAME);
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

function cleanGoAhead(v: unknown): GoAhead | null {
	if (!isRec(v) || !str(v.branch) || typeof v.commit !== "string" || !SHA.test(v.commit) || !str(v.at)) return null;
	if (typeof v.by !== "string" || !(GO_AHEAD_BY as readonly string[]).includes(v.by)) return null;
	const drafts = cleanDrafts(v.drafts);
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, by: v.by as GoAheadBy, ...(v.withoutSpecs === true ? { withoutSpecs: true as const } : {}), ...(v.withoutReview === true ? { withoutReview: true as const } : {}), ...(typeof v.via === "string" && (REQUEST_VIAS as readonly string[]).includes(v.via) ? { via: v.via as RequestVia } : {}), ...(str(v.in) ? { in: v.in } : {}), ...(drafts ? { drafts } : {}) };
}

const HEX = /^[0-9a-f]{64}$/;
function cleanDrafts(v: unknown): DraftsSeen | undefined {
	if (!isRec(v) || typeof v.hash !== "string" || !HEX.test(v.hash) || !Array.isArray(v.names) || !v.names.every(str)) return undefined;
	const each = isRec(v.each) && Object.entries(v.each).every(([k, h]) => str(k) && typeof h === "string" && HEX.test(h)) ? (v.each as Record<string, string>) : undefined;
	return { hash: v.hash, names: [...(v.names as string[])], ...(each ? { each: { ...each } } : {}) };
}

export function readLanding(file: string = landingFile()): LandingData {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		// Older files also hold `notYet` and `docsEntries` lists: nothing reads them, and the next write drops them.
		if (!isRec(raw) || raw.v !== 1) return { v: 1, goAheads: [] };
		return { v: 1, goAheads: (Array.isArray(raw.goAheads) ? raw.goAheads : []).map(cleanGoAhead).filter((g): g is GoAhead => !!g) };
	} catch {
		return { v: 1, goAheads: [] };
	}
}

function writeLanding(file: string, data: LandingData): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ v: 1, goAheads: data.goAheads.slice(-LANDING_KEPT) }, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

/** How long a writer waits for the file's lock, and when a lock left behind counts as stale. */
export const LANDING_LOCK_WAIT_MS = 5_000;
export const LANDING_LOCK_STALE_MS = 10_000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Every writer of landing.json (the `worktree` tool in any chat, Sova's tests) holds `<file>.lock`, made with O_EXCL,
 * while it re-reads, merges and replaces the file, so two go-aheads written at once never drop each other. A lock older than LANDING_LOCK_STALE_MS is taken over.
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
		writeLanding(file, d);
	});
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

/** Sova's own messages and other sessions' arrive as user messages too: none of them is the user's typed word (the
 *  merge queue's wakes start "[merge-queue]", an Overseer's brief "[overseer-brief]"). */
const NOT_TYPED = /^\s*(?:sova:|\[from session |\[schedule |\[merge-queue\]|\[overseer-brief\]|go ahead: land )/i;
/** Before the verb: words that make it a question, a condition or a refusal rather than the word to land now. */
const NOT_NOW = /\b(?:don'?t|dont|do not|never|not|no|should|shall|why|what|how|whether|when|once|after|before|until|if|wait|hold)\b/;

/**
 * The user's go-ahead in their own words (§chat.worktrees/tool, `land`): the first line asks to land or merge
 * ("land it", "ok, merge it", "go ahead and land feat/x"), the verb within its first 40 characters and nothing
 * before it that asks, waits or refuses, and "not yet", "don't" or "do not" nowhere in that line. "without
 * specs" anywhere in the message lands it without its specs; "skip review" / "without review" / "no review" lands it
 * without the merge queue's review step. Asking for a request is a go-ahead too ("open a PR", "create an MR", "open a
 * merge request", "land it as a PR"): `via` names it (a pull request on GitHub, a merge request on GitLab), the same
 * rules applying to its verb. → {withoutSpecs, withoutReview, via?} | null (not a go-ahead).
 */
export function typedGoAhead(text: string): { withoutSpecs: boolean; withoutReview: boolean; via?: RequestVia } | null {
	if (typeof text !== "string" || NOT_TYPED.test(text)) return null;
	const line = (text.trim().split("\n")[0] ?? "").toLowerCase();
	const open = OPEN_REQUEST.exec(line);
	const verb = /\b(?:land|merge)\b/.exec(line);
	const at = open && (!verb || open.index <= verb.index) ? open.index : verb?.index;
	if (at === undefined || at > 40 || NOT_NOW.test(line.slice(0, at))) return null;
	if (/\bnot yet\b|\bdon'?t\b|\bdo not\b/.test(line)) return null;
	const asked = (open && open.index === at ? open[1] : undefined) ?? (verb ? AS_REQUEST.exec(line.slice(verb.index))?.[1] : undefined);
	const via: RequestVia | undefined = asked ? (/^(?:pr|pull request)$/.test(asked) ? "github-pr" : "gitlab-mr") : undefined;
	return { withoutSpecs: /\bwithout (?:its |the |any )?specs?\b/i.test(text), withoutReview: /\b(?:skip(?:ping)? (?:the |its )?review|without (?:the |its |a |any )?review|no review)\b/i.test(text), ...(via ? { via } : {}) };
}

/** "open a PR", "create a new merge request", "raise an MR", "put up a pull request": the verb asks for a request. */
const OPEN_REQUEST = /\b(?:open|create|make|raise|submit|file|put up)\s+(?:up\s+)?(?:(?:a|an)\s+)?(?:new\s+)?(pr|pull request|mr|merge request)\b/;
/** "land it as a PR", "merge it as an MR". */
const AS_REQUEST = /\bas\s+(?:a|an)\s+(pr|pull request|mr|merge request)\b/;
