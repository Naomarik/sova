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
	"[align] Your last reply reads like a plan or asks the user to decide, and nothing was recorded with the align tool this run. Record it now: align create (or ops on the open alignment), each question with its recommendation, then reply with one short sentence pointing at it. If it isn't a design decision (a status report, a merge or run confirmation), call align exempt with why and stop.";
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
	questions: AlignQuestion[];
	phase: AlignPhase;
	/** Why the whole document was dropped (phase "dropped"). */
	droppedWhy?: string;
	/** The last number used per item kind: ids are never reused, removed or not. */
	next: { f: number; a: number; x: number; q: number };
	/** 1 at create, +1 per changing call. */
	rev: number;
	createdAt: string;
	updatedAt: string;
}

export type AlignChange =
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
	| { kind: "dropped" };

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

/** Field names models reach for from other tools (pi's edit takes newText), and the one meant. */
const MEANT: Record<string, string> = { newText: "text", new_text: "text", answer: "decision", reason: "why", question: "ask" };

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) continue;
		const meant = MEANT[key] !== undefined && allowed.includes(MEANT[key]) ? ` (did you mean "${MEANT[key]}"?)` : "";
		need(allowed.includes(key), `${where}: unknown field "${key}"${meant} (allowed: ${allowed.join(", ")})`);
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
}

function questionInput(value: unknown, where: string): AlignQuestionInput {
	need(isRecord(value), `${where} must be an object {topic, ask, context?, options?, recommendation}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["topic", "ask", "context", "options", "recommendation"], where);
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
	return q;
}

function rejectedInput(value: unknown, where: string): { option: string; why: string } {
	need(isRecord(value), `${where} must be an object {option, why}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, ["option", "why"], where);
	return { option: text(v.option, `${where}.option`), why: text(v.why, `${where}.why`) };
}

/** What a create supplies (inline, or as the JSON file `fromFile` names). */
export interface AlignDocInput {
	title: string;
	summary: string;
	findings: string[];
	approach: string[];
	rejected: { option: string; why: string }[];
	questions: AlignQuestionInput[];
}

export const DOC_INPUT_KEYS = ["title", "summary", "findings", "approach", "rejected", "questions"] as const;

/** Strict: every field typed, nothing unknown. `where` prefixes each message ("fromFile x.json"). */
export function parseDocInput(value: unknown, where: string): AlignDocInput {
	need(isRecord(value), `${where} must be a JSON object with ${DOC_INPUT_KEYS.join(", ")}`);
	const v = value as Record<string, unknown>;
	onlyKeys(v, DOC_INPUT_KEYS, where);
	return {
		title: oneLine(text(v.title, `${where}: title`)),
		summary: oneLine(text(v.summary, `${where}: summary`)),
		findings: v.findings === undefined ? [] : list(v.findings, `${where}: findings`, text),
		approach: v.approach === undefined ? [] : list(v.approach, `${where}: approach`, text),
		rejected: v.rejected === undefined ? [] : list(v.rejected, `${where}: rejected`, rejectedInput),
		questions: v.questions === undefined ? [] : list(v.questions, `${where}: questions`, questionInput),
	};
}

/** The JSON a planning worker writes for `create` + `fromFile`: said once, for the tool description and prompts. */
export const ALIGN_FILE_SCHEMA = `{"title": string, "summary": one line on what the concern is about, "findings": [string], "approach": [string, in order], "rejected": [{"option": string, "why": string}], "questions": [{"topic": short, "ask": the question, "context": what the user needs to answer it (optional), "options": [{"label": string, "tradeoff": string}] (optional), "recommendation": {"choice": string, "why": string}}]}`;

// ── Operations ───────────────────────────────────────────────────────────────

export const ALIGN_OPS = ["create", "add", "edit", "remove", "decide", "accept", "reopen", "drop", "status", "exempt", "get"] as const;
export type AlignOpName = (typeof ALIGN_OPS)[number];

