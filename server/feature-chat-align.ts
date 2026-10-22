import type { HEntry, ToolCtx, ToolSpec } from "../shared/harness";
import {
  ALIGN_OP_FIELDS,
  ALIGN_TOOL,
  ALIGN_VISUAL_FIELDS,
  ALIGN_VISUALS_MAX,
  AlignError,
  applyAlignCall,
  foldAlignments,
  type AlignDetails,
  type AlignDocument,
  type AlignOpName,
} from "../pi-config/extensions/mode/align.ts";

/**
 * A feature request chat's `align` (§app.project-assistant/feature-chats), served by Sova: the align tool's
 * operations on the shared document model (pi-config/extensions/mode/align.ts, pure, node builtins only), as
 * sova_card clones it for the overseers. Never pi-config's align-tool.ts (it reaches pi). Its own set:
 *  - no `import` (no file access), no `status` (nothing is implemented here), no `exempt`, no review ops;
 *  - no `technical` field anywhere: not in the schema, and a call that carries one is refused (the plan card's
 *    projection leaves it out too, server/baton-view.ts);
 *  - visuals on (§chat.alignment/visuals), in the Project manager style (the prompt says so).
 * Its result's `details` is the touched document's snapshot, the plan card the owner page draws.
 */

export const FEATURE_ALIGN_OPS = ["create", "add", "edit", "edit_question", "edit_rejected", "edit_doc", "remove", "decide", "accept", "accept_all", "reopen", "drop_question", "drop_alignment", "get"] as const satisfies readonly AlignOpName[];

const NO_TECHNICAL = "Plans here have no technical notes: say it in the plan's own words (what changes on screen, in the flow or in what is kept), or leave it out.";

const S = (description?: string, extra: Record<string, unknown> = {}) => ({ type: "string", minLength: 1, ...(description ? { description } : {}), ...extra });
const strict = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: "object", properties, required, additionalProperties: false, ...extra });
const arr = (items: unknown, description: string, extra: Record<string, unknown> = {}) => ({ type: "array", items, description, ...extra });

const QID = S('A question id, e.g. "q3".', { pattern: "^q[1-9][0-9]*$" });
const option = strict({ label: S("The choice, short."), tradeoff: S("What it costs and what it buys, for the person.") }, ["label", "tradeoff"]);
const recommendation = strict({ choice: S("The answer you recommend (one of the options' labels when there are options)."), why: S("Why, in a sentence.") }, ["choice", "why"], { description: "Your recommended answer. Required: the person can accept it as is." });
const visual = strict(
  {
    kind: S('The vis kind: "wireframe", "flow", "state", "steps", "chart", "timeline", "matrix", "sequence" or "html" (a clickable prototype).', { pattern: "^[a-z]+$" }),
    source: S("The drawing's source, exactly what the vis fence's body would be."),
  },
  ["kind", "source"],
  { description: `A drawing on the plan, only when it explains faster than words; at most ${ALIGN_VISUALS_MAX} per plan.` },
);
const question = strict(
  {
    topic: S('Short label, e.g. "Who can book".'),
    ask: S("The question to the person, one sentence."),
    context: S("What they need to know to answer it (optional)."),
    options: arr(option, "The real choices, each with its trade-off (optional)."),
    recommendation,
    visual,
  },
  ["topic", "ask", "recommendation"],
);
const rejected = strict({ option: S("The alternative you considered."), why: S("Why not.") }, ["option", "why"]);
const items = {
  findings: arr(S(), "What you found about how the project works today that shapes the plan; each becomes fN."),
  approach: arr(S(), "The plan's steps, in order, in words the person uses; each becomes aN."),
  rejected: arr(rejected, "Alternatives you ruled out; each becomes xN."),
  questions: arr(question, "Decisions the person must make; each becomes qN."),
};

const OP_FIELDS: Record<(typeof FEATURE_ALIGN_OPS)[number], { description: string; fields: Record<string, unknown> }> = {
  create: { description: "Start a new plan (al_N).", fields: { title: S('Short name of what they want, e.g. "Online booking".'), summary: S("One line: what it is about."), ...items } },
  add: { description: "Append items to the plan; give at least one list.", fields: items },
  edit: { description: "Replace the text of a finding (fN) or a step (aN).", fields: { id: S('e.g. "a2".', { pattern: "^[fa][1-9][0-9]*$" }), text: S("Its complete new text.") } },
  edit_question: {
    description: "Change fields of a question; omitted fields stay. Does not decide it.",
    fields: { q: QID, topic: S(), ask: S(), context: { type: "string", description: 'New context; "" removes it.' }, options: arr(option, "Replaces all options; [] removes them."), recommendation },
  },
  edit_rejected: { description: "Change a ruled-out alternative (xN).", fields: { id: S('e.g. "x1".', { pattern: "^x[1-9][0-9]*$" }), option: S(), why: S() } },
  edit_doc: { description: "Change the plan's title and/or summary.", fields: { title: S(), summary: S() } },
  remove: { description: "Delete findings, steps or ruled-out alternatives. Questions are dropped instead (drop_question).", fields: { ids: arr(S(undefined, { pattern: "^[fax][1-9][0-9]*$" }), 'e.g. ["f2", "a4"].', { minItems: 1 }) } },
  decide: { description: "Record the person's own answer to one question, in their words.", fields: { q: QID, decision: S("Their answer.") } },
  accept: { description: "They told you to take your recommendation for exactly these questions.", fields: { qs: arr(QID, 'e.g. ["q1", "q3"].', { minItems: 1 }) } },
  accept_all: { description: "They told you to take your recommendation for every question still open.", fields: {} },
  reopen: { description: "Make a decided or dropped question open again.", fields: { q: QID } },
  drop_question: { description: "Withdraw one question that no longer applies.", fields: { q: QID, reason: S("Why it no longer applies.") } },
  drop_alignment: { description: "Abandon the whole plan.", fields: { reason: S("Why it is abandoned.") } },
  get: { description: "Return the plan as text (every open one when there is no doc).", fields: {} },
};

