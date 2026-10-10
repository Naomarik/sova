/**
 * The align minor mode's alignments: the document shape, the `align` tool's operations (validated
 * and applied atomically), the fold of the tool results' snapshots along a branch, derived status,
 * and every text the model or a renderer reads (the tool's echo, the hidden per-prompt note, the
 * change line, markdown). Also the read-only legacy `align-doc` entries of older sessions, and the
 * viewer's scroll math.
 *
 * Node builtins only, and none of pi's runtime: Sova's server imports this file for the same fold
 * (server/align-state.ts), so both sides read one shape. Nothing here throws on odd stored data;
 * the tool's input errors throw AlignError with a sentence the model can act on.
 */

/** The tool's name, in the loadout and on every tool result. */
export const ALIGN_TOOL = "align";
/** customType of an older session's alignment entry (a parsed markdown block, before the tool). Read-only. */
export const ALIGN_ENTRY_TYPE = "align-doc";
/** Key for `ctx.ui.setWidget`. */
export const ALIGN_WIDGET_KEY = "mode-align";
/** customType of the hidden note on each user prompt listing the open alignments. */
export const ALIGN_STATE_MESSAGE = "align-state";
/** customType of the hidden nudge a settling run gets when it planned in prose. */
export const ALIGN_NUDGE_MESSAGE = "align-nudge";
/** What the settle nudge tells the agent (hidden from the transcript). */
export const ALIGN_NUDGE_TEXT =
	"[align] Your last reply reads like a plan or asks the user to decide, and nothing was recorded with the align tool this run. Record it now: align create (or ops on the open alignment), each question with its recommendation, then reply with one short sentence pointing at it. If it isn't a design decision (a status report, a merge or run confirmation), call align exempt with a reason and stop.";
/** Version of the tool result's `details`. */
export const ALIGN_DETAILS_VERSION = 1;

// ── The document ─────────────────────────────────────────────────────────────

export interface AlignText {
	id: string;
	text: string;
}

export interface AlignRejected {
	id: string;
	option: string;
	why: string;
}

export interface AlignOption {
	label: string;
	tradeoff: string;
}

export interface AlignRecommendation {
	choice: string;
	why: string;
}

export interface AlignDecision {
	text: string;
	by: "user" | "accepted-recommendation";
	/** ISO timestamp. */
	at: string;
}

export interface AlignQuestion {
	id: string;
	topic: string;
	ask: string;
	context?: string;
	options?: AlignOption[];
	recommendation: AlignRecommendation;
	decision?: AlignDecision;
	dropped?: { why: string; at: string };
	/** A drawing on the card (§chat.alignment/visuals), only in a session started with Visuals on. */
	visual?: AlignVisual;
}

/** A `vis` drawing: its kind and its source, exactly what a `vis` fence would hold. */
export interface AlignVisual {
	kind: string;
	source: string;
}

/** At most this many visuals per alignment, its questions' and its own together. */
export const ALIGN_VISUALS_MAX = 3;

/** The non-Default writing styles a document records (align-settings.ts AlignStyle; Default is no field). */
export type AlignDocStyle = "simplified" | "pm";

/** Adversarial review (behind the mode extension's `adversarial-review` flag): its two phases. */
export type AlignReviewPhase = "plan" | "diff";
export const ALIGN_REVIEW_PHASES: readonly AlignReviewPhase[] = ["plan", "diff"];
export type AlignReviewState = "skipped" | "running" | "clear" | "blocking" | "incomplete";
export const ALIGN_REVIEW_STATES: readonly AlignReviewState[] = ["skipped", "running", "clear", "blocking", "incomplete"];
/** The verdicts a running review ends in. */
export const ALIGN_REVIEW_VERDICTS = ["clear", "blocking", "incomplete"] as const;
export type AlignBlockerClose = "check" | "evidence" | "waiver";
export const ALIGN_BLOCKER_CLOSES: readonly AlignBlockerClose[] = ["check", "evidence", "waiver"];

/** One blocking finding of a review: `bN` within its entry, never reused. */
export interface AlignBlocker {
	id: string;
	/** One line: what fails. */
	title: string;
	/** The discriminating check that fails now and passes once fixed. */
	check: string;
	/** How it closed: its check passing, counter-evidence, or the user's waiver in their words. */
	closed?: { by: AlignBlockerClose; evidence: string; at: string };
}

/** One phase's entry: its state, a one-line reason, who reviewed, and the blockers it found. */
export interface AlignReviewEntry {
	state: AlignReviewState;
	reason: string;
	/** "backend · model · effort" of the reviewer, once one was chosen. */
	model?: string;
	/** ISO timestamp of the last change. */
	at: string;
	/** Present only when the review found any. */
	blockers?: AlignBlocker[];
}

/** The per-alignment review record: at most one plan and one diff review. */
export interface AlignReview {
	plan?: AlignReviewEntry;
	diff?: AlignReviewEntry;
}

/** The stored lifecycle: only the moves no data can show. Status is derived from it and the questions. */
export type AlignPhase = "open" | "implementing" | "done" | "dropped";
export type AlignStatus = "aligning" | "confirmed" | "implementing" | "done" | "dropped";
export type AlignQuestionState = "open" | "decided" | "dropped";

export interface AlignDocument {
	/** `al_N`. */
	id: string;
	title: string;
	/** One line: what the concern is about. */
	summary: string;
	findings: AlignText[];
	approach: AlignText[];
	rejected: AlignRejected[];
	/**
	 * Technical notes (tN): the technical detail a plan written for a reader who doesn't read code keeps
	 * out of its other fields (§chat.alignment/style). Absent until the first one is added.
	 */
	technical?: AlignText[];
	questions: AlignQuestion[];
	phase: AlignPhase;
	/** Why the whole document was dropped (phase "dropped"). */
	droppedWhy?: string;
	/** The last number used per item kind: ids are never reused, removed or not. `t` from the first technical note. */
	next: { f: number; a: number; x: number; q: number; t?: number };
	/** 1 at create, +1 per changing call. */
	rev: number;
	/** The adversarial review record; absent until a review op ran (and always with the flag off). */
	review?: AlignReview;
	/** The writing style in effect at the document's latest change; absent for Default. */
	style?: AlignDocStyle;
	/** The document's own drawing (§chat.alignment/visuals). */
	visual?: AlignVisual;
	createdAt: string;
	updatedAt: string;
}

export type AlignChange =
	/** fromFile: an import (the stored name predates the op). */
	| { kind: "created"; fromFile?: true }
	| { kind: "added"; ids: string[] }
	/** ids: item ids, or "title"/"summary" for the document's own fields. */
	| { kind: "edited"; ids: string[] }
	| { kind: "removed"; ids: string[] }
	| { kind: "decided"; q: string }
	| { kind: "accepted"; qs: string[] }
	| { kind: "reopened"; q: string }
	| { kind: "question-dropped"; q: string }
	| { kind: "status"; to: "implementing" | "done" | "open" }
	| { kind: "dropped" }
	| { kind: "review"; phase: AlignReviewPhase; state: AlignReviewState }
	| { kind: "blocker-closed"; phase: AlignReviewPhase; id: string };

/**
 * The tool result's `details`: the authoritative record. `doc` is the touched document's full
 * snapshot after the call (absent for a read-only call or an exemption); `changes` and `line` say
 * what the call did, for the card's revision rows and the TUI.
 */
export interface AlignDetails {
	v: 1;
	doc?: AlignDocument;
	changes: AlignChange[];
	/** changeLine(changes): "q3 decided · +q11"; "" when nothing changed. */
	line: string;
	exempt?: { why: string };
}

export function alignStatus(doc: AlignDocument): AlignStatus {
	if (doc.phase === "dropped" || doc.phase === "done" || doc.phase === "implementing") return doc.phase;
	const live = doc.questions.filter((q) => !q.dropped);
	if (live.length === 0 || live.some((q) => !q.decision)) return "aligning";
	return "confirmed";
}

export function questionState(q: AlignQuestion): AlignQuestionState {
	if (q.dropped) return "dropped";
	return q.decision ? "decided" : "open";
}

/** An option's letter, "a" for the first: the user answers "q3 option a" as "3a". Past z, its number. */
export const optionLetter = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : String(i + 1));

const bareLabel = (s: string): string => s.replaceAll("**", "").trim().toLowerCase();

/**
 * The option the recommendation names, by index: its choice equals an option's label (trimmed,
 * case-insensitive, bold markers ignored), else starts with one followed by a non-word character,
 * the longest such label winning. undefined when it names none. Sova's card uses the same rule
 * (src/lib/align.ts `recommendedOption`).
 */
export function recommendedOption(q: Pick<AlignQuestion, "options" | "recommendation">): number | undefined {
	const labels = (q.options ?? []).map((o) => bareLabel(o.label));
	const choice = bareLabel(q.recommendation.choice);
	if (choice === "") return undefined;
	const exact = labels.indexOf(choice);
	if (exact >= 0) return exact;
	let best = -1;
	labels.forEach((l, i) => {
		if (l === "" || !choice.startsWith(l) || /[\p{L}\p{N}_]/u.test(choice.charAt(l.length))) return;
		if (best < 0 || l.length > labels[best]!.length) best = i;
	});
	return best >= 0 ? best : undefined;
}

/** The recommendation's short form: "b — Parquet" when it names option b, else its choice. */
export function recommendedText(q: AlignQuestion): string {
	const i = recommendedOption(q);
	return i === undefined ? q.recommendation.choice : `${optionLetter(i)} — ${q.options![i]!.label}`;
}

export const isTerminal = (doc: AlignDocument): boolean => doc.phase === "done" || doc.phase === "dropped";
export const openQuestionsOf = (doc: AlignDocument): AlignQuestion[] => doc.questions.filter((q) => questionState(q) === "open");
/** Questions that still count: every one not dropped. */
export const liveQuestionsOf = (doc: AlignDocument): AlignQuestion[] => doc.questions.filter((q) => !q.dropped);
export const openDocsOf = (docs: readonly AlignDocument[]): AlignDocument[] => docs.filter((doc) => !isTerminal(doc));

/** Across the open (non-terminal) documents: how many, their open questions, and all their live questions. */
export function alignCounts(docs: readonly AlignDocument[]): { docs: number; open: number; total: number } {
	const open = openDocsOf(docs);
	return {
		docs: open.length,
		open: open.reduce((n, doc) => n + openQuestionsOf(doc).length, 0),
		total: open.reduce((n, doc) => n + liveQuestionsOf(doc).length, 0),
	};
}

