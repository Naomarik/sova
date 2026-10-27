/**
 * The user's answers on a branch's Landing card (§chat.offers/sova-landing; §chat.worktrees/landing-answers):
 * Land It (a go-ahead) or Not Yet for a branch at one commit, the user's go-ahead typed in the branch's own
 * chat (`worktree land`, `by: "owner-chat"`), and Go on a Ready to land row of an Overseer card the user applied
 * (`by: "overseer-card"`, §app.overseer/card-land), kept per user outside every repository:
 *
 *   <state root>/landing.json
 *   { "v": 1, "goAheads": [ { branch, commit, session?, at, by, withoutSpecs?, in? } ], "notYet": [ { branch, commit, session?, at, in? } ] }
 *
 * `in` (optional, additive) is the session the answer was given in, when that isn't the branch's own: the Merge
 * Captain's chat, for a row of its landing card or its driver's `go` (`by: "captain-chat"`).
 *
 * Sova's server writes it (a click on a Landing card, or Go on an Overseer card's land row), and so does the
 * `worktree` tool's `land` (the user's typed word, read by `typedGoAhead`, never a message another sender sent:
 * `newestUserMessage`); the merge round's driver reads it as the user's word.
 * Nothing enforces it: no merge needs a recorded go-ahead.
 *
 * Node builtins only (the extension runs in every chat). Writes re-read the file, merge and replace it
 * atomically; a damaged file reads as no records.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, by: v.by as GoAheadBy, ...(v.withoutSpecs === true ? { withoutSpecs: true as const } : {}), ...(str(v.in) ? { in: v.in } : {}) };
}

function cleanNotYet(v: unknown): NotYet | null {
	if (!isRec(v) || !str(v.branch) || typeof v.commit !== "string" || !SHA.test(v.commit) || !str(v.at)) return null;
	return { branch: v.branch, commit: v.commit, ...(str(v.session) ? { session: v.session } : {}), at: v.at, ...(str(v.in) ? { in: v.in } : {}) };
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