const OP_KEYS: Record<AlignOpName, readonly string[]> = {
	create: ["op", "fromFile", ...DOC_INPUT_KEYS],
	add: ["op", "findings", "approach", "rejected", "questions"],
	edit: ["op", "id", "title", "summary", "text", "option", "why", "topic", "ask", "context", "options", "recommendation"],
	remove: ["op", "ids"],
	decide: ["op", "q", "decision"],
	accept: ["op", "q"],
	reopen: ["op", "q"],
	drop: ["op", "q", "why"],
	status: ["op", "to"],
	exempt: ["op", "why"],
	get: ["op"],
};

export interface AlignEnv {
	/** ISO timestamp stamped on decisions, drops and the document. */
	now: string;
	/** Reads `fromFile` (resolved by the caller against the session's cwd). */
	readFile(path: string): string;
}

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

function itemKind(id: string): "f" | "a" | "x" | "q" | undefined {
	const m = /^([faxq])[1-9]\d*$/.exec(id);
	return m ? (m[1] as "f" | "a" | "x" | "q") : undefined;
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
	return doc;
}

/** Append items with fresh ids; returns the ids, in order. */
function addItems(doc: AlignDocument, input: Pick<AlignDocInput, "findings" | "approach" | "rejected" | "questions">): string[] {
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
	for (const q of input.questions) {
		const id = `q${++doc.next.q}`;
		doc.questions.push({ id, ...q });
		ids.push(id);
	}
	return ids;
}

function findQuestion(doc: AlignDocument, id: unknown, where: string): AlignQuestion {
	need(typeof id === "string" && itemKind(id) === "q", `${where}: q must be a question id like "q3"`);
	const q = doc.questions.find((x) => x.id === id);
	need(q !== undefined, `${where}: ${doc.id} has no question ${id} (it has ${doc.questions.map((x) => x.id).join(", ") || "none"})`);
	return q!;
}

function docList(docs: readonly AlignDocument[]): string {
	return docs.map((doc) => `${doc.id} "${doc.title}"`).join(", ");
}

/**
 * Apply one tool call to the branch's documents, atomically: every op is validated before
 * anything is kept, and the first problem throws AlignError. Pure apart from `env.readFile`.
 */