/** Every blocker of the record not closed yet, with its phase. */
export function openBlockersOf(doc: Pick<AlignDocument, "review">): { phase: AlignReviewPhase; blocker: AlignBlocker }[] {
	const out: { phase: AlignReviewPhase; blocker: AlignBlocker }[] = [];
	for (const phase of ALIGN_REVIEW_PHASES) for (const blocker of doc.review?.[phase]?.blockers ?? []) if (!blocker.closed) out.push({ phase, blocker });
	return out;
}

/** The phases whose review is running now. */
export const runningReviewsOf = (doc: Pick<AlignDocument, "review">): AlignReviewPhase[] => ALIGN_REVIEW_PHASES.filter((phase) => doc.review?.[phase]?.state === "running");

/**
 * A phase as the user reads it: "Plan" or "Implementation". `diff` stays the id (ops, record,
 * messages); the user decides about the implementation, the diff is only what the reviewer reads.
 * Sova's card has the same helper (src/lib/align-review.ts).
 */
export const reviewPhaseName = (phase: AlignReviewPhase): string => (phase === "plan" ? "Plan" : "Implementation");

/**
 * The message the card's Review Plan / Review Implementation button and the TUI's
 * `/review` send: an ordinary user message the session acts on with the review op, its phase
 * token always the id. Sova's card composes the same text (src/lib/align-review.ts; both tests pin it).
 */
export const reviewRequestMessage = (doc: string, phase: AlignReviewPhase): string =>
	`${doc}: run the adversarial ${reviewPhaseName(phase).toLowerCase()} review now (align review, phase ${phase}), whatever the rule says.`;

/** A phase is used once it ran in any way; a skip leaves it usable. */
export const reviewUsed = (entry: AlignReviewEntry | undefined): boolean => entry !== undefined && entry.state !== "skipped";

// ── Errors and input validation ──────────────────────────────────────────────

/** A call the model can fix: the message says what was wrong and where. */
export class AlignError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AlignError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function need(ok: boolean, message: string): asserts ok {
	if (!ok) throw new AlignError(message);
}

/**
 * Field names models reach for (from pi's edit tool, the op's older shape, or another op), and the
 * ones meant, in order of preference: the hint names the first one this op takes.
 */
const MEANT: Record<string, readonly string[]> = {
	newText: ["text"],
	new_text: ["text"],
	replacement: ["text"],
	answer: ["decision"],
	question: ["ask"],
	why: ["reason"],
	reason: ["why"],
	file: ["path"],
	fromFile: ["path"],
	filePath: ["path"],
	file_path: ["path"],
	id: ["q"],
	ids: ["qs"],
	q: ["qs"],
	status: ["to"],
};

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) continue;
		const meant = MEANT[key]?.find((k) => allowed.includes(k));
		need(allowed.includes(key), `${where}: unknown field "${key}"${meant ? ` (did you mean "${meant}"?)` : ""} (allowed: ${allowed.join(", ")})`);
	}
}

function text(value: unknown, where: string): string {
	need(typeof value === "string" && value.trim() !== "", `${where} must be a non-empty string`);
	return (value as string).trim();
}

function list<T>(value: unknown, where: string, item: (v: unknown, where: string) => T): T[] {
	need(Array.isArray(value), `${where} must be an array`);
	return (value as unknown[]).map((v, i) => item(v, `${where}[${i}]`));
}

function option(value: unknown, where: string): AlignOption {
	need(isRecord(value), `${where} must be an object {label, tradeoff}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["label", "tradeoff"], where);
	return { label: text(v.label, `${where}.label`), tradeoff: text(v.tradeoff, `${where}.tradeoff`) };
}

function recommendation(value: unknown, where: string): AlignRecommendation {
	need(isRecord(value), `${where} must be an object {choice, why}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["choice", "why"], where);
	return { choice: text(v.choice, `${where}.choice`), why: text(v.why, `${where}.why`) };
}

/** A question as a create or add supplies it: no id, no decision. */
export interface AlignQuestionInput {
	topic: string;
	ask: string;
	context?: string;
	options?: AlignOption[];
	recommendation: AlignRecommendation;
	visual?: AlignVisual;
}

function questionInput(value: unknown, where: string, visuals = false): AlignQuestionInput {
	need(isRecord(value), `${where} must be an object {topic, ask, context?, options?, recommendation${visuals ? ", visual?" : ""}}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["topic", "ask", "context", "options", "recommendation", ...(visuals ? ["visual"] : [])], where);
	const q: AlignQuestionInput = {
		topic: text(v.topic, `${where}.topic`),
		ask: text(v.ask, `${where}.ask`),
		recommendation: recommendation(v.recommendation, `${where}.recommendation`),
	};
	if (v.context !== undefined) q.context = text(v.context, `${where}.context`);
	if (v.options !== undefined) {
		const options = list(v.options, `${where}.options`, option);
		if (options.length > 0) q.options = options;
	}
	if (v.visual !== undefined) q.visual = visualInput(v.visual, `${where}.visual`);
	return q;
}

/** A visual as an op gives it: a kind word and its source, both non-empty. */
function visualInput(value: unknown, where: string): AlignVisual {
	need(isRecord(value), `${where} must be an object {kind, source}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["kind", "source"], where);
	const kind = text(v.kind, `${where}.kind`);
	need(/^[a-z]+$/.test(kind), `${where}.kind must be one vis kind word, e.g. "wireframe" (call vis_guide for the kinds)`);
	need(typeof v.source === "string" && v.source.trim() !== "", `${where}.source must be the drawing's source, non-empty`);
	const source = unfencedVisSource(v.source as string);
	need(source.trim() !== "", `${where}.source must be the drawing's source, non-empty`);
	return { kind, source: source.replace(/\s+$/, "") };
}

/**
 * A source written as a whole `vis` fence (its ```vis <kind> line and closing fence around the body, as a
 * planning worker writing a file tends to) is the body inside it; any other source is as given.
 */
export function unfencedVisSource(source: string): string {
	const m = /^\s*(`{3,}|~{3,})[ \t]*vis(?:[ \t]+[a-z]+)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*\s*$/.exec(source);
	return m ? m[2]! : source;
}

function rejectedInput(value: unknown, where: string): { option: string; why: string } {
	need(isRecord(value), `${where} must be an object {option, why}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["option", "why"], where);
	return { option: text(v.option, `${where}.option`), why: text(v.why, `${where}.why`) };
}

/** What a create supplies (inline), or the JSON file an import names. */
export interface AlignDocInput {
	title: string;
	summary: string;
	findings: string[];
	approach: string[];
	rejected: { option: string; why: string }[];
	technical: string[];
	questions: AlignQuestionInput[];
	visual?: AlignVisual;
}

/** The fields an import's file holds (create takes them too, and `visual` with Visuals on). */
export const DOC_INPUT_KEYS = ["title", "summary", "findings", "approach", "rejected", "technical", "questions"] as const;

/**
 * Strict: every field typed, nothing unknown. `where` prefixes each message ("import /tmp/x.json").
 * `visuals`: the document's and the questions' `visual` are taken too (create, or an import's file,
 * in a session started with Visuals on).
 */
