/**
 * The `align` tool: its model-facing description and parameter schema, and the execute that
 * applies a call to the branch's alignments (align.ts `applyAlignCall`) and returns the touched
 * document's snapshot as the result's `details`. The host (index.ts) owns the state and when the
 * tool is in the loadout (only while the align minor mode is on).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { ALIGN_FILE_MAX_BYTES, readAlignFile } from "./align-file.ts";
import { renderAlignCall, renderAlignResult } from "./align-ui.ts";
import {
	ALIGN_FILE_SCHEMA,
	ALIGN_OP_FIELDS,
	ALIGN_OPS,
	ALIGN_TOOL,
	AlignError,
	applyAlignCall,
	type AlignDetails,
	type AlignDocument,
	type AlignOpName,
} from "./align.ts";

export interface AlignToolHost {
	/** The branch's alignments now. */
	docs(): readonly AlignDocument[];
	/** A call changed a document: the host keeps the new snapshot and refreshes its UI. */
	changed(doc: AlignDocument): void;
	/** The session's target while its tools run remotely (the remote extension's announcement). */
	remoteTarget(): string | undefined;
}

export const ALIGN_TOOL_DESCRIPTION = `Record alignments with the user: one document per concern (id al_N) with a title, a one-line summary, findings (f1, f2…), approach steps (a1…), rejected alternatives (x1…) and questions for the user (q1…), each question carrying your recommendation. Ids are assigned in order and never change or get reused.

A call applies its ops in order to ONE alignment, atomically: if any op is invalid nothing changes and the error says why. To change an existing alignment pass doc ("al_2"); it is required while more than one is open. Each op takes only the fields its schema lists. The result lists the alignment's open questions.

The user's answers: decide each question they answered, in their words; accept only the questions they told you to take your recommendation on (accept_all only when they said it for every open one); leave every other question open. Never set status implementing while a question is open.

Example: start one.
{"ops": [{"op": "create", "title": "Nightly export", "summary": "Export orders to the warehouse each night.", "findings": ["Orders table has 40M rows"], "approach": ["Add an export job", "Upload to S3"], "questions": [{"topic": "Format", "ask": "CSV or Parquet?", "options": [{"label": "CSV", "tradeoff": "readable, large"}, {"label": "Parquet", "tradeoff": "compact, needs tooling"}], "recommendation": {"choice": "Parquet", "why": "the warehouse reads it natively"}}]}]}

Example: the user replied "q2: weekly is fine; take your rec on q4", and asked to upload to GCS instead. q1 and q3 stay open.
{"doc": "al_3", "ops": [{"op": "decide", "q": "q2", "decision": "Weekly"}, {"op": "accept", "qs": ["q4"]}, {"op": "edit", "id": "a2", "text": "Upload to GCS"}]}`;

export const ALIGN_TOOL_GUIDELINES = [
	"While the align minor mode is on, record every alignment (a plan, open questions, decisions the user must make) with the align tool — never as reply text or a numbered list in prose; the user reads the alignment card, so keep the reply to a sentence or two.",
	"Record the user's answers by question id (\"3a\" is q3's option a: decide it with that option's label): decide the ones they answered, in their words; accept only the ones they told you to take your recommendation on (accept_all only when they said it for every open question); leave the rest open. Change an alignment only with ops; never create it again.",
	"When a planning worker wrote the alignment as a JSON file, use import with the file's absolute path; never retype its plan.",
	"Set status implementing before building, never while a question is open, and done when finished and verified; use exempt with a reason for a work request that needs no alignment.",
];

export const ALIGN_PROMPT_SNIPPET = "Record alignments with the user (plans, open questions, decisions) as structured documents";

// The schema: one branch per op, its fields exactly ALIGN_OP_FIELDS (required ones required), so a
// provider's own schema check already names a missing or unknown field.
const S = (description?: string, extra: Record<string, unknown> = {}) => Type.String({ minLength: 1, ...(description ? { description } : {}), ...extra });
const Strict = { additionalProperties: false } as const;

const QID = S('A question id, e.g. "q3".', { pattern: "^q[1-9][0-9]*$" });
const Option = Type.Object({ label: S("The choice, short."), tradeoff: S("What it costs and what it buys.") }, Strict);
const Recommendation = Type.Object(
	{ choice: S("The answer you recommend (one of the options' labels when there are options)."), why: S("Why, in a sentence.") },
	{ ...Strict, description: "Your recommended answer. Required: the user can accept it as is." },
);
const Question = Type.Object(
	{
		topic: S('Short label, e.g. "Counter store".'),
		ask: S("The question to the user, one sentence."),
		context: Type.Optional(S("What the user needs to know to answer it (optional).")),
		options: Type.Optional(Type.Array(Option, { description: "The real choices, each with its trade-off (optional)." })),
		recommendation: Recommendation,
	},
	Strict,
);
const Rejected = Type.Object({ option: S("The alternative you considered."), why: S("Why not.") }, Strict);
const ITEMS = {
	findings: Type.Array(S(), { description: "Facts you established that shape the plan; each becomes fN." }),
	approach: Type.Array(S(), { description: "The plan's steps, in order; each becomes aN." }),
	rejected: Type.Array(Rejected, { description: "Alternatives you ruled out; each becomes xN." }),
	questions: Type.Array(Question, { description: "Decisions the user must make; each becomes qN." }),
};