export function applyAlignCall(docs: readonly AlignDocument[], input: unknown, env: AlignEnv): AlignOutcome {
	need(isRecord(input), "align takes {doc?, ops: [...]}");
	const params = input as Record<string, unknown>;
	onlyKeys(params, ["doc", "ops"], "align");
	need(Array.isArray(params.ops) && params.ops.length > 0, "ops must be a non-empty array of operations");
	const ops = (params.ops as unknown[]).map((op, i) => {
		need(isRecord(op), `ops[${i}] must be an object with an "op" field`);
		const o = op as Record<string, unknown>;
		need(typeof o.op === "string" && (ALIGN_OPS as readonly string[]).includes(o.op), `ops[${i}].op must be one of ${ALIGN_OPS.join(", ")}`);
		onlyKeys(o, OP_KEYS[o.op as AlignOpName], `ops[${i}] (${o.op})`);
		return o as Record<string, unknown> & { op: AlignOpName };
	});

	// An exemption touches no document and stands alone.
	if (ops.some((o) => o.op === "exempt")) {
		need(ops.length === 1, "exempt stands alone in its call");
		const why = oneLine(text(ops[0]!.why, "ops[0] (exempt): why"));
		return {
			details: { v: 1, changes: [], line: "", exempt: { why } },
			text: [`Recorded: no alignment needed — ${/[.!?]$/.test(why) ? why : `${why}.`}`, ...otherDocsLine(docs, undefined)].join("\n"),
		};
	}

	const creates = ops.findIndex((o) => o.op === "create");
	need(creates <= 0 && ops.filter((o) => o.op === "create").length <= 1, "create must be the first op, once per call");
	const onlyGets = ops.every((o) => o.op === "get");

	let doc: AlignDocument | undefined;
	const changes: AlignChange[] = [];
	if (creates === 0) {
		const o = ops[0]!;
		let parsed: AlignDocInput;
		if (o.fromFile !== undefined) {
			need(DOC_INPUT_KEYS.every((k) => o[k] === undefined), "ops[0] (create): give either fromFile or the document's fields, not both");
			const path = text(o.fromFile, "ops[0] (create): fromFile");
			let raw: string;
			try {
				raw = env.readFile(path);
			} catch (error) {
				throw new AlignError(`fromFile ${path}: cannot read it (${error instanceof Error ? error.message : String(error)})`);
			}
			let json: unknown;
			try {
				json = JSON.parse(raw);
			} catch (error) {
				throw new AlignError(`fromFile ${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
			}
			parsed = parseDocInput(json, `fromFile ${path}`);
		} else {
			parsed = parseDocInput(Object.fromEntries(DOC_INPUT_KEYS.map((k) => [k, o[k]])), "ops[0] (create)");
		}
		doc = freshDoc(nextDocId(docs), parsed, env.now);
		changes.push(o.fromFile !== undefined ? { kind: "created", fromFile: true } : { kind: "created" });
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
	const start = creates === 0 ? 1 : 0;
	for (let i = start; i < ops.length; i++) {
		const o = ops[i]!;
		const where = `ops[${i}] (${o.op})`;
		if (o.op === "get") continue;
		const d = doc!;
		if (isTerminal(d) && !(o.op === "status" && o.to === "open")) {
			throw new AlignError(`${where}: ${d.id} is ${d.phase}; move it back with {op: "status", to: "open"} first`);
		}
		switch (o.op) {
			case "add": {
				const fields = { findings: o.findings, approach: o.approach, rejected: o.rejected, questions: o.questions };
				need(Object.values(fields).some((v) => v !== undefined), `${where}: give findings, approach, rejected or questions`);
				const ids = addItems(d, {
					findings: o.findings === undefined ? [] : list(o.findings, `${where}: findings`, text),
					approach: o.approach === undefined ? [] : list(o.approach, `${where}: approach`, text),
					rejected: o.rejected === undefined ? [] : list(o.rejected, `${where}: rejected`, rejectedInput),
					questions: o.questions === undefined ? [] : list(o.questions, `${where}: questions`, questionInput),
				});
				need(ids.length > 0, `${where}: nothing to add (every list is empty)`);
				changes.push({ kind: "added", ids });
				break;
			}
			case "edit":
				changes.push({ kind: "edited", ids: editItem(d, o, where) });
				break;
			case "remove": {
				const ids = list(o.ids, `${where}: ids`, text);
				need(ids.length > 0, `${where}: ids must name at least one item`);
				for (const id of ids) {
					const kind = itemKind(id);
					need(kind === "f" || kind === "a" || kind === "x", `${where}: ${id} can't be removed (findings fN, approach aN and rejected xN only; drop a question instead)`);
					const key = kind === "f" ? "findings" : kind === "a" ? "approach" : "rejected";
					const before = d[key].length;
					(d as unknown as Record<string, { id: string }[]>)[key] = d[key].filter((item) => item.id !== id);
					need(d[key].length < before, `${where}: ${d.id} has no ${id}`);
				}
				changes.push({ kind: "removed", ids });
				break;
			}
			case "decide": {
				const q = findQuestion(d, o.q, where);
				need(!q.dropped, `${where}: ${q.id} is dropped; reopen it first`);
				q.decision = { text: oneLine(text(o.decision, `${where}: decision`)), by: "user", at: env.now };
				changes.push({ kind: "decided", q: q.id });
				break;
			}
			case "accept": {
				let targets: AlignQuestion[];
				if (o.q === "open") {
					targets = openQuestionsOf(d);
					need(targets.length > 0, `${where}: ${d.id} has no open questions to accept`);
				} else {
					const ids = typeof o.q === "string" ? [o.q] : list(o.q, `${where}: q`, text);
					need(ids.length > 0, `${where}: q must be "open" or question ids`);
					targets = ids.map((id) => findQuestion(d, id, where));
					for (const q of targets) need(!q.dropped, `${where}: ${q.id} is dropped; reopen it first`);
				}
				for (const q of targets) q.decision = { text: q.recommendation.choice, by: "accepted-recommendation", at: env.now };
				changes.push({ kind: "accepted", qs: targets.map((q) => q.id) });
				break;
			}
			case "reopen": {
				const q = findQuestion(d, o.q, where);
				need(q.decision !== undefined || q.dropped !== undefined, `${where}: ${q.id} is already open`);
				delete q.decision;
				delete q.dropped;
				changes.push({ kind: "reopened", q: q.id });
				break;
			}
			case "drop": {
				const why = oneLine(text(o.why, `${where}: why`));
				if (o.q === undefined) {
					d.phase = "dropped";
					d.droppedWhy = why;
					changes.push({ kind: "dropped" });
				} else {
					const q = findQuestion(d, o.q, where);
					need(!q.dropped, `${where}: ${q.id} is already dropped`);
					delete q.decision;
					q.dropped = { why, at: env.now };
					changes.push({ kind: "question-dropped", q: q.id });
				}
				break;
			}
			case "status": {
				const to = o.to;
				need(to === "implementing" || to === "done" || to === "open", `${where}: to must be implementing, done or open`);
				if (to !== "open") {
					const open = openQuestionsOf(d);
					need(
						open.length === 0,
						`${where}: ${d.id} still has ${open.length} open question${open.length === 1 ? "" : "s"} (${open.map((q) => q.id).join(", ")}): decide, accept or drop ${open.length === 1 ? "it" : "them"} earlier in the same call`,
					);
				}
				const phase: AlignPhase = to;
				need(d.phase !== phase, `${where}: ${d.id} is already ${to === "open" ? "open" : to}`);
				d.phase = phase;
				delete d.droppedWhy;
				changes.push({ kind: "status", to });
				break;
			}
		}
	}
	if (ops.some((o) => o.op === "get")) {
		if (doc) gets.push(doc);
		else gets.push(...openDocsOf(docs));
	}

	const changed = changes.length > 0;
	if (doc && changed && creates !== 0) {
		doc.rev += 1;
		doc.updatedAt = env.now;
	}
	const after = doc && changed ? upsert(docs, doc) : docs;
	const details: AlignDetails = { v: 1, changes, line: changeLine(changes) };
	if (doc && changed) details.doc = doc;
	const lines = doc ? echoLines(after, doc.id, changed ? details.line : "") : [gets.length === 0 ? "No open alignments on this branch." : ""];
	if (!doc) lines.push(...otherDocsLine(after, undefined));
	const body = gets.length > 0 ? `\n\n${gets.map(toMarkdown).join("\n\n---\n\n")}` : "";
	return { details, text: `${lines.filter((l) => l !== "").join("\n")}${body}`.trim() };
}