export function parseDocInput(value: unknown, where: string, visuals = false): AlignDocInput {
	const keys: readonly string[] = visuals ? [...DOC_INPUT_KEYS, "visual"] : DOC_INPUT_KEYS;
	need(isRecord(value), `${where} must be a JSON object with ${keys.join(", ")}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, keys, where);
	const doc: AlignDocInput = {
		title: oneLine(text(v.title, `${where}: title`)),
		summary: oneLine(text(v.summary, `${where}: summary`)),
		findings: v.findings === undefined ? [] : list(v.findings, `${where}: findings`, text),
		approach: v.approach === undefined ? [] : list(v.approach, `${where}: approach`, text),
		rejected: v.rejected === undefined ? [] : list(v.rejected, `${where}: rejected`, rejectedInput),
		technical: v.technical === undefined ? [] : list(v.technical, `${where}: technical`, text),
		questions: v.questions === undefined ? [] : list(v.questions, `${where}: questions`, (q, at) => questionInput(q, at, visuals)),
	};
	if (v.visual !== undefined) doc.visual = visualInput(v.visual, `${where}: visual`);
	return doc;
}

/**
 * The JSON a planning worker writes for `import`: said once, for the tool's schema and the prompts. With
 * Visuals on (§chat.alignment/visuals) the document and each question may carry a `visual`, as create takes it.
 */
export function alignFileSchema(visuals = false): string {
	const visual = visuals ? `, "visual"?: {"kind": string, "source": string}` : "";
	return `{"title": string, "summary": string (one line), "findings"?: [string], "approach"?: [string, in order], "rejected"?: [{"option": string, "why": string}], "technical"?: [string (a technical note)], "questions"?: [{"topic": string, "ask": string, "context"?: string, "options"?: [{"label": string, "tradeoff": string}], "recommendation": {"choice": string, "why": string}${visual}}]${visual}}`;
}
export const ALIGN_FILE_SCHEMA = alignFileSchema();

// ── Operations ───────────────────────────────────────────────────────────────

export const ALIGN_OPS = [
	"create",
	"import",
	"add",
	"edit",
	"edit_question",
	"edit_rejected",
	"edit_doc",
	"remove",
	"decide",
	"accept",
	"accept_all",
	"reopen",
	"drop_question",
	"drop_alignment",
	"status",
	"exempt",
	"get",
] as const;
/** The adversarial review's ops: accepted, and in the schema, only with the `adversarial-review` flag on. */
export const ALIGN_REVIEW_OPS = ["review", "close_blocker"] as const;
export type AlignOpName = (typeof ALIGN_OPS)[number] | (typeof ALIGN_REVIEW_OPS)[number];

/**
 * Each op's fields: `required` must be present, `optional` may be; nothing else is taken. `atLeast`:
 * the op needs this many of its optional fields. align-tool.ts builds the JSON schema's branch per
 * op from the same table, so the schema and this check can't disagree (smoke.mjs pins it).
 */
export const ALIGN_OP_FIELDS: Record<AlignOpName, { required: readonly string[]; optional: readonly string[]; atLeast?: number }> = {
	create: { required: ["title", "summary"], optional: ["findings", "approach", "rejected", "technical", "questions"] },
	import: { required: ["path"], optional: [] },
	add: { required: [], optional: ["findings", "approach", "rejected", "technical", "questions"], atLeast: 1 },
	edit: { required: ["id", "text"], optional: [] },
	edit_question: { required: ["q"], optional: ["topic", "ask", "context", "options", "recommendation"], atLeast: 1 },
	edit_rejected: { required: ["id"], optional: ["option", "why"], atLeast: 1 },
	edit_doc: { required: [], optional: ["title", "summary"], atLeast: 1 },
	remove: { required: ["ids"], optional: [] },
	decide: { required: ["q", "decision"], optional: [] },
	accept: { required: ["qs"], optional: [] },
	accept_all: { required: [], optional: [] },
	reopen: { required: ["q"], optional: [] },
	drop_question: { required: ["q", "reason"], optional: [] },
	drop_alignment: { required: ["reason"], optional: [] },
	status: { required: ["to"], optional: [] },
	exempt: { required: ["reason"], optional: [] },
	get: { required: [], optional: [] },
	review: { required: ["phase", "state", "reason"], optional: ["model", "blockers"] },
	close_blocker: { required: ["phase", "id", "by", "evidence"], optional: [] },
};

/**
 * The ops' extra fields in a session started with Visuals on (§chat.alignment/visuals): in the schema and
 * accepted only then. A question's `visual` (in create's and add's questions) follows the same switch.
 */
export const ALIGN_VISUAL_FIELDS: Partial<Record<AlignOpName, readonly string[]>> = {
	create: ["visual"],
	edit_question: ["visual"],
	edit_doc: ["visual"],
};

/** Op names models reach for, and what to use instead. */
const OP_MEANT: Record<string, string> = {
	delete: 'use {op: "remove", ids: [...]} for findings, steps and rejected alternatives, or drop_question for a question',
	add_question: 'use {op: "add", questions: [...]}',
	add_questions: 'use {op: "add", questions: [...]}',
	drop: 'use drop_question {q, reason} for one question, or drop_alignment {reason} for the whole alignment',
	create_from_file: 'use {op: "import", path}',
	accept_open: 'use {op: "accept_all"}',
};

/**
 * An op that is one of the older shapes (or a near miss) gets a message naming the op meant, before
 * the generic field check would only list the allowed fields.
 */
function opShapeHint(o: Record<string, unknown>): string | undefined {
	switch (o.op) {
		case "create":
			if (o.fromFile !== undefined || o.path !== undefined) return 'a file is imported with {op: "import", path: "/absolute/path.json"}, never create';
			return undefined;
		case "edit": {
			const id = typeof o.id === "string" ? o.id : undefined;
			if (id === undefined && (o.title !== undefined || o.summary !== undefined)) return 'the title and summary are changed with {op: "edit_doc", title?, summary?}';
			if (id !== undefined && itemKind(id) === "q") return `a question is changed with {op: "edit_question", q: "${id}", topic?, ask?, context?, options?, recommendation?}`;
			if (id !== undefined && itemKind(id) === "x") return `a rejected alternative is changed with {op: "edit_rejected", id: "${id}", option?, why?}`;
			return undefined;
		}
		case "accept":
			if (o.q === "open" || (Array.isArray(o.q) && o.q.length === 1 && o.q[0] === "open")) return 'every open question is accepted with {op: "accept_all"}; accept takes qs: ["q1", ...]';
			return undefined;
		default:
			return undefined;
	}
}

export interface AlignEnv {
	/** ISO timestamp stamped on decisions, drops and the document. */
	now: string;
	/** Reads an import's file (an absolute path). */
	readFile(path: string): string;
	/** Present only with the `adversarial-review` flag on: the review ops and guards apply. */
	review?: AlignReviewEnv;
	/** The session started with Visuals on: the visual fields are taken (ALIGN_VISUAL_FIELDS). */
	visuals?: boolean;
	/** The writing style now; a changing call records it on the document (absent or "default": no field). */
	style?: "default" | AlignDocStyle;
}

/** A worker tuple as the reviewer route names it. */
export interface AlignWorker {
	backend: string;
	model: string;
	effort: string;
}

/** The chat's reviewer as routed now (primary, else its fallback, else nobody). */
export interface AlignReviewerSlot {
	/** The worker to spawn, or null: neither can run. */
	use: AlignWorker | null;
	via: "primary" | "fallback" | "none";
	/** While on the primary: the fallback that may be tried once if the spawn fails, else null. */
	retry: AlignWorker | null;
	/** Why it is off its primary (fallback or none). */
	reason?: string;
}

export interface AlignReviewEnv {
	/** The chat's reviewer now; null when its subagent profile names none (Reviewer: None). */
	reviewer(): AlignReviewerSlot | null;
	/** What a started review's result says beyond the echo: the worker to spawn and the filled prompt. */
	startText(doc: AlignDocument, phase: AlignReviewPhase, slot: AlignReviewerSlot): string;
}

export const workerLine = (w: AlignWorker): string => `${w.backend} · ${w.model} · ${w.effort}`;

export interface AlignOutcome {
	details: AlignDetails;
	/** The tool result's text: the compact echo, plus markdown for `get`. */
	text: string;
}

const DOC_ID = /^al_(\d+)$/;

/** The next `al_N` on this branch: one past the highest seen. */
export function nextDocId(docs: readonly AlignDocument[]): string {
	let max = 0;
	for (const doc of docs) {
		const m = DOC_ID.exec(doc.id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `al_${max + 1}`;
}

function itemKind(id: string): "f" | "a" | "x" | "q" | "t" | undefined {
	const m = /^([faxqt])[1-9]\d*$/.exec(id);
	return m ? (m[1] as "f" | "a" | "x" | "q" | "t") : undefined;
}

function freshDoc(id: string, input: AlignDocInput, now: string): AlignDocument {
	const doc: AlignDocument = {
		id,
		title: input.title,
		summary: input.summary,
		findings: [],
		approach: [],
		rejected: [],
		questions: [],
		phase: "open",
		next: { f: 0, a: 0, x: 0, q: 0 },
		rev: 1,
		createdAt: now,
		updatedAt: now,
	};
	addItems(doc, input);
	if (input.visual) doc.visual = input.visual;
	return doc;
}

/** Append items with fresh ids; returns the ids, in order. */
function addItems(doc: AlignDocument, input: Pick<AlignDocInput, "findings" | "approach" | "rejected" | "technical" | "questions">): string[] {
	const ids: string[] = [];
	for (const t of input.findings) {
		const id = `f${++doc.next.f}`;
		doc.findings.push({ id, text: t });
		ids.push(id);
	}
	for (const t of input.approach) {
		const id = `a${++doc.next.a}`;
		doc.approach.push({ id, text: t });
		ids.push(id);
	}
	for (const r of input.rejected) {
		const id = `x${++doc.next.x}`;
		doc.rejected.push({ id, option: r.option, why: r.why });
		ids.push(id);
	}
	for (const t of input.technical) {
		const id = `t${(doc.next.t = (doc.next.t ?? 0) + 1)}`;
		(doc.technical ??= []).push({ id, text: t });
		ids.push(id);
	}
	for (const q of input.questions) {
		const id = `q${++doc.next.q}`;
		doc.questions.push({ id, ...q });
		ids.push(id);
	}
	return ids;
}

/** How many visuals a document carries, its questions' and its own. */
const visualCount = (doc: AlignDocument): number => doc.questions.filter((q) => q.visual).length + (doc.visual ? 1 : 0);

function findQuestion(doc: AlignDocument, id: unknown, where: string): AlignQuestion {
	need(typeof id === "string" && itemKind(id) === "q", `${where}: q must be a question id like "q3"`);
	const q = doc.questions.find((x) => x.id === id);
	need(q !== undefined, `${where}: ${doc.id} has no question ${id} (it has ${doc.questions.map((x) => x.id).join(", ") || "none"})`);
	return q!;
}

function docList(docs: readonly AlignDocument[]): string {
	return docs.map((doc) => `${doc.id} "${doc.title}"`).join(", ");
}

/** A question id must be one ("q3"), never a list or "open". `where` names the field. */
function questionIdOf(value: unknown, where: string): string {
	need(typeof value === "string" && itemKind(value) === "q", `${where} must be one question id like "q3"`);
	return value as string;
}

/** The call's shape and each op's fields; the first problem throws. */
function checkedOps(input: unknown, allowed: readonly string[], visuals = false): (Record<string, unknown> & { op: AlignOpName })[] {
	// A bare op, or a list of them, without the wrapper: the one mistake the schema's shape invites.
	if (Array.isArray(input) || (isRecord(input) && typeof input.op === "string" && input.ops === undefined)) {
		throw new AlignError('wrap ops in {ops: [...]}: align takes {doc?, ops: [{op: ...}, ...]}');
	}
	need(isRecord(input), "align takes {doc?, ops: [...]}");
	const params = input as Record<string, unknown>;
	onlyKeys(params, ["doc", "ops"], "align");
	need(Array.isArray(params.ops) && params.ops.length > 0, "ops must be a non-empty array of operations");
	return (params.ops as unknown[]).map((op, i) => {
		need(isRecord(op), `ops[${i}] must be an object with an "op" field`);
		const o = op as Record<string, unknown>;
		if (typeof o.op === "string" && !allowed.includes(o.op) && OP_MEANT[o.op] !== undefined) {
			throw new AlignError(`ops[${i}].op "${o.op}" is not an op: ${OP_MEANT[o.op]}`);
		}
		need(typeof o.op === "string" && allowed.includes(o.op), `ops[${i}].op must be one of ${allowed.join(", ")}`);
		const where = `ops[${i}] (${o.op})`;
		const hint = opShapeHint(o);
		if (hint !== undefined) throw new AlignError(`${where}: ${hint}`);
		const fields = ALIGN_OP_FIELDS[o.op as AlignOpName];
		const visualFields = visuals ? (ALIGN_VISUAL_FIELDS[o.op as AlignOpName] ?? []) : [];
		onlyKeys(o, ["op", ...fields.required, ...fields.optional, ...visualFields], where);
		for (const key of fields.required) need(o[key] !== undefined, `${where}: ${key} is required`);
		if (fields.atLeast !== undefined) {
			const optional = [...fields.optional, ...visualFields];
			need(optional.filter((k) => o[k] !== undefined).length >= fields.atLeast, `${where}: give at least one of ${optional.join(", ")}`);
		}
		return o as Record<string, unknown> & { op: AlignOpName };
	});
}

/**
 * Apply one tool call to the branch's documents, atomically: every op is validated before
 * anything is kept, and the first problem throws AlignError. Pure apart from `env.readFile`.
 */
export function applyAlignCall(docs: readonly AlignDocument[], input: unknown, env: AlignEnv): AlignOutcome {
	const visuals = env.visuals === true;
	const ops = checkedOps(input, env.review ? [...ALIGN_OPS, ...ALIGN_REVIEW_OPS] : ALIGN_OPS, visuals);
	const params = input as Record<string, unknown>;
	/** Text a started review adds to the result (the worker and the filled prompt). */
	const extra: string[] = [];

	// An exemption touches no document and stands alone.
	if (ops.some((o) => o.op === "exempt")) {
		need(ops.length === 1, "exempt stands alone in its call");
		const reason = oneLine(text(ops[0]!.reason, "ops[0] (exempt): reason"));
		return {
			details: { v: 1, changes: [], line: "", exempt: { why: reason } },
			text: [`Recorded: no alignment needed — ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`, ...otherDocsLine(docs, undefined)].join("\n"),
		};
	}

	const starts = ops.filter((o) => o.op === "create" || o.op === "import").length;
	const first = ops[0]!.op;
	need(starts === 0 || (starts === 1 && (first === "create" || first === "import")), "create or import must be the first op, once per call");
	const creates = starts === 1;
	const onlyGets = ops.every((o) => o.op === "get");

	let doc: AlignDocument | undefined;
	const changes: AlignChange[] = [];
	if (creates) {
		const o = ops[0]!;
		let parsed: AlignDocInput;
		if (o.op === "import") {
			const path = text(o.path, "ops[0] (import): path");
			need(path.startsWith("/") || path.startsWith("~/"), `ops[0] (import): path must be absolute (e.g. "/tmp/align-plan.json"), not "${path}"`);
			let raw: string;
			try {
				raw = env.readFile(path);
			} catch (error) {
				throw new AlignError(`import ${path}: cannot read it (${error instanceof Error ? error.message : String(error)})`);
			}
			let json: unknown;
			try {
				json = JSON.parse(raw);
			} catch (error) {
				// Only where it broke, never the parser's quote of the file's first bytes: the path may
				// have been pointed at something that isn't an alignment at all.
				const at = /position (\d+)/.exec(error instanceof Error ? error.message : "")?.[1];
				throw new AlignError(`import ${path}: not valid JSON${at ? ` (near position ${at})` : ""}`);
			}
			parsed = parseDocInput(json, `import ${path}`, visuals);
		} else {
			parsed = parseDocInput(Object.fromEntries([...DOC_INPUT_KEYS, ...(visuals ? ["visual"] : [])].map((k) => [k, o[k]])), "ops[0] (create)", visuals);
		}
		doc = freshDoc(nextDocId(docs), parsed, env.now);
		changes.push(o.op === "import" ? { kind: "created", fromFile: true } : { kind: "created" });
	} else {
		const open = openDocsOf(docs);
		if (params.doc !== undefined) {
			const id = text(params.doc, "doc");
			const found = docs.find((d) => d.id === id);
			need(found !== undefined, `No alignment ${id} on this branch${docs.length ? ` (there are ${docList(docs)})` : ""}`);
			doc = structuredClone(found!);
		} else if (open.length === 1) {
			doc = structuredClone(open[0]!);
		} else if (!onlyGets) {
			need(open.length > 0, "No open alignment to change: create one first");
			throw new AlignError(`Name the alignment: doc is required while several are open (${docList(open)})`);
		}
	}

	const gets: AlignDocument[] = [];
	for (let i = creates ? 1 : 0; i < ops.length; i++) {
		const o = ops[i]!;
		const where = `ops[${i}] (${o.op})`;
		if (o.op === "get") continue;
		const d = doc!;
		// A late diff review may run on a done alignment (the card's Review Implementation after a skip).
		const lateReview = o.op === "review" && o.phase === "diff" && d.phase === "done";
		if (isTerminal(d) && !(o.op === "status" && o.to === "open") && !lateReview) {
			throw new AlignError(`${where}: ${d.id} is ${d.phase}; move it back with {op: "status", to: "open"} first`);
		}
		switch (o.op) {
			case "add": {
				const ids = addItems(d, {
					findings: o.findings === undefined ? [] : list(o.findings, `${where}: findings`, text),
					approach: o.approach === undefined ? [] : list(o.approach, `${where}: approach`, text),
					rejected: o.rejected === undefined ? [] : list(o.rejected, `${where}: rejected`, rejectedInput),
					technical: o.technical === undefined ? [] : list(o.technical, `${where}: technical`, text),
					questions: o.questions === undefined ? [] : list(o.questions, `${where}: questions`, (q, at) => questionInput(q, at, visuals)),
				});
				need(ids.length > 0, `${where}: nothing to add (every list is empty)`);
				changes.push({ kind: "added", ids });
				break;
			}
			case "edit": {
				const id = text(o.id, `${where}: id`);
				const kind = itemKind(id);
				need(kind === "f" || kind === "a" || kind === "t", `${where}: id must be a finding (fN), an approach step (aN) or a technical note (tN); questions take edit_question, rejected alternatives edit_rejected, the title and summary edit_doc`);
				const item = (kind === "f" ? d.findings : kind === "a" ? d.approach : (d.technical ?? [])).find((x) => x.id === id);
				need(item !== undefined, `${where}: ${d.id} has no ${id}`);
				item!.text = text(o.text, `${where}: text`);
				changes.push({ kind: "edited", ids: [id] });
				break;
			}
			case "edit_question":
				changes.push({ kind: "edited", ids: [editQuestion(d, o, where, visuals)] });
				break;
			case "edit_rejected": {
				const id = text(o.id, `${where}: id`);
				need(itemKind(id) === "x", `${where}: id must be a rejected alternative like "x1"`);
				const item = d.rejected.find((x) => x.id === id);
				need(item !== undefined, `${where}: ${d.id} has no ${id}`);
				if (o.option !== undefined) item!.option = text(o.option, `${where}: option`);
				if (o.why !== undefined) item!.why = text(o.why, `${where}: why`);
				changes.push({ kind: "edited", ids: [id] });
				break;
			}
			case "edit_doc": {
				const ids: string[] = [];
				if (o.title !== undefined) {
					d.title = oneLine(text(o.title, `${where}: title`));
					ids.push("title");
				}
				if (o.summary !== undefined) {
					d.summary = oneLine(text(o.summary, `${where}: summary`));
					ids.push("summary");
				}
				if (visuals && o.visual !== undefined) {
					// null removes it.
					if (o.visual === null) delete d.visual;
					else d.visual = visualInput(o.visual, `${where}: visual`);
					ids.push("visual");
				}
				changes.push({ kind: "edited", ids });
				break;
			}
			case "remove": {
				const ids = list(o.ids, `${where}: ids`, text);
				need(ids.length > 0, `${where}: ids must name at least one item`);
				for (const id of ids) {
					const kind = itemKind(id);
					need(kind === "f" || kind === "a" || kind === "x" || kind === "t", `${where}: ${id} can't be removed (findings fN, approach aN, rejected xN and technical notes tN only; a question takes drop_question)`);
					const key = kind === "f" ? "findings" : kind === "a" ? "approach" : kind === "x" ? "rejected" : "technical";
					const items: readonly { id: string }[] = d[key] ?? [];
					const kept = items.filter((item) => item.id !== id);
					need(kept.length < items.length, `${where}: ${d.id} has no ${id}`);
					(d as unknown as Record<string, { id: string }[]>)[key] = kept;
				}
				changes.push({ kind: "removed", ids });
				break;
			}
			case "decide": {
				const q = findQuestion(d, questionIdOf(o.q, `${where}: q`), where);
				need(!q.dropped, `${where}: ${q.id} is dropped; reopen it first`);
				q.decision = { text: oneLine(text(o.decision, `${where}: decision`)), by: "user", at: env.now };
				changes.push({ kind: "decided", q: q.id });
				break;
			}
			case "accept":
			case "accept_all": {
				let targets: AlignQuestion[];
				if (o.op === "accept_all") {
					targets = openQuestionsOf(d);
					need(targets.length > 0, `${where}: ${d.id} has no open questions to accept`);
				} else {
					const ids = list(o.qs, `${where}: qs`, questionIdOf);
					need(ids.length > 0, `${where}: qs must name at least one question`);
					targets = ids.map((id) => findQuestion(d, id, where));
					for (const q of targets) need(!q.dropped, `${where}: ${q.id} is dropped; reopen it first`);
				}
				// Naming a question twice is one mistake, not two acceptances; naming a decided one would
				// replace the user's own answer with the recommendation, silently.
				const dup = targets.find((q, i) => targets.indexOf(q) !== i);
				need(dup === undefined, `${where}: ${dup?.id} is named twice`);
				for (const q of targets) need(!q.decision, `${where}: ${q.id} is already decided ("${q.decision?.text}"); reopen it first to replace that`);
				for (const q of targets) q.decision = { text: q.recommendation.choice, by: "accepted-recommendation", at: env.now };
				changes.push({ kind: "accepted", qs: targets.map((q) => q.id) });
				break;
			}
			case "reopen": {
				const q = findQuestion(d, questionIdOf(o.q, `${where}: q`), where);
				need(q.decision !== undefined || q.dropped !== undefined, `${where}: ${q.id} is already open`);
				delete q.decision;
				delete q.dropped;
				changes.push({ kind: "reopened", q: q.id });
				break;
			}
			case "drop_question": {
				const q = findQuestion(d, questionIdOf(o.q, `${where}: q`), where);
				const reason = oneLine(text(o.reason, `${where}: reason`));
				need(!q.dropped, `${where}: ${q.id} is already dropped`);
				delete q.decision;
				q.dropped = { why: reason, at: env.now };
				changes.push({ kind: "question-dropped", q: q.id });
				break;
			}
			case "drop_alignment":
				d.phase = "dropped";
				d.droppedWhy = oneLine(text(o.reason, `${where}: reason`));
				changes.push({ kind: "dropped" });
				break;
			case "status": {
				const to = o.to;
				need(to === "implementing" || to === "done" || to === "open", `${where}: to must be implementing, done or open`);
				if (to !== "open") {
					const open = openQuestionsOf(d);
					need(
						open.length === 0,
						`${where}: ${d.id} still has ${open.length} open question${open.length === 1 ? "" : "s"} (${open.map((q) => q.id).join(", ")}): only once the user has answered ${open.length === 1 ? "it" : "them"} (decide), taken your recommendation (accept) or it no longer applies (drop_question), earlier in the same call`,
					);
				}
				if (env.review && to === "implementing") {
					need(d.review?.plan?.state !== "running", `${where}: ${d.id}'s plan review is running: record its verdict (review, phase plan) before implementing`);
				}
				if (env.review && to === "done") {
					const running = runningReviewsOf(d);
					need(running.length === 0, `${where}: ${d.id}'s ${running.join(" and ")} review is running: record its verdict (review) before done`);
					const open = openBlockersOf(d);
					need(
						open.length === 0,
						`${where}: ${d.id} still has ${open.length} open blocker${open.length === 1 ? "" : "s"} (${open.map((b) => `${b.phase} ${b.blocker.id}`).join(", ")}): close each with close_blocker — its check passing, concrete counter-evidence, or the user's explicit waiver in their words — before done`,
					);
				}
				const phase: AlignPhase = to;
				need(d.phase !== phase, `${where}: ${d.id} is already ${to === "open" ? "open" : to}`);
				d.phase = phase;
				delete d.droppedWhy;
				changes.push({ kind: "status", to });
				break;
			}
			case "review":
				applyReview(d, o, where, env, changes, extra);
				break;
			case "close_blocker":
				closeBlocker(d, o, where, env, changes);
				break;
		}
	}
	if (ops.some((o) => o.op === "get")) {
		if (doc) gets.push(doc);
		else gets.push(...openDocsOf(docs));
	}

	const changed = changes.length > 0;
	if (doc && changed) {
		const n = visualCount(doc);
		need(n <= ALIGN_VISUALS_MAX, `${doc.id} would carry ${n} visuals: at most ${ALIGN_VISUALS_MAX} per alignment (its questions' and its own); remove one with edit_question or edit_doc {visual: null}`);
		// The style in effect at the document's latest change (§chat.alignment/document); Default is no field.
		if (env.style !== undefined && env.style !== "default") doc.style = env.style;
		else if (env.style === "default") delete doc.style;
	}
	if (doc && changed && !creates) {
		doc.rev += 1;
		doc.updatedAt = env.now;
	}
	// A start without a drawing in a Visuals chat: said at the moment it can still be added (§chat.alignment/visuals).
	if (doc && creates && visuals && visualCount(doc) === 0) {
		extra.push(`${doc.id} has no visual. Visuals are on: if a question is about a screen, or the change is a flow, draw it now with edit_question {q, visual} or edit_doc {visual}, before you reply.`);
	}
	const after = doc && changed ? upsert(docs, doc) : docs;
	const details: AlignDetails = { v: 1, changes, line: changeLine(changes) };
	if (doc && changed) details.doc = doc;
	const lines = doc ? echoLines(after, doc.id, changed ? details.line : "") : [gets.length === 0 ? "No open alignments on this branch." : ""];
	if (!doc) lines.push(...otherDocsLine(after, undefined));
	const body = gets.length > 0 ? `\n\n${gets.map(toMarkdown).join("\n\n---\n\n")}` : "";
	const more = extra.length > 0 ? `\n\n${extra.join("\n\n")}` : "";
	return { details, text: `${lines.filter((l) => l !== "").join("\n")}${body}${more}`.trim() };
}

