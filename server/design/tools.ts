// The tools Sova serves for Design mode. The main chat's: `design_guide` (the mode's reference text)
// and `design` (put up a Setup card, read the coordinator's card or one page, pass words on). A design
// session's: `design_stream` (the page, whole or as edits) and `design_hand_in` (it is done).
import type { ToolResult, ToolSpec } from "../../shared/harness";
import { DESIGN_ASK_ABOVE, DESIGN_BATCH_MAX, DESIGN_TOOL, isDesignLabel, type DesignNote } from "../../shared/design";
import { DESIGN_GUIDE_TOPICS, designGuide } from "../../pi-config/extensions/mode/design-guide.ts";
import { coordinatorCard, tellCoordinator } from "./coordinator";
import { createRun } from "./setup";
import { DESIGN_HAND_IN_TOOL, handIn, pageProblem, refusedPage, replyPageThisTurn, savePage, takeLook, type DesignParent } from "./batch";
import { livePage } from "./live";
import { lookAtDesign } from "./look";
import type { TourSize } from "../../shared/tour";
import { designOf, pendingPage, readPage, viewOf } from "./store";
import { applyEdits, type Edit } from "./edits";

export { applyEdits };

export const DESIGN_GUIDE_TOOL = "design_guide";
export const DESIGN_STREAM_TOOL = "design_stream";
export { DESIGN_HAND_IN_TOOL };
export const DESIGN_LOOK_TOOL = "design_look";
/** The main chat's tools: active only while Design mode is on. */
export const DESIGN_TOOLS: ReadonlySet<string> = new Set([DESIGN_GUIDE_TOOL, DESIGN_TOOL]);

const say = (text: string, details: unknown = {}): ToolResult => ({ content: [{ type: "text", text }], details });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

