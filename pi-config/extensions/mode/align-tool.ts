/**
 * The `align` tool: its model-facing description and parameter schema, and the execute that
 * applies a call to the branch's alignments (align.ts `applyAlignCall`) and returns the touched
 * document's snapshot as the result's `details`. The host (index.ts) owns the state and when the
 * tool is in the loadout (only while the align minor mode is on).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderAlignCall, renderAlignResult } from "./align-ui.ts";
import { ALIGN_FILE_SCHEMA, ALIGN_OPS, ALIGN_TOOL, AlignError, applyAlignCall, type AlignDetails, type AlignDocument } from "./align.ts";

export interface AlignToolHost {
	/** The branch's alignments now. */
	docs(): readonly AlignDocument[];
	/** A call changed a document: the host keeps the new snapshot and refreshes its UI. */
	changed(doc: AlignDocument): void;
}

export const ALIGN_TOOL_DESCRIPTION = `Record and update alignments with the user: structured documents of what to build, one per concern, each with an id al_N. Several can be open at once. One call = one document, a batch of ops applied atomically (one bad op fails the call and changes nothing).
Ops:
- create {title, summary, findings?, approach?, rejected?, questions?} starts al_N. questions: [{topic, ask, context?, options?: [{label, tradeoff}], recommendation: {choice, why}}]; rejected: [{option, why}].
- create {fromFile: "path.json"} imports the same document from a JSON file (relative to the cwd), validated strictly. Schema: ${ALIGN_FILE_SCHEMA}
- add {findings?, approach?, rejected?, questions?}; edit {id: "q3"|"f2"|"a1"|"x1", fields…} or {title?, summary?} without id; remove {ids: ["f2"]} (findings, approach, rejected only).
- decide {q: "q3", decision: "the user's answer"}; accept {q: "open" | ["q1","q4"]} takes your recommendation as the decision; reopen {q}; drop {q, why} drops a question, drop {why} drops the whole alignment.
- status {to: "implementing" | "done" | "open"}: implementing before you build (no open questions left), done when finished and verified.
- exempt {why}, alone in a call: record that a work request needs no alignment.
- get: the document as markdown (all open ones without doc).
Pass doc: "al_N" to change an existing alignment (required while more than one is open). Ids (qN, fN, aN, xN) never change or get reused. The result lists what is still open.`;

export const ALIGN_TOOL_GUIDELINES = [
	"While the align minor mode is on, record every alignment (a plan, open questions, decisions the user must make) with the align tool — never as reply text or a numbered list in prose; the user reads the alignment card, so keep the reply to a sentence or two.",
	"Record the user's answers with align decide or accept (by question id) and change alignments only with ops; never re-create one to change it.",
	"A planning worker writes the alignment as a JSON file for align create with fromFile; never retype its plan.",
	"Set align status implementing before building and done when finished; use align exempt {why} for a work request that needs no alignment.",
];

const Text = Type.String();
const Question = Type.Object({
	topic: Type.String({ description: "Short label, e.g. \"Pace limit\"." }),
	ask: Type.String({ description: "The question to the user." }),
	context: Type.Optional(Type.String({ description: "What the user needs to know to answer it." })),
	options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), tradeoff: Type.String() }), { description: "The real choices, each with its trade-off." })),
	recommendation: Type.Object({ choice: Type.String(), why: Type.String() }, { description: "Your recommended answer and why." }),
});
const Rejected = Type.Object({ option: Type.String(), why: Type.String() });

export const ALIGN_PARAMETERS = Type.Object(
	{
		doc: Type.Optional(Type.String({ description: "The alignment to change (al_N). Required while more than one is open; ignored by create." })),
		ops: Type.Array(
			Type.Object({
				op: StringEnum(ALIGN_OPS),
				title: Type.Optional(Text),
				summary: Type.Optional(Type.String({ description: "One line: what the concern is about." })),
				fromFile: Type.Optional(Type.String({ description: "create: a JSON file holding the document." })),
				findings: Type.Optional(Type.Array(Text)),
				approach: Type.Optional(Type.Array(Text, { description: "Steps, in order." })),
				rejected: Type.Optional(Type.Array(Rejected)),
				questions: Type.Optional(Type.Array(Question)),
				id: Type.Optional(Type.String({ description: "edit: the item (q3, f2, a1, x1); omit to edit title/summary." })),
				text: Type.Optional(Type.String({ description: "edit: a finding's or approach step's new text." })),
				topic: Type.Optional(Text),
				ask: Type.Optional(Text),
				context: Type.Optional(Type.String({ description: "edit: new context (\"\" clears it)." })),
				options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), tradeoff: Type.String() }))),
				recommendation: Type.Optional(Type.Object({ choice: Type.String(), why: Type.String() })),
				option: Type.Optional(Type.String({ description: "edit: a rejected alternative's option." })),
				why: Type.Optional(Type.String({ description: "drop / exempt: the reason; edit: a rejected alternative's why." })),
				ids: Type.Optional(Type.Array(Text, { description: "remove: item ids." })),
				q: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "A question id (q3); accept also takes \"open\" or a list." })),
				decision: Type.Optional(Type.String({ description: "decide: the user's answer, in their terms." })),
				to: Type.Optional(StringEnum(["implementing", "done", "open"] as const)),
			}),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

export function registerAlignTool(pi: ExtensionAPI, host: AlignToolHost): void {
	pi.registerTool({
		name: ALIGN_TOOL,
		label: "Align",
		description: ALIGN_TOOL_DESCRIPTION,
		promptSnippet: "Record alignments with the user (plans, open questions, decisions) as structured documents",
		promptGuidelines: ALIGN_TOOL_GUIDELINES,
		parameters: ALIGN_PARAMETERS,
		// The state is shared: calls in one message apply one after another.
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			try {
				const outcome = applyAlignCall(host.docs(), params, {
					now: new Date().toISOString(),
					readFile: (path) => readFileSync(resolve(ctx.cwd, path), "utf8"),
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