function reviewPhaseOf(value: unknown, where: string): AlignReviewPhase {
	need(value === "plan" || value === "diff", `${where}: phase must be plan or diff`);
	return value as AlignReviewPhase;
}

function blockerInput(value: unknown, where: string): { title: string; check: string } {
	need(isRecord(value), `${where} must be an object {title, check}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["title", "check"], where);
	return { title: oneLine(text(v.title, `${where}.title`)), check: oneLine(text(v.check, `${where}.check`)) };
}

/**
 * The review op: start a phase (reserving its slot before the reviewer spawns), skip it, or record
 * a running phase's verdict. A used phase (any state but skipped) never starts again.
 */
function applyReview(d: AlignDocument, o: Record<string, unknown>, where: string, env: AlignEnv, changes: AlignChange[], extra: string[]): void {
	const review = env.review!;
	const phase = reviewPhaseOf(o.phase, `${where}: phase`);
	const state = o.state;
	need(typeof state === "string" && (ALIGN_REVIEW_STATES as readonly string[]).includes(state), `${where}: state must be one of ${ALIGN_REVIEW_STATES.join(", ")}`);
	const reason = oneLine(text(o.reason, `${where}: reason`));
	const entry = d.review?.[phase];
	const record = (next: AlignReviewEntry) => {
		d.review = { ...(d.review ?? {}), [phase]: next };
		changes.push({ kind: "review", phase, state: next.state });
	};
	const model = o.model === undefined ? undefined : oneLine(text(o.model, `${where}: model`));
	if (state !== "blocking") need(o.blockers === undefined, `${where}: only a blocking verdict takes blockers`);
	switch (state as AlignReviewState) {
		case "running": {
			need(!reviewUsed(entry), `${where}: ${d.id}'s ${phase} review already ran (${entry?.state}); there is no second round`);
			need(o.model === undefined, `${where}: model is set from the chat's reviewer route at start; pass it with the verdict if the fallback ran`);
			if (phase === "plan") need(d.phase === "open", `${where}: the plan phase is over (${d.id} is ${d.phase}); review the diff instead`);
			else need(d.phase === "implementing" || d.phase === "done", `${where}: the diff is reviewed while implementing (or after done); ${d.id} is ${alignStatus(d)}`);
			const slot = review.reviewer();
			need(slot !== null, `${where}: this chat's subagent profile names no reviewer (Reviewer: None); record {op: "review", phase: "${phase}", state: "skipped", reason: "no reviewer configured"} instead`);
			if (slot!.use === null) {
				record({ state: "incomplete", reason: `no reviewer can run: ${slot!.reason ?? "primary and fallback unavailable"}`, at: env.now });
				extra.push(`The ${phase} review is INCOMPLETE: no reviewer can run (${slot!.reason ?? "primary and fallback unavailable"}). Do not ask the user for a model; continue the work and say in your report that the ${phase} review could not run.`);
				return;
			}
			record({ state: "running", reason, model: workerLine(slot!.use!), at: env.now });
			extra.push(review.startText(d, phase, slot!));
			return;
		}
		case "skipped":
			need(!reviewUsed(entry), `${where}: ${d.id}'s ${phase} review already ran (${entry?.state}); a skip can't replace it`);
			need(o.model === undefined, `${where}: a skip names no model`);
			record({ state: "skipped", reason, at: env.now });
			return;
		default: {
			need(entry?.state === "running", `${where}: ${d.id}'s ${phase} review is ${entry ? entry.state : "not started"}; a verdict is recorded only for a running review (review, state running, first)`);
			let blockers: AlignBlocker[] | undefined;
			if (state === "blocking" && o.blockers !== undefined) {
				const input = list(o.blockers, `${where}: blockers`, blockerInput);
				if (input.length > 0) blockers = input.map((b, i) => ({ id: `b${i + 1}`, title: b.title, check: b.check }));
			}
			if (state === "blocking" && phase === "diff") need(blockers !== undefined, `${where}: a blocking diff verdict needs its blockers [{title, check}], each with the check that fails now`);
			const next: AlignReviewEntry = { state: state as AlignReviewState, reason, at: env.now };
			const who = model ?? entry!.model;
			if (who !== undefined) next.model = who;
			if (blockers) next.blockers = blockers;
			record(next);
			// A late blocker reopens a done alignment: the fixes are implementation work again.
			if (state === "blocking" && d.phase === "done") {
				d.phase = "implementing";
				changes.push({ kind: "status", to: "implementing" });
			}
		}
	}
}