const VISUAL_FIELD: Record<string, unknown> = {
  create: visual,
  edit_question: { anyOf: [visual, { type: "null" }], description: "The question's drawing; null removes it." },
  edit_doc: { anyOf: [visual, { type: "null" }], description: "The plan's own drawing, under its summary; null removes it." },
};

function opSchema(name: (typeof FEATURE_ALIGN_OPS)[number]) {
  const { description, fields } = OP_FIELDS[name];
  const { required, atLeast } = ALIGN_OP_FIELDS[name];
  const properties: Record<string, unknown> = { op: { type: "string", const: name } };
  for (const [k, v] of Object.entries(fields)) properties[k] = v;
  for (const k of ALIGN_VISUAL_FIELDS[name] ?? []) properties[k] = VISUAL_FIELD[name];
  return strict(properties, ["op", ...required], { description, ...(atLeast ? { minProperties: 1 + required.length + atLeast } : {}) });
}

export const FEATURE_ALIGN_PARAMETERS = strict(
  {
    doc: S('The plan to change, e.g. "al_2". Required while more than one plan is open; omit for create.', { pattern: "^al_[1-9][0-9]*$" }),
    ops: arr({ anyOf: FEATURE_ALIGN_OPS.map(opSchema) }, "Operations on one plan, applied in order. create must come first and appear once.", { minItems: 1 }),
  },
  ["ops"],
);

/** Whether a call carries a technical note anywhere (a create's or add's `technical`, an edit of a tN). */
export function carriesTechnical(params: unknown): boolean {
  const ops = (params as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) return false;
  return ops.some((o) => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    if (r.technical !== undefined) return true;
    if (r.op === "edit" && typeof r.id === "string" && /^t\d/.test(r.id)) return true;
    if (r.op === "remove" && Array.isArray(r.ids) && r.ids.some((x) => typeof x === "string" && /^t\d/.test(x))) return true;
    return false;
  });
}

/** The branch's plans, folded with the align extension's own fold. */
export function plansOf(branch: readonly HEntry[], extra: readonly AlignDetails[] = []): AlignDocument[] {
  const entries: unknown[] = [];
  for (const h of branch)
    if (h.kind === "tool-result" && h.tool === ALIGN_TOOL) entries.push({ type: "message", message: { role: "toolResult", toolName: ALIGN_TOOL, isError: h.isError === true, details: h.details } });
  for (const d of extra) entries.push({ type: "message", message: { role: "toolResult", toolName: ALIGN_TOOL, isError: false, details: d } });
  return foldAlignments(entries).docs;
}

const PENDING_MS = 10 * 60_000;

/** The served tool, for one session. `branch`: the session's branch when the call's context has none (tests). */
export function featureAlignTool(branch?: () => readonly HEntry[]): ToolSpec {
  // Results the branch doesn't show yet (a later call in the same batch).
  const pending = new Map<string, { details: AlignDetails; at: number }>();
  const docsNow = (ctx: ToolCtx | undefined): AlignDocument[] => {
    const b = ctx?.branch() ?? branch?.() ?? [];
    const seen = new Set<string>();
    for (const e of b) if (e.kind === "tool-result" && e.tool === ALIGN_TOOL && e.callId) seen.add(e.callId);
    const now = Date.now();
    for (const [id, p] of pending) if (seen.has(id) || now - p.at > PENDING_MS) pending.delete(id);
    return plansOf(b, [...pending.values()].map((p) => p.details));
  };
  return {
    // The align tool's own name (ALIGN_TOOL), spelled out for the commands inventory's scan.
    name: "align",
    label: "Plan",
    exposure: "model-only",
    description:
      "Keep the plans you agree with the person: one plan per need (id al_N) with a title, a one-line summary, what you found (f1…), the plan's steps (a1…), what was ruled out (x1…) and questions for them (q1…), each with your recommendation. They see each plan as a card and answer its questions there; their answers arrive as ordinary messages. Never record an answer they didn't give.",
    promptSnippet: "align: keep the plan you agree with the person, as a card they answer",
    parameters: FEATURE_ALIGN_PARAMETERS,
    executionMode: "sequential",
    async execute(toolCallId: string, params: unknown, _signal?: AbortSignal, _update?: unknown, ctx?: ToolCtx) {
      if (carriesTechnical(params)) throw new Error(`${NO_TECHNICAL} Nothing was changed.`);
      const op = Array.isArray((params as { ops?: unknown })?.ops) ? ((params as { ops: { op?: unknown }[] }).ops.find((o) => o && !(FEATURE_ALIGN_OPS as readonly unknown[]).includes(o.op))?.op ?? null) : null;
      if (op !== null) throw new Error(`ops: "${String(op)}" is not available here; use one of ${FEATURE_ALIGN_OPS.join(", ")}. Nothing was changed.`);
      try {
        const outcome = applyAlignCall(docsNow(ctx), params, {
          now: new Date().toISOString(),
          readFile: () => {
            throw new AlignError("there is no file access here");
          },
          visuals: true,
          style: "pm",
        });
        if (outcome.details.doc) pending.set(toolCallId, { details: outcome.details, at: Date.now() });
        return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
      } catch (err) {
        if (err instanceof AlignError) throw new Error(`${err.message}. Nothing was changed.`);
        throw err;
      }
    },
  } as ToolSpec;
}