/** The main chat's Design tools. Nothing they do starts a turn or writes to its context beyond their own results. */
export function mainDesignTools(parent: () => DesignParent, cwd: () => string): ToolSpec[] {
  return [
    {
      name: DESIGN_GUIDE_TOOL,
      label: "design guide",
      description: "The Design mode reference. No topic: the list of topics.",
      parameters: { type: "object", properties: { topic: str("The topic to read.", { enum: [...DESIGN_GUIDE_TOPICS] }) } },
      async execute(_id, params: { topic?: string }) {
        return say(designGuide(params?.topic));
      },
    },
    {
      name: "design",
      label: "design",
      description: `Design mode's prototypes. op "start" puts a Setup card in the chat (the user finishes it there, up to ${DESIGN_BATCH_MAX} designs). op "read" gets the coordinator's card, or one design's whole page with label. op "tell" passes text word for word to the coordinator. Read design_guide first.`,
      parameters: {
        type: "object",
        properties: {
          op: str("What to do.", { enum: ["start", "read", "tell"] }),
          brief: str("start: what to design, in the user's words."),
          models: list("start: particular models the user named, as provider/modelId."),
          modelGroups: list('start: whole groups the user named, such as "ollama-cloud" or "claude".'),
          directions: list("start: direction names the user named."),
          coordinator: str("start: the model id to coordinate, only when the user named one."),
          label: str("read: a design's label, for its whole page."),
          text: str("tell: the words to pass on, exactly as the user said them."),
        },
        required: ["op"],
      },
      async execute(toolCallId, params: { op?: string; brief?: string; models?: string[]; modelGroups?: string[]; directions?: string[]; coordinator?: string; label?: string; text?: string }) {
        const p = parent();
        if (params?.op === "start") {
          const run = await createRun(p, cwd(), params);
          const picked = run.setup.models.filter((m) => m.design).length;
          return say(`The Setup card is on screen (run ${run.id}${picked ? `, ${picked} models ticked` : ""}). The user finishes it there and starts the run; above ${DESIGN_ASK_ABOVE} designs Sova asks them first. Nothing more is needed from you, and nothing about it will reach you.`, { designCard: { runId: run.id } });
        }
        if (params?.op === "read") {
          if (params.label) {
            if (!isDesignLabel(params.label) || !designOf(p.sessionId, params.label)) throw new Error(`No design ${params.label} in this chat.`);
            const page = readPage(p.sessionId, params.label);
            if (!page) throw new Error(`Design ${params.label} has no finished page yet.`);
            return say(page);
          }
          const card = coordinatorCard(p.sessionId);
          const lines = viewOf(p.sessionId).designs.map((d) => `${d.label} · ${d.direction} · ${d.model} · ${d.status}`);
          return say([card?.card || "The coordinator has no card yet.", lines.length ? `Designs:\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n"));
        }
        if (params?.op === "tell") {
          if (!params.text?.trim()) throw new Error("tell needs the text to pass on.");
          await tellCoordinator(p, params.text, `tell:${toolCallId}`);
          return say("Passed on.");
        }
        throw new Error('op must be "start", "read" or "tell".');
      },
    },
  ];
}

const noteOf = (v: unknown): DesignNote | null => {
  const n = v as Partial<Record<keyof DesignNote, unknown>> | null | undefined;
  const ok = (x: unknown): x is string => typeof x === "string" && !!x.trim();
  return n && ok(n.layout) && ok(n.sections) && ok(n.type) && ok(n.color) ? { layout: n.layout, sections: n.sections, type: n.type, color: n.color } : null;
};

/** A design session's tools, bound to the design it was started for. A model that can't stream tool arguments
    isn't offered `design_stream`: a page sent that way would arrive whole at the end, and its reply is how the
    user watches it being written. */
export function sessionDesignTools(parent: DesignParent, label: string): ToolSpec[] {
  const tools = allSessionTools(parent, label);
  return designOf(parent.sessionId, label)?.route === "reply" ? tools.filter((t) => t.name !== DESIGN_STREAM_TOOL) : tools;
}

function allSessionTools(parent: DesignParent, label: string): ToolSpec[] {
  const own = (asked: unknown): void => {
    if (asked !== label) throw new Error(`You are design ${label}; label must be ${label}.`);
  };
  return [
    {
      name: DESIGN_LOOK_TOOL,
      label: "design look",
      description: "Open your finished page in a real browser at a width and see it: 1440 for desktop, 390 for phone.",
      parameters: { type: "object", properties: { label: str("Your label."), width: { type: "number", description: "The viewport width: 1440 or 390." } }, required: ["label", "width"] },
      async execute(_id, params: { label?: string; width?: number }) {
        own(params?.label);
        const size: TourSize = (params.width ?? 1440) < 768 ? "phone" : "desktop";
        takeLook(parent.sessionId, label);
        const d = designOf(parent.sessionId, label);
        const look = await lookAtDesign(parent, label, { sizes: [size] });
        const images = d?.vision ? look.shots.map((s) => ({ type: "image" as const, data: Buffer.from(s.png).toString("base64"), mimeType: "image/png" })) : [];
        return { content: [...images, { type: "text", text: d?.vision ? `Your page at ${size} width.` : `An outline of your page at ${size} width (this model can't read images):\n${look.outline}` }], details: {} };
      },
    },
    {
      name: DESIGN_STREAM_TOOL,
      label: "design stream",
      description: "Write your page: html is the complete document, in one call; or edits, a list of exact find-and-replace pairs on your current page.",
      parameters: {
        type: "object",
        properties: {
          label: str("Your label."),
          html: str("The complete HTML document."),
          edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] }, description: "Find-and-replace pairs, each matching exactly once, instead of html." },
        },
        required: ["label"],
      },
      async execute(_id, params: { label?: string; html?: string; edits?: Edit[] }) {
        own(params?.label);
        let html = params.html;
        if (html === undefined) {
          if (!params.edits?.length) throw new Error("Send html, or edits.");
          const current = pendingPage(parent.sessionId, label) ?? readPage(parent.sessionId, label);
          if (!current) throw new Error("You have no page to edit yet; send html.");
          const out = applyEdits(current, params.edits);
          if ("error" in out) throw new Error(out.error);
          html = out.html;
        }
        const problem = pageProblem(html);
        if (problem) refusedPage(parent, label, problem);
        savePage(parent, label, html);
        return say("Saved. Now call design_hand_in, then stop: the user is looking at your page.");
      },
    },
    {
      name: "design_hand_in",
      label: "design hand in",
      description: "Finish your page. note says what you made, for the people choosing between designs. Your last tool call for this page.",
      parameters: {
        type: "object",
        properties: {
          label: str("Your label."),
          note: {
            type: "object",
            properties: { layout: { type: "string" }, sections: { type: "string" }, type: { type: "string", description: "The typography." }, color: { type: "string" } },
            required: ["layout", "sections", "type", "color"],
          },
        },
        required: ["label", "note"],
      },
      async execute(_id, params: { label?: string; note?: unknown }, _signal, _update, ctx) {
        own(params?.label);
        const note = noteOf(params.note);
        if (!note) throw new Error("note needs layout, sections, type and color.");
        let html = pendingPage(parent.sessionId, label);
        if (html === null) {
          // A reply-route model: the page stands between its markers in a reply of this turn, not always this call's.
          html = ctx ? replyPageThisTurn(ctx.branch()) : null;
          if (html === null) html = livePage(parent.sessionId, label)?.text ?? null;
        }
        if (html === null) throw new Error("You have no page to hand in yet.");
        const problem = pageProblem(html);
        if (problem) refusedPage(parent, label, problem);
        const v = handIn(parent, label, html, note);
        return say(`Handed in as version ${v.n}. Stop now.`, { label, version: v.n });
      },
    },
  ];
}

/** The label a design worker's id names, when it is one. */
export const designLabelOf = (workerId: string | undefined): string | null => /^design-([A-Z]{1,4})$/.exec(workerId ?? "")?.[1] ?? null;