/** close_blocker: one open blocker, closed by its passing check, counter-evidence, or the user's waiver. */
function closeBlocker(d: AlignDocument, o: Record<string, unknown>, where: string, env: AlignEnv, changes: AlignChange[]): void {
	const phase = reviewPhaseOf(o.phase, `${where}: phase`);
	const id = text(o.id, `${where}: id`);
	const by = o.by;
	need(typeof by === "string" && (ALIGN_BLOCKER_CLOSES as readonly string[]).includes(by), `${where}: by must be check (its check passes now), evidence (concrete counter-evidence) or waiver (the user's explicit words)`);
	const evidence = oneLine(text(o.evidence, `${where}: evidence`));
	const entry = d.review?.[phase];
	const blocker = entry?.blockers?.find((b) => b.id === id);
	need(blocker !== undefined, `${where}: ${d.id}'s ${phase} review has no blocker ${id}${entry?.blockers?.length ? ` (it has ${entry.blockers.map((b) => b.id).join(", ")})` : ""}`);
	need(!blocker!.closed, `${where}: ${phase} ${id} is already closed (${blocker!.closed?.by})`);
	const blockers = entry!.blockers!.map((b) => (b.id === id ? { ...b, closed: { by: by as AlignBlockerClose, evidence, at: env.now } } : b));
	d.review = { ...d.review, [phase]: { ...entry!, blockers, at: env.now } };
	changes.push({ kind: "blocker-closed", phase, id });
}

function editQuestion(d: AlignDocument, o: Record<string, unknown>, where: string, visuals = false): string {
	const q = findQuestion(d, questionIdOf(o.q, `${where}: q`), where);
	if (o.topic !== undefined) q.topic = text(o.topic, `${where}: topic`);
	if (o.ask !== undefined) q.ask = text(o.ask, `${where}: ask`);
	if (o.context !== undefined) {
		// "" clears it.
		need(typeof o.context === "string", `${where}: context must be a string ("" clears it)`);
		if ((o.context as string).trim() === "") delete q.context;
		else q.context = (o.context as string).trim();
	}
	if (o.options !== undefined) {
		const options = list(o.options, `${where}: options`, option);
		if (options.length === 0) delete q.options;
		else q.options = options;
	}
	if (o.recommendation !== undefined) q.recommendation = recommendation(o.recommendation, `${where}: recommendation`);
	if (visuals && o.visual !== undefined) {
		// null removes it.
		if (o.visual === null) delete q.visual;
		else q.visual = visualInput(o.visual, `${where}: visual`);
	}
	return q.id;
}

/** The documents with `doc` replaced (or added), moved to the end: the fold's touch order. */
function upsert(docs: readonly AlignDocument[], doc: AlignDocument): AlignDocument[] {
	return [...docs.filter((d) => d.id !== doc.id), doc];
}

// ── Fold ─────────────────────────────────────────────────────────────────────

export interface AlignFold {
	/** Every document on the branch, newest snapshot per id, in the order they were last touched. */
	docs: AlignDocument[];
	/** An older session's newest `align-doc` entry on the branch, read-only; null when none (or cleared). */
	legacy: LegacyAlignDoc | null;
}

type EntryLike = { type?: unknown; customType?: unknown; data?: unknown; message?: unknown };

/** The align tool result of a session entry, when it is one: its details, normalized, else undefined. */
export function alignResultOf(entry: unknown): AlignDetails | undefined {
	if (!isRecord(entry) || entry.type !== "message") return undefined;
	const m = entry.message;
	if (!isRecord(m) || m.role !== "toolResult" || m.toolName !== ALIGN_TOOL || m.isError === true) return undefined;
	return normalizeAlignDetails(m.details);
}

/**
 * The state of a branch (root first): each document's newest valid snapshot. A failed call (an
 * error result) and malformed details are never state. Never throws.
 */