function editItem(d: AlignDocument, o: Record<string, unknown>, where: string): string[] {
	const fields = (keys: string[]) => keys.filter((k) => o[k] !== undefined);
	const allow = (keys: string[], what: string) => {
		const extra = fields(["title", "summary", "text", "option", "why", "topic", "ask", "context", "options", "recommendation"]).filter((k) => !keys.includes(k));
		need(extra.length === 0, `${where}: ${what} takes ${keys.join(", ")}, not ${extra.join(", ")}`);
		need(fields(keys).length > 0, `${where}: give at least one of ${keys.join(", ")}`);
	};
	if (o.id === undefined) {
		allow(["title", "summary"], "the document (no id)");
		const ids: string[] = [];
		if (o.title !== undefined) {
			d.title = oneLine(text(o.title, `${where}: title`));
			ids.push("title");
		}
		if (o.summary !== undefined) {
			d.summary = oneLine(text(o.summary, `${where}: summary`));
			ids.push("summary");
		}
		return ids;
	}
	const id = text(o.id, `${where}: id`);
	const kind = itemKind(id);
	need(kind !== undefined, `${where}: id must be an item id (fN, aN, xN or qN), or omitted for the title and summary`);
	if (kind === "f" || kind === "a") {
		allow(["text"], `${id}`);
		const item = (kind === "f" ? d.findings : d.approach).find((x) => x.id === id);
		need(item !== undefined, `${where}: ${d.id} has no ${id}`);
		item!.text = text(o.text, `${where}: text`);
		return [id];
	}
	if (kind === "x") {
		allow(["option", "why"], `${id}`);
		const item = d.rejected.find((x) => x.id === id);
		need(item !== undefined, `${where}: ${d.id} has no ${id}`);
		if (o.option !== undefined) item!.option = text(o.option, `${where}: option`);
		if (o.why !== undefined) item!.why = text(o.why, `${where}: why`);
		return [id];
	}
	allow(["topic", "ask", "context", "options", "recommendation"], `${id}`);
	const q = findQuestion(d, id, where);
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
	return [id];
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
	return q;
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
		if (!findings || !approach || !rejected || !questions) return undefined;
		if (v.phase !== "open" && v.phase !== "implementing" && v.phase !== "done" && v.phase !== "dropped") return undefined;
		const n = v.next;
		if (!isRecord(n) || !count(n.f) || !count(n.a) || !count(n.x) || !count(n.q)) return undefined;
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
			next: { f: n.f, a: n.a, x: n.x, q: n.q },
			rev: v.rev,
			createdAt: v.createdAt,
			updatedAt: v.updatedAt,
		};
		if (v.droppedWhy !== undefined) {
			if (!nonEmpty(v.droppedWhy)) return undefined;
			doc.droppedWhy = v.droppedWhy;
		}
		return doc;
	} catch {
		return undefined;
	}
}