/** Each op's field schemas; which are required comes from ALIGN_OP_FIELDS. */
const OP_SCHEMAS: Record<AlignOpName, { description: string; fields: Record<string, TSchema> }> = {
	create: {
		description: "Start a new alignment (al_N) from the fields given here.",
		fields: { title: S('Short name of the concern, e.g. "API rate limiting".'), summary: S("One line: what the concern is about."), ...ITEMS },
	},
	import: {
		description: "Start a new alignment from a JSON file a planning worker wrote. Never retype its content.",
		fields: {
			path: S(
				`Absolute path of the JSON file (the worker writes it outside the repo, e.g. under ~/.cache). A regular file up to ${ALIGN_FILE_MAX_BYTES / 1024} KB, holding exactly: ${ALIGN_FILE_SCHEMA}. Unknown keys are rejected. Refused in a remote session (tools on a target): there, use create with the file's fields.`,
			),
		},
	},
	add: { description: "Append items to the alignment; they get the next free ids. Give at least one list.", fields: ITEMS },
	edit: {
		description: "Replace the text of a finding (fN) or an approach step (aN).",
		fields: { id: S('The finding or step, e.g. "a2".', { pattern: "^[fa][1-9][0-9]*$" }), text: S("Its complete new text (the whole item, not a diff).") },
	},
	edit_question: {
		description: "Change fields of a question; omitted fields stay. Does not decide it.",
		fields: {
			q: QID,
			topic: S(),
			ask: S(),
			context: Type.String({ description: 'New context; "" removes it.' }),
			options: Type.Array(Option, { description: "Replaces all options; [] removes them." }),
			recommendation: Recommendation,
		},
	},
	edit_rejected: {
		description: "Change a rejected alternative (xN).",
		fields: { id: S('e.g. "x1".', { pattern: "^x[1-9][0-9]*$" }), option: S(), why: S("Why it was rejected.") },
	},
	edit_doc: { description: "Change the alignment's title and/or summary.", fields: { title: S(), summary: S() } },
	remove: {
		description: "Delete findings, approach steps or rejected alternatives. Questions are dropped instead (drop_question).",
		fields: { ids: Type.Array(S(undefined, { pattern: "^[fax][1-9][0-9]*$" }), { description: 'e.g. ["f2", "a4"].', minItems: 1 }) },
	},
	decide: {
		description: "Record the user's own answer to one question, in their words. Only a question the user answered.",
		fields: { q: QID, decision: S('The user\'s answer, e.g. "Yes, backfill existing rows".') },
	},
	accept: {
		description: "The user told you to take your recommendation for exactly these questions. Only those: one they answered is decide, one they didn't mention stays open.",
		fields: { qs: Type.Array(QID, { description: 'Question ids, e.g. ["q1", "q3"].', minItems: 1 }) },
	},
	accept_all: {
		description: 'The user told you to take your recommendation for every question still open ("your recs for all", or a go-ahead while questions are open). Not when they answered or named only some.',
		fields: {},
	},
	reopen: { description: "Make a decided or dropped question open again.", fields: { q: QID } },
	drop_question: { description: "Withdraw one question that no longer applies.", fields: { q: QID, reason: S("Why it no longer applies.") } },
	drop_alignment: { description: "Abandon the whole alignment.", fields: { reason: S("Why it is abandoned.") } },
	status: {
		description: "Move the alignment's lifecycle.",
		fields: {
			to: StringEnum(["implementing", "done", "open"] as const, {
				description:
					'"implementing" when you start building, never while a question is open (each decided, accepted or dropped first, possibly earlier in this call); "done" when the work is finished and verified; "open" to reopen a done or dropped alignment.',
			}),
		},
	},
	exempt: {
		description: "Record that the user's request needs no alignment (a trivial or mechanical change). Must be the only op in its call; no doc.",
		fields: { reason: S("Why no alignment is needed.") },
	},
	get: { description: "Return the alignment as markdown (every open one when there is no doc).", fields: {} },
};

function opSchema(name: AlignOpName) {
	const { description, fields } = OP_SCHEMAS[name];
	const { required, atLeast } = ALIGN_OP_FIELDS[name];
	const properties: Record<string, TSchema> = { op: Type.Literal(name) };
	for (const [key, schema] of Object.entries(fields)) properties[key] = required.includes(key) ? schema : Type.Optional(schema);
	// minProperties counts op itself: the required fields, plus atLeast of the optional ones.
	return Type.Object(properties, { ...Strict, description, ...(atLeast ? { minProperties: 1 + required.length + atLeast } : {}) });
}

export const ALIGN_PARAMETERS = Type.Object(
	{
		doc: Type.Optional(
			S('The alignment to change, e.g. "al_2". Required while more than one alignment is open; omit for create, import and exempt.', { pattern: "^al_[1-9][0-9]*$" }),
		),
		ops: Type.Array(Type.Union(ALIGN_OPS.map(opSchema)), { description: "Operations, applied in order. create or import must come first and appear once.", minItems: 1 }),
	},
	Strict,
);

export function registerAlignTool(pi: ExtensionAPI, host: AlignToolHost): void {
	pi.registerTool({
		name: ALIGN_TOOL,
		label: "Align",
		description: ALIGN_TOOL_DESCRIPTION,
		promptSnippet: ALIGN_PROMPT_SNIPPET,
		promptGuidelines: ALIGN_TOOL_GUIDELINES,
		parameters: ALIGN_PARAMETERS,
		// The state is shared: calls in one message apply one after another.
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			try {
				const outcome = applyAlignCall(host.docs(), params, {
					now: new Date().toISOString(),
					readFile: (path) => readAlignFile(ctx.cwd, path, host.remoteTarget()),
				});
				if (outcome.details.doc) host.changed(outcome.details.doc);
				return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details as AlignDetails };
			} catch (error) {
				if (error instanceof AlignError) throw new Error(`${error.message}. Nothing was changed.`);
				throw error;
			}
		},
		renderCall: (args, theme) => renderAlignCall(args, theme),
		renderResult: (result, options, theme) => renderAlignResult(result, options.expanded, theme),
	});
}