export function foldAlignments(entries: readonly unknown[]): AlignFold {
	const docs = new Map<string, AlignDocument>();
	let legacy: LegacyAlignDoc | null = null;
	if (!Array.isArray(entries)) return { docs: [], legacy };
	for (const entry of entries) {
		const details = alignResultOf(entry);
		if (details?.doc) {
			docs.delete(details.doc.id);
			docs.set(details.doc.id, details.doc);
			continue;
		}
		const e = entry as EntryLike;
		if (isRecord(e) && e.type === "custom" && e.customType === ALIGN_ENTRY_TYPE) {
			const data = normalizeAlignEntry(e.data);
			if (data) legacy = data.doc;
		}
	}
	return { docs: [...docs.values()], legacy };
}

// Stored-shape checks: tolerant callers (the fold, the server) get undefined for anything off.

const str = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function normText(v: unknown, prefix: string): AlignText | undefined {
	if (!isRecord(v) || !str(v.id) || !v.id.startsWith(prefix) || !nonEmpty(v.text)) return undefined;
	return { id: v.id, text: v.text };
}

function normQuestion(v: unknown): AlignQuestion | undefined {
	if (!isRecord(v) || !str(v.id) || itemKind(v.id) !== "q" || !nonEmpty(v.topic) || !nonEmpty(v.ask)) return undefined;
	const r = v.recommendation;
	if (!isRecord(r) || !nonEmpty(r.choice) || !nonEmpty(r.why)) return undefined;
	const q: AlignQuestion = { id: v.id, topic: v.topic, ask: v.ask, recommendation: { choice: r.choice, why: r.why } };
	if (v.context !== undefined) {
		if (!nonEmpty(v.context)) return undefined;
		q.context = v.context;
	}
	if (v.options !== undefined) {
		if (!Array.isArray(v.options)) return undefined;
		const options: AlignOption[] = [];
		for (const o of v.options) {
			if (!isRecord(o) || !nonEmpty(o.label) || !nonEmpty(o.tradeoff)) return undefined;
			options.push({ label: o.label, tradeoff: o.tradeoff });
		}
		if (options.length > 0) q.options = options;
	}
	if (v.decision !== undefined) {
		const d = v.decision;
		if (!isRecord(d) || !nonEmpty(d.text) || (d.by !== "user" && d.by !== "accepted-recommendation") || !str(d.at)) return undefined;
		q.decision = { text: d.text, by: d.by, at: d.at };
	}
	if (v.dropped !== undefined) {
		const d = v.dropped;
		if (!isRecord(d) || !nonEmpty(d.why) || !str(d.at)) return undefined;
		q.dropped = { why: d.why, at: d.at };
	}
	if (v.visual !== undefined) {
		const visual = normVisual(v.visual);
		if (!visual) return undefined;
		q.visual = visual;
	}
	return q;
}

function normVisual(v: unknown): AlignVisual | undefined {
	return isRecord(v) && nonEmpty(v.kind) && nonEmpty(v.source) ? { kind: v.kind, source: v.source } : undefined;
}