const CHANGE_KINDS = new Set(["created", "added", "edited", "removed", "decided", "accepted", "reopened", "question-dropped", "status", "dropped"]);

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

function questionLine(q: AlignQuestion): string {
	return `  ${q.id} ${q.topic} — open (rec: ${q.recommendation.choice})`;
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
	return [...out, ...otherDocsLine(docs, id)];
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
			if (state === "open") lines.push(`  ${q.id} ${q.topic}: ${oneLine(q.ask)} (rec: ${q.recommendation.choice})`);
			else if (afterCompaction && state === "decided") lines.push(`  ${q.id} ${q.topic}: decided — ${oneLine(q.decision!.text)}`);
			else if (afterCompaction) lines.push(`  ${q.id} ${q.topic}: dropped — ${oneLine(q.dropped!.why)}`);
		}
		if (alignStatus(doc) === "implementing") lines.push("  (implementing: set status done when the work is finished and verified)");
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
		}
	}
	flush();
	return parts.join(" · ");
}

/** The whole document as markdown: `get`, `/align export`, the TUI viewer. */
export function toMarkdown(doc: AlignDocument): string {
	const out = [`## ${doc.id}: ${doc.title}`, "", `_${doc.summary}_`, "", `Status: ${alignStatusWord(alignStatus(doc))} · ${openText(doc)} · v${doc.rev}`];
	if (doc.phase === "dropped" && doc.droppedWhy) out.push(`Dropped: ${doc.droppedWhy}`);
	if (doc.questions.length > 0) {
		out.push("", "### Questions");
		for (const q of doc.questions) {
			const state = questionState(q);
			out.push("", `**${q.id} · ${q.topic}** (${state})`, "", q.ask);
			if (q.context) out.push("", q.context);
			if (q.options) out.push("", ...q.options.map((o) => `- **${o.label}** — ${o.tradeoff}`));
			out.push("", `Recommended: **${q.recommendation.choice}** — ${q.recommendation.why}`);
			if (q.decision) out.push("", `Decided: ${q.decision.text} (${q.decision.by === "user" ? "user" : "accepted recommendation"})`);
			if (q.dropped) out.push("", `Dropped: ${q.dropped.why}`);
		}
	}
	if (doc.findings.length > 0) out.push("", "### Findings", "", ...doc.findings.map((f) => `- ${f.id}: ${f.text}`));
	if (doc.approach.length > 0) out.push("", "### Approach", "", ...doc.approach.map((a, i) => `${i + 1}. ${a.id}: ${a.text}`));
	if (doc.rejected.length > 0) out.push("", "### Rejected", "", ...doc.rejected.map((x) => `- ${x.id}: ${x.option} — ${x.why}`));
	return out.join("\n");
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
const SPEC_TRAILER = /\n\s*Also changes:[^\n]*\s*$/i;
/** Words that ask the user to decide a design question or approve a plan. */
const DECISION_ASK =
	/\b(open questions?|questions for you|decisions? (?:for you|needed|to make)|need(?:s)? (?:your|a) (?:decision|call|answer)|should i (?:go ahead|proceed|start|build|implement)|shall i (?:go ahead|proceed|start)|(?:ok|okay) to (?:go ahead|proceed|start)|want me to (?:go ahead|proceed|start|build|implement)|which (?:one |option |approach )?(?:do|would) you (?:prefer|want|like|pick|choose)|your call|(?:take|with) my (?:suggested answers|recommendations?|recs)|go with (?:my|these|the) (?:recs|recommendations?|defaults?|answers?))\b/i;
/** A leftover alignment block in the old markdown shape. */
const MARKDOWN_ALIGNMENT = /^\s*(?:#{1,4}\s+|\*\*)alignment\b/im;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+\S/;

/**
 * A short line that labels what follows as the user's to decide ("**Questions for you:**", "Open
 * questions"), then a list with two or more questions: wherever it sits, since a reply can close on
 * a statement ("I'll record this once tools work.") after asking.
 */
function questionList(body: string): boolean {
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const label = lines[i]!.trim();
		if (label.length > 80 || LIST_ITEM.test(label) || !DECISION_ASK.test(label)) continue;
		let asks = 0;
		for (const line of lines.slice(i + 1)) {
			if (line.trim() === "") continue;
			if (LIST_ITEM.test(line)) {
				if (line.includes("?")) asks++;
			} else if (!/^\s/.test(line)) break;
		}
		if (asks >= 2) return true;
	}
	return false;
}

/**
 * Why a final reply reads like a plan that asks the user to decide, written in prose instead of
 * the tool — or null when it doesn't: an old markdown alignment block; a last paragraph that ends
 * in a question and either asks for a decision itself or follows a list of two or more items, with
 * decision words anywhere; or, wherever it sits, a labelled list of questions (questionList). Code
 * fences and the spec mode's "Also changes" line are ignored. Calibrated offline against two real
 * sessions (align.test.ts pins the shapes): it catches "…open questions, with my suggested
 * answers … Should I go ahead with those answers?" and leaves "Lanes B–F are still running." and
 * "Want me to merge it?" alone.
 */
export function planSignal(reply: string): "markdown-alignment" | "question-list" | "asks-decision" | "list-then-decision" | null {
	if (typeof reply !== "string") return null;
	const body = reply.replace(FENCED, " ").replace(SPEC_TRAILER, "").trim();
	if (MARKDOWN_ALIGNMENT.test(body)) return "markdown-alignment";
	const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
	const last = paragraphs[paragraphs.length - 1] ?? "";
	if (/\?\s*[*_)\]"'`]*\s*$/.test(last)) {
		if (DECISION_ASK.test(last)) return "asks-decision";
		const items = body.split("\n").filter((l) => LIST_ITEM.test(l)).length;
		if (items >= 2 && DECISION_ASK.test(body)) return "list-then-decision";
	}
	return questionList(body) ? "question-list" : null;
}

/** planSignal as a yes/no: the settle nudge's trigger. */
export const looksLikeUncapturedPlan = (reply: string): boolean => planSignal(reply) !== null;

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