function normAll<T>(v: unknown, one: (x: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: T[] = [];
	for (const x of v) {
		const ok = one(x);
		if (ok === undefined) return undefined;
		out.push(ok);
	}
	return out;
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function normBlocker(v: unknown): AlignBlocker | undefined {
	if (!isRecord(v) || !str(v.id) || !/^b[1-9]\d*$/.test(v.id) || !nonEmpty(v.title) || !nonEmpty(v.check)) return undefined;
	const b: AlignBlocker = { id: v.id, title: v.title, check: v.check };
	if (v.closed !== undefined) {
		const c = v.closed;
		if (!isRecord(c) || !(ALIGN_BLOCKER_CLOSES as readonly unknown[]).includes(c.by) || !nonEmpty(c.evidence) || !str(c.at)) return undefined;
		b.closed = { by: c.by as AlignBlockerClose, evidence: c.evidence, at: c.at };
	}
	return b;
}

function normReviewEntry(v: unknown): AlignReviewEntry | undefined {
	if (!isRecord(v) || !(ALIGN_REVIEW_STATES as readonly unknown[]).includes(v.state) || !nonEmpty(v.reason) || !str(v.at)) return undefined;
	const e: AlignReviewEntry = { state: v.state as AlignReviewState, reason: v.reason, at: v.at };
	if (v.model !== undefined) {
		if (!nonEmpty(v.model)) return undefined;
		e.model = v.model;
	}
	if (v.blockers !== undefined) {
		const blockers = normAll(v.blockers, normBlocker);
		if (!blockers || blockers.length === 0 || new Set(blockers.map((b) => b.id)).size !== blockers.length) return undefined;
		e.blockers = blockers;
	}
	return e;
}

/** The review record, checked; undefined when anything is off (the whole snapshot then is). */
function normReview(v: unknown): AlignReview | undefined {
	if (!isRecord(v)) return undefined;
	const out: AlignReview = {};
	for (const key of Object.keys(v)) if (key !== "plan" && key !== "diff") return undefined;
	for (const phase of ALIGN_REVIEW_PHASES) {
		if (v[phase] === undefined) continue;
		const entry = normReviewEntry(v[phase]);
		if (!entry) return undefined;
		out[phase] = entry;
	}
	return out;
}

/** A stored document, checked field by field; a fresh object, or undefined when anything is off. */
export function normalizeAlignDocument(v: unknown): AlignDocument | undefined {
	try {
		if (!isRecord(v) || !str(v.id) || !DOC_ID.test(v.id) || !nonEmpty(v.title) || !nonEmpty(v.summary)) return undefined;
		const findings = normAll(v.findings, (x) => normText(x, "f"));
		const approach = normAll(v.approach, (x) => normText(x, "a"));
		const rejected = normAll(v.rejected, (x) =>
			isRecord(x) && str(x.id) && itemKind(x.id) === "x" && nonEmpty(x.option) && nonEmpty(x.why) ? { id: x.id, option: x.option, why: x.why } : undefined,
		);
		const questions = normAll(v.questions, normQuestion);
		const technical = v.technical === undefined ? [] : normAll(v.technical, (x) => normText(x, "t"));
		if (!findings || !approach || !rejected || !questions || !technical) return undefined;
		if (v.phase !== "open" && v.phase !== "implementing" && v.phase !== "done" && v.phase !== "dropped") return undefined;
		const n = v.next;
		if (!isRecord(n) || !count(n.f) || !count(n.a) || !count(n.x) || !count(n.q) || (n.t !== undefined && !count(n.t))) return undefined;
		if (technical.length > 0 && n.t === undefined) return undefined;
		if (!count(v.rev) || v.rev < 1 || !str(v.createdAt) || !str(v.updatedAt)) return undefined;
		const doc: AlignDocument = {
			id: v.id,
			title: v.title,
			summary: v.summary,
			findings,
			approach,
			rejected,
			questions,
			phase: v.phase,
			next: { f: n.f, a: n.a, x: n.x, q: n.q, ...(n.t !== undefined ? { t: n.t as number } : {}) },
			rev: v.rev,
			createdAt: v.createdAt,
			updatedAt: v.updatedAt,
		};
		if (v.technical !== undefined) doc.technical = technical;
		if (v.style !== undefined) {
			if (v.style !== "simplified" && v.style !== "pm") return undefined;
			doc.style = v.style;
		}
		if (v.visual !== undefined) {
			const visual = normVisual(v.visual);
			if (!visual) return undefined;
			doc.visual = visual;
		}
		if (v.review !== undefined) {
			const review = normReview(v.review);
			if (!review) return undefined;
			doc.review = review;
		}
		// A dropped document says why, and only a dropped one does (status open clears it).
		if ((v.phase === "dropped") !== (v.droppedWhy !== undefined)) return undefined;
		if (v.droppedWhy !== undefined) {
			if (!nonEmpty(v.droppedWhy)) return undefined;
			doc.droppedWhy = v.droppedWhy;
		}
		// The invariants the ops rely on for "ids are never reused": each id is unique in its kind
		// and no higher than that kind's counter, which the next add continues from.
		const kinds: [keyof AlignDocument["next"], readonly { id: string }[]][] = [["f", findings], ["a", approach], ["x", rejected], ["q", questions], ["t", technical]];
		for (const [kind, items] of kinds) {
			const numbers = items.map((item) => (itemKind(item.id) === kind ? Number(item.id.slice(1)) : Number.NaN));
			if (numbers.some((k) => !Number.isInteger(k) || k < 1 || k > (doc.next[kind] ?? 0))) return undefined;
			if (new Set(numbers).size !== numbers.length) return undefined;
		}
		return doc;
	} catch {
		return undefined;
	}
}

const CHANGE_KINDS = new Set(["created", "added", "edited", "removed", "decided", "accepted", "reopened", "question-dropped", "status", "dropped", "review", "blocker-closed"]);

function normChange(v: unknown): AlignChange | undefined {
	if (!isRecord(v) || !str(v.kind) || !CHANGE_KINDS.has(v.kind)) return undefined;
	const ids = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every(str);
	switch (v.kind) {
		case "created":
			return v.fromFile === true ? { kind: "created", fromFile: true } : { kind: "created" };
		case "added":
		case "edited":
		case "removed":
			return ids(v.ids) ? { kind: v.kind, ids: [...(v.ids as string[])] } : undefined;
		case "accepted":
			return ids(v.qs) ? { kind: "accepted", qs: [...(v.qs as string[])] } : undefined;
		case "decided":
		case "reopened":
		case "question-dropped":
			return str(v.q) ? { kind: v.kind, q: v.q } : undefined;
		case "status":
			return v.to === "implementing" || v.to === "done" || v.to === "open" ? { kind: "status", to: v.to } : undefined;
		case "review":
			return (v.phase === "plan" || v.phase === "diff") && (ALIGN_REVIEW_STATES as readonly unknown[]).includes(v.state)
				? { kind: "review", phase: v.phase, state: v.state as AlignReviewState }
				: undefined;
		case "blocker-closed":
			return (v.phase === "plan" || v.phase === "diff") && str(v.id) ? { kind: "blocker-closed", phase: v.phase, id: v.id } : undefined;
		default:
			return { kind: "dropped" };
	}
}

/** A tool result's details, checked; a fresh object, or undefined when anything is off. */
export function normalizeAlignDetails(v: unknown): AlignDetails | undefined {
	try {
		if (!isRecord(v) || v.v !== ALIGN_DETAILS_VERSION || !str(v.line)) return undefined;
		const changes = normAll(v.changes, normChange);
		if (!changes) return undefined;
		const out: AlignDetails = { v: 1, changes, line: v.line };
		if (v.doc !== undefined) {
			const doc = normalizeAlignDocument(v.doc);
			if (!doc) return undefined;
			out.doc = doc;
		}
		if (v.exempt !== undefined) {
			if (!isRecord(v.exempt) || !nonEmpty(v.exempt.why)) return undefined;
			out.exempt = { why: v.exempt.why };
		}
		return out;
	} catch {
		return undefined;
	}
}

// ── Text ─────────────────────────────────────────────────────────────────────

const STATUS_WORDS: Record<AlignStatus, string> = {
	aligning: "aligning",
	confirmed: "confirmed",
	implementing: "implementing",
	done: "done",
	dropped: "dropped",
};

export const alignStatusWord = (status: AlignStatus): string => STATUS_WORDS[status] ?? String(status);

/** "2 of 7 open" / "no questions yet" / "all 3 decided". */
export function openText(doc: AlignDocument): string {
	const live = liveQuestionsOf(doc).length;
	const open = openQuestionsOf(doc).length;
	if (live === 0) return "no questions yet";
	return open === 0 ? `all ${live} decided` : `${open} of ${live} open`;
}

/** `al_3 "Autonomy settings" · aligning · 2 of 7 open`. */
export function docLine(doc: AlignDocument): string {
	return `${doc.id} "${doc.title}" · ${alignStatusWord(alignStatus(doc))} · ${openText(doc)}`;
}

/** "Implementation review: 2 blocking", "Plan reviewed · 1 constraint added", …: one phase's verdict line, as the card reads it. */
export function reviewVerdictLine(phase: AlignReviewPhase, entry: AlignReviewEntry): string {
	const Phase = reviewPhaseName(phase);
	switch (entry.state) {
		case "skipped":
			return `${Phase} review skipped: ${entry.reason}`;
		case "running":
			return `Reviewing the ${Phase.toLowerCase()}`;
		case "incomplete":
			return `${Phase} review incomplete: ${entry.reason}`;
		case "clear":
			return phase === "plan" ? `Plan reviewed · ${entry.reason}` : `${Phase} review: no blocking issues`;
		case "blocking": {
			const n = entry.blockers?.length ?? 0;
			if (phase === "plan" && n === 0) return `Plan reviewed · ${entry.reason}`;
			const open = entry.blockers?.filter((b) => !b.closed).length ?? 0;
			return `${Phase} review: ${n} blocking${open < n ? ` (${open} open)` : ""}`;
		}
	}
}

/** The record as text lines: each phase's verdict (with the model), then each open blocker and its check. Empty without one. */
export function reviewLines(doc: Pick<AlignDocument, "review">): string[] {
	const out: string[] = [];
	for (const phase of ALIGN_REVIEW_PHASES) {
		const entry = doc.review?.[phase];
		if (!entry) continue;
		out.push(`${reviewVerdictLine(phase, entry)}${entry.model ? ` (${entry.model})` : ""}`);
		for (const b of entry.blockers ?? []) if (!b.closed) out.push(`  ${reviewPhaseName(phase).toLowerCase()} ${b.id} open: ${b.title} — check: ${b.check}`);
	}
	return out;
}

function questionLine(q: AlignQuestion): string {
	return `  ${q.id} ${q.topic} — open (rec: ${recommendedText(q)})`;
}

function otherDocsLine(docs: readonly AlignDocument[], except: string | undefined): string[] {
	const others = openDocsOf(docs).filter((doc) => doc.id !== except);
	if (others.length === 0) return [];
	return [`Other open alignments: ${others.map((doc) => `${doc.id} "${doc.title}" ${alignStatusWord(alignStatus(doc))}${openQuestionsOf(doc).length ? ` (${openQuestionsOf(doc).length} open)` : ""}`).join(" · ")}`];
}

/** The tool's compact echo: the touched document, its open questions, then the others. */
function echoLines(docs: readonly AlignDocument[], id: string, line: string): string[] {
	const doc = docs.find((d) => d.id === id);
	if (!doc) return [];
	const head = `${docLine(doc)} · v${doc.rev}${line ? ` · ${line}` : ""}`;
	const out = [head, ...openQuestionsOf(doc).map(questionLine)];
	if (doc.phase === "dropped" && doc.droppedWhy) out.push(`  dropped: ${doc.droppedWhy}`);
	out.push(...reviewLines(doc).map((l) => `  ${l}`));
	return [...out, ...otherDocsLine(docs, id)];
}

/** " — a. CSV · b. Parquet" for a question with options, so a "3a" answer resolves; "" without. */
function optionsLine(q: AlignQuestion): string {
	return q.options ? ` — ${q.options.map((o, i) => `${optionLetter(i)}. ${oneLine(o.label)}`).join(" · ")}` : "";
}

/**
 * The hidden note on a user prompt: every open alignment and its open questions, so an answer by
 * id lands on the right question. undefined when nothing is open. `afterCompaction` is the note
 * written once right after a compaction, when the summary may have lost the tool results: it also
 * lists each open alignment's decided and dropped questions, which implementation still needs.
 */
export function alignStateNote(docs: readonly AlignDocument[], afterCompaction = false): string | undefined {
	const open = openDocsOf(docs);
	if (open.length === 0) return undefined;
	const lines = [
		afterCompaction
			? "[align] The context was just compacted. The open alignments on this branch, exactly as recorded (the summary above may describe them loosely; recommendations are not decisions until decided or accepted); ids are stable."
			: "[align] Open alignments on this branch. If the user's message answers any of these questions, record it with the align tool (decide with their words, accept for \"your recommendation\"), in one call per alignment; ids are stable.",
	];
	for (const doc of open) {
		lines.push(`${docLine(doc)}`);
		for (const q of doc.questions) {
			const state = questionState(q);
			if (state === "open") lines.push(`  ${q.id} ${q.topic}: ${oneLine(q.ask)}${optionsLine(q)} (rec: ${recommendedText(q)})`);
			else if (afterCompaction && state === "decided") lines.push(`  ${q.id} ${q.topic}: decided — ${oneLine(q.decision!.text)}`);
			else if (afterCompaction) lines.push(`  ${q.id} ${q.topic}: dropped — ${oneLine(q.dropped!.why)}`);
		}
		if (alignStatus(doc) === "implementing") lines.push("  (implementing: set status done when the work is finished and verified)");
		lines.push(...reviewLines(doc).map((l) => `  ${l}`));
	}
	return lines.join("\n");
}

/** "q3 decided · +q11 · → implementing"; "" for no changes. Consecutive decisions merge: "q1, q3 decided". */
export function changeLine(changes: readonly AlignChange[]): string {
	const parts: string[] = [];
	let decided: string[] = [];
	const flush = () => {
		if (decided.length) parts.push(`${decided.join(", ")} decided`);
		decided = [];
	};
	for (const c of changes) {
		if (c.kind === "decided") {
			decided.push(c.q);
			continue;
		}
		flush();
		switch (c.kind) {
			case "created":
				parts.push(c.fromFile ? "created from file" : "created");
				break;
			case "added":
				parts.push(c.ids.map((id) => `+${id}`).join(" "));
				break;
			case "edited":
				parts.push(`${c.ids.join(", ")} edited`);
				break;
			case "removed":
				parts.push(c.ids.map((id) => `−${id}`).join(" "));
				break;
			case "accepted":
				parts.push(`${c.qs.join(", ")} accepted`);
				break;
			case "reopened":
				parts.push(`${c.q} reopened`);
				break;
			case "question-dropped":
				parts.push(`${c.q} dropped`);
				break;
			case "status":
				parts.push(`→ ${c.to}`);
				break;
			case "dropped":
				parts.push("dropped");
				break;
			case "review": {
				const phase = reviewPhaseName(c.phase).toLowerCase();
				parts.push(c.state === "running" ? `${phase} review running` : c.state === "skipped" ? `${phase} review skipped` : `${phase} review: ${c.state === "clear" ? "no blocking" : c.state}`);
				break;
			}
			case "blocker-closed":
				parts.push(`${reviewPhaseName(c.phase).toLowerCase()} ${c.id} closed`);
				break;
		}
	}
	flush();
	return parts.join(" · ");
}

/** The whole document as markdown: `get`, `/align export`, the TUI viewer. */
export function toMarkdown(doc: AlignDocument): string {
	const style = doc.style ? ` · ${doc.style === "pm" ? "Project manager" : "Simplified"} style` : "";
	const out = [`## ${doc.id}: ${doc.title}`, "", `_${doc.summary}_`, "", `Status: ${alignStatusWord(alignStatus(doc))} · ${openText(doc)} · v${doc.rev}${style}`];
	if (doc.visual) out.push("", ...visualMarkdown(doc.visual));
	if (doc.phase === "dropped" && doc.droppedWhy) out.push(`Dropped: ${doc.droppedWhy}`);
	if (doc.questions.length > 0) {
		out.push("", "### Questions");
		for (const q of doc.questions) {
			const state = questionState(q);
			out.push("", `**${q.id} · ${q.topic}** (${state})`, "", q.ask);
			if (q.context) out.push("", q.context);
			if (q.visual) out.push("", ...visualMarkdown(q.visual));
			// One paragraph per option: "a." is no list marker, so adjacent lines would run together.
			if (q.options) for (const [i, o] of q.options.entries()) out.push("", `${optionLetter(i)}. **${o.label}** — ${o.tradeoff}`);
			const rec = recommendedOption(q);
			out.push("", `Recommended: ${rec === undefined ? `**${q.recommendation.choice}**` : `${optionLetter(rec)} — **${q.options![rec]!.label}**`} — ${q.recommendation.why}`);
			if (q.decision) out.push("", `Decided: ${q.decision.text} (${q.decision.by === "user" ? "user" : "accepted recommendation"})`);
			if (q.dropped) out.push("", `Dropped: ${q.dropped.why}`);
		}
	}
	if (doc.findings.length > 0) out.push("", "### Findings", "", ...doc.findings.map((f) => `- ${f.id}: ${f.text}`));
	if (doc.approach.length > 0) out.push("", "### Approach", "", ...doc.approach.map((a, i) => `${i + 1}. ${a.id}: ${a.text}`));
	if (doc.technical?.length) out.push("", "### Technical notes", "", ...doc.technical.map((t) => `- ${t.id}: ${t.text}`));
	if (doc.rejected.length > 0) out.push("", "### Rejected", "", ...doc.rejected.map((x) => `- ${x.id}: ${x.option} — ${x.why}`));
	if (doc.review && (doc.review.plan || doc.review.diff)) {
		out.push("", "### Review");
		for (const phase of ALIGN_REVIEW_PHASES) {
			const entry = doc.review[phase];
			if (!entry) continue;
			out.push("", `- ${reviewVerdictLine(phase, entry)}${entry.model ? ` (${entry.model})` : ""}`);
			for (const b of entry.blockers ?? [])
				out.push(`  - ${b.id}: ${b.title} — check: ${b.check}${b.closed ? ` — closed by ${b.closed.by}: ${b.closed.evidence}` : " — open"}`);
		}
	}
	return out.join("\n");
}

/** A visual as markdown: its source in a `vis {kind}` code block (the TUI shows the source; Sova draws it). */
function visualMarkdown(visual: AlignVisual): string[] {
	const fence = visual.source.includes("```") ? "~~~~" : "```";
	return [`${fence}vis ${visual.kind}`, visual.source, fence];
}

/** The TUI widget: "◇ align · al_3 2/7 open · al_2 implementing · alt+a view". */
export function widgetText(docs: readonly AlignDocument[], keyHint: string): string {
	const parts = ["◇ align"];
	for (const doc of openDocsOf(docs)) {
		const open = openQuestionsOf(doc).length;
		const status = alignStatus(doc);
		parts.push(status === "aligning" && liveQuestionsOf(doc).length > 0 ? `${doc.id} ${open}/${liveQuestionsOf(doc).length} open` : `${doc.id} ${alignStatusWord(status)}`);
	}
	if (keyHint.trim() !== "") parts.push(`${keyHint.trim()} view`);
	return parts.join(" · ");
}

// ── The settle nudge's heuristic ─────────────────────────────────────────────

const FENCED = /```[\s\S]*?```/g;
/** The spec minor mode's closing line ("Also changes: none"): not part of what the reply asks. */
const SPEC_TRAILER = /\n\s*Also (?:changes:|updates\b)[^\n]*\s*$/i;
/** Words that label what follows as the user's to decide. */
const LABEL_ASK = /\b(?:open questions?|questions for you|decisions? (?:for you|needed|to make)|need(?:s)? (?:your|a) (?:decision|call|answer))\b/i;
/** Asking for a go-ahead on a plan, or for the agent's recommendations to stand. */
const APPROVAL_ASK =
	/\b(?:should i (?:go ahead|proceed|start|build|implement)|shall i (?:go ahead|proceed|start)|(?:ok|okay) to (?:go ahead|proceed|start)|want me to (?:go ahead|proceed|start|build|implement)|(?:take|with) my (?:suggested answers|recommendations?|recs)|go with (?:my|these|the) (?:recs|recommendations?|defaults?|answers?))\b/i;
/** Asking the user to pick between options. */
const CHOICE_ASK = /\b(?:which (?:one |option |approach )?(?:do|would) you (?:prefer|want|like|pick|choose)|your call)\b/i;
/** A bare go-ahead as the whole closing ask: "Go?", "OK?", "Sound good?". */
const BARE_GO = /^(?:\*\*)?(?:go|ok(?:ay)?|good to go|sounds? good|proceed)\b[^\n]*\?/i;
/** A confirmation to run something, not a design decision: the nudge would only be exempted. */
const RUN_CONFIRM = /\b(?:merge|merging|push|release|restart|deploy|commit|rebase|publish)\b/i;
/** A leftover alignment block in the old markdown shape: its `## Alignment: <title>` anchor, colon and all. */
const MARKDOWN_ALIGNMENT = /^\s*#{1,4}\s+alignment:\s*\S/im;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+\S/;

/** What the nudge knows about the run beyond its reply. */
export interface PlanContext {
	/** The user's prompt that started the run was itself a question: options offered back answer it. */
	userAsked?: boolean;
}

/** The sentences of a paragraph that ask (end in "?"). */
function questionsOf(paragraph: string): string[] {
	return paragraph.split(/(?<=[.!?])\s+/).filter((x) => /\?\s*[*_)\]"'`]*\s*$/.test(x));
}

/**
 * Does one of these questions put a decision to the user? A merge-style confirmation does not, nor a
 * choice that answers the user's own question; words outside the questions don't count.
 */
function decisionAsk(paragraph: string, context: PlanContext): boolean {
	return questionsOf(paragraph).some(
		(q) => !RUN_CONFIRM.test(q) && (LABEL_ASK.test(q) || APPROVAL_ASK.test(q) || (!context.userAsked && CHOICE_ASK.test(q))),
	);
}

/**
 * A short line that labels what follows as the user's to decide ("**Questions for you:**", "Open
 * questions"), then a list with two or more questions that aren't run confirmations: wherever it
 * sits, since a reply can close on a statement ("I'll record this once tools work.") after asking.
 */
function questionList(body: string): boolean {
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const label = lines[i]!.trim();
		if (label.length > 80 || LIST_ITEM.test(label) || !LABEL_ASK.test(label)) continue;
		let asks = 0;
		for (const line of lines.slice(i + 1)) {
			if (line.trim() === "") continue;
			if (LIST_ITEM.test(line)) {
				if (line.includes("?") && !RUN_CONFIRM.test(line)) asks++;
			} else if (!/^\s/.test(line)) break;
		}
		if (asks >= 2) return true;
	}
	return false;
}

/**
 * Why a final reply reads like a plan that asks the user to decide, written in prose instead of
 * the tool — or null when it doesn't:
 * - an old markdown alignment block (`## Alignment: <title>`; a heading or bold line that merely
 *   mentions alignment is not one);
 * - a last paragraph that ends in a question putting a decision to the user: labelled ("open
 *   questions"), a go-ahead ("should I go ahead", "take my recommendations") or a choice ("which do
 *   you prefer", unless the user's own prompt asked a question and the options answer it) — never a
 *   merge, push or restart confirmation;
 * - a list of two or more items with such words anywhere, closed by a go-ahead ask ("Go?", or one
 *   of the above);
 * - or, wherever it sits, a labelled list of questions (questionList).
 * Code fences and the spec mode's "Also changes" line are ignored. Calibrated offline against real
 * sessions (align.test.ts pins the shapes, false positives included).
 */
export function planSignal(reply: string, context: PlanContext = {}): "markdown-alignment" | "question-list" | "asks-decision" | "list-then-decision" | null {
	if (typeof reply !== "string") return null;
	const body = reply.replace(FENCED, " ").replace(SPEC_TRAILER, "").trim();
	if (MARKDOWN_ALIGNMENT.test(body)) return "markdown-alignment";
	const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
	const last = paragraphs[paragraphs.length - 1] ?? "";
	if (/\?\s*[*_)\]"'`]*\s*$/.test(last)) {
		if (decisionAsk(last, context)) return "asks-decision";
		const items = body.split("\n").filter((l) => LIST_ITEM.test(l)).length;
		const anyDecisionWords = LABEL_ASK.test(body) || APPROVAL_ASK.test(body) || CHOICE_ASK.test(body);
		if (items >= 2 && anyDecisionWords && BARE_GO.test(last) && !questionsOf(last).some((q) => RUN_CONFIRM.test(q))) return "list-then-decision";
	}
	return questionList(body) ? "question-list" : null;
}

/** planSignal as a yes/no: the settle nudge's trigger. */
export const looksLikeUncapturedPlan = (reply: string, context: PlanContext = {}): boolean => planSignal(reply, context) !== null;

// ── Legacy: an older session's align-doc entries (read-only) ────────────────

export type LegacyAlignStatus = "aligning" | "questions-open" | "ready" | "confirmed" | "implementing";

export interface LegacyAlignQuestion {
	n: number;
	text: string;
	checked: boolean;
}

/** The document the extension parsed from the agent's markdown before the tool existed. */
export interface LegacyAlignDoc {
	version: 1;
	title: string;
	markdown: string;
	questions: LegacyAlignQuestion[];
	explicitStatus?: "confirmed" | "implementing" | "aligning";
	revision: number;
	capturedAt: string;
}

/** Persisted payload of an `align-doc` entry; `doc: null` meant cleared. */
export interface LegacyAlignEntryData {
	version: 1;
	doc: LegacyAlignDoc | null;
}

export function legacyStatus(doc: LegacyAlignDoc): LegacyAlignStatus {
	if (doc.explicitStatus === "implementing") return "implementing";
	if (doc.explicitStatus === "confirmed") return "confirmed";
	const open = doc.questions.filter((question) => !question.checked).length;
	if (open > 0) return "questions-open";
	if (doc.questions.length > 0) return "ready";
	return "aligning";
}

/** "v3 · questions open · 2/5 settled". */
export function legacyLine(doc: LegacyAlignDoc): string {
	const total = doc.questions.length;
	const settled = doc.questions.filter((question) => question.checked).length;
	const status = legacyStatus(doc).replace("-", " ");
	return `v${doc.revision} · ${status}${total > 0 ? ` · ${settled}/${total} settled` : ""}`;
}

function normalizeLegacyQuestion(value: unknown): LegacyAlignQuestion | undefined {
	if (!isRecord(value)) return undefined;
	const { n, text: t, checked } = value;
	if (typeof n !== "number" || !Number.isFinite(n) || typeof t !== "string" || typeof checked !== "boolean") return undefined;
	return { n, text: t, checked };
}

function normalizeLegacyDoc(value: unknown): LegacyAlignDoc | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { title, markdown, questions, explicitStatus, revision, capturedAt } = value;
	if (typeof title !== "string" || typeof markdown !== "string" || typeof capturedAt !== "string") return undefined;
	if (typeof revision !== "number" || !Number.isFinite(revision)) return undefined;
	const normalized = normAll(questions, normalizeLegacyQuestion);
	if (!normalized) return undefined;
	const doc: LegacyAlignDoc = { version: 1, title, markdown, questions: normalized, revision, capturedAt };
	if (explicitStatus !== undefined) {
		if (explicitStatus !== "confirmed" && explicitStatus !== "implementing" && explicitStatus !== "aligning") return undefined;
		doc.explicitStatus = explicitStatus;
	}
	return doc;
}

/** Strict shape check of a legacy entry payload; a fresh object without unknown keys, or undefined. */
export function normalizeAlignEntry(data: unknown): LegacyAlignEntryData | undefined {
	try {
		if (!isRecord(data) || data.version !== 1 || !("doc" in data)) return undefined;
		if (data.doc === null) return { version: 1, doc: null };
		const doc = normalizeLegacyDoc(data.doc);
		return doc ? { version: 1, doc } : undefined;
	} catch {
		return undefined;
	}
}

// ── Viewer scroll math ───────────────────────────────────────────────────────

/** First visible line index, clamped so the window stays within `total` lines. */
export function clampScroll(scroll: number, total: number, height: number): number {
	const max = Math.max(0, Math.floor(total) - Math.max(1, Math.floor(height)));
	if (!Number.isFinite(scroll)) return 0;
	return Math.max(0, Math.min(Math.floor(scroll), Number.isFinite(max) ? max : 0));
}

export function viewport<T>(lines: T[], scroll: number, height: number): T[] {
	const rows = Math.max(0, Number.isFinite(height) ? Math.floor(height) : 0);
	const start = clampScroll(scroll, lines.length, rows);
	return lines.slice(start, start + rows);
}
