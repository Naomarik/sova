/**
 * The vis feedback loop for hosted sessions (§chat.markdown/visuals): the model learns when a `vis`
 * block it wrote could not be drawn, and gets one chance to fix it.
 *
 * - The retry: when a run is about to settle with drawings on (the vis tools' one rule, visToolsWanted:
 *   vis on, or align on in a chat that started with Visuals), every `vis` fence in the run's assistant
 *   text, and every visual the run's `align` calls write inline on the alignment card, is parsed with
 *   the renderer's own parser (src/vis/parse.ts). A block with a HARD error (`ok: false`: the reader
 *   sees its source), or a `vis wireframe` whose layout is cramped (layout.ts's wireframeCramped:
 *   §chat.markdown/vis-wireframe-room), adds ONE hidden custom message (`sova-vis-retry`,
 *   `display: false`) naming each such block and what is wrong, and continues the run for one more
 *   request, in which the model re-sends only the fixed blocks (a card's visual through edit_question
 *   or edit_doc). At most once per run, so the retry's own reply is never retried. Other soft warnings
 *   (the figure draws) never trigger it; neither does a run that was aborted or errored, nor one the
 *   user has already queued a message behind (that message goes first).
 * - `vis_check`: a tool, active only while the vis tools are wanted (the same rule), that checks a
 *   draft `vis html`, `vis svg` or `vis wireframe` body before it is posted: the parse result, and the
 *   document's size against the budget (html, svg) or the cramped blocks (wireframe).
 *
 * Both live in one hidden inline extension that chat-manager gives every ordinary hosted runtime
 * (not the Overseer, baton or project-overseer loadouts). It hooks pi's `agent_before_settle`, the
 * boundary the mode extension's align nudge uses: the continuation is part of the same run, so the
 * run settles once, the queue keeps waiting behind it, and nothing else sees an idle gap.
 */

import MarkdownIt from "markdown-it";
import type { PiExtensionAPI } from "./harness/pi/extension-types";
import type { HookCtx, StateView, ToolSpec } from "../shared/harness";
import { FRAME_HARD_CHARS, FRAME_SOFT_CHARS } from "../src/vis/kinds/frame/parse";
import { parseVis, visKindWord, type ParseResult } from "../src/vis/parse";
import { wireframeCramped, type Cramp } from "../src/vis/kinds/wireframe/layout";
import type { WireframeSpec } from "../src/vis/kinds/wireframe/parse";
import { toolCtx, toPiTool } from "./harness/pi/tools";
import { ALIGN_LAUNCH } from "./harness/state-kinds";
import { chatModeOf } from "./mode-state";
import { visToolsWanted } from "../pi-config/extensions/mode/minor.ts";
import { ALIGN_TOOL } from "../pi-config/extensions/mode/align.ts";

/** customType of the hidden message a retry adds. Never displayed: the transcript drops it
    (`display: false`, server/transcript.ts) and the live view draws no custom-role message. */
export const VIS_RETRY_MESSAGE = "sova-vis-retry";
export const VIS_CHECK_TOOL = "vis_check";


// The renderer's settings (src/lib/markdown.ts): html and linkify don't change what a fence is, but
// the same parser is what makes "a fence" mean exactly what the reader's view draws.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** One `vis` fence in a text block. `index` counts the reply's vis fences, 1…; `line` is the opening
    fence's 1-based line in its text block. */
export interface VisFence {
  index: number;
  kind: string;
  body: string;
  line: number;
}

/**
 * Every `vis` fence in a reply, in order, the way the reader's view finds them: each text block is
 * rendered on its own (one transcript row per block), so each is tokenized on its own. A fence left
 * open at the end of a finished block is still a fence there (markdown-it closes it at the end).
 */
export function visFences(blocks: readonly string[]): VisFence[] {
  const out: VisFence[] = [];
  for (const text of blocks) {
    for (const t of md.parse(text, {})) {
      if (t.type !== "fence") continue;
      const kind = visKindWord(t.info);
      if (kind === null) continue;
      out.push({ index: out.length + 1, kind, body: t.content, line: (t.map?.[0] ?? 0) + 1 });
    }
  }
  return out;
}

/** A block that does not draw, or (`cramped`) a wireframe that draws with text that has no room. */
export interface VisFailure {
  index: number;
  kind: string;
  /** The block's first non-blank body line, cut to 80 characters: how the model finds it. */
  first: string;
  /** 1-based body line of the error; 0 = the block as a whole. */
  line: number;
  message: string;
  /** A wireframe that draws, with blocks whose text is cramped (§chat.markdown/vis-wireframe-room). */
  cramped?: Cramp[];
  /** A visual on the alignment card rather than a fence in the reply: where it sits ("q3", "the alignment's own", …). */
  card?: string;
}

/** The cramped blocks of a parsed wireframe ([] for any other kind or a spec that isn't one). */
export function crampedOf(kind: string, r: ParseResult): Cramp[] {
  return r.ok && kind === "wireframe" ? wireframeCramped(r.spec as WireframeSpec) : [];
}

/** How the note names one cramped block: its word, its first text, its line and the room it got. */
export const crampText = (c: Cramp): string =>
  `${c.type}${c.text ? ` "${c.text}"` : ""} (line ${c.line}) ${c.reason === "word" ? `has a word wider than the ${c.width}px it gets` : `gets ${c.width}px, under 12 characters, and its text doesn't fit on one line`}`;

const firstLine = (body: string) => {
  const first = body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
};

/** One block's verdict: a HARD error, or a cramped wireframe; null when it draws as it should (warnings or not). */
function failureOf(index: number, kind: string, body: string, parse: (kind: string, body: string) => ParseResult): VisFailure | null {
  const r = parse(kind, body);
  if (!r.ok) return { index, kind, first: firstLine(body), line: r.line, message: r.message };
  const cramped = crampedOf(kind, r);
  if (!cramped.length) return null;
  return { index, kind, first: firstLine(body), line: cramped[0]!.line, message: `cramped: ${cramped.map(crampText).join("; ")}`, cramped };
}

/** The fences whose parse is a HARD error, or a wireframe whose layout is cramped. Any other success with warnings draws as
    meant, so it is not a failure. */
export function visFailures(fences: readonly VisFence[], parse: (kind: string, body: string) => ParseResult = parseVis): VisFailure[] {
  const out: VisFailure[] = [];
  for (const f of fences) {
    const v = failureOf(f.index, f.kind, f.body, parse);
    if (v) out.push(v);
  }
  return out;
}

/** A visual an `align` call wrote on the alignment card: where it sits, its kind, its body. */
export interface CardVisual {
  card: string;
  kind: string;
  body: string;
}

/** The card visuals' verdicts, numbered after the reply's blocks only for the details' sake. */
export function cardFailures(visuals: readonly CardVisual[], parse: (kind: string, body: string) => ParseResult = parseVis): VisFailure[] {
  const out: VisFailure[] = [];
  visuals.forEach((v, i) => {
    const f = failureOf(i + 1, v.kind, v.body, parse);
    if (f) out.push({ ...f, card: v.card });
  });
  return out;
}

/** The hidden message's text: every failed block, then the one thing to do. */
export function retryText(failures: readonly VisFailure[]): string {
  const reply = failures.filter((f) => !f.card);
  const card = failures.filter((f) => f.card);
  const row = (f: VisFailure) => {
    const fence = f.kind ? `vis ${f.kind}` : "vis";
    const what = f.cramped ? f.message : `${f.line > 0 ? `line ${f.line}` : "the block as a whole"}: ${f.message}`;
    const name = f.card ? `The card's visual for ${f.card}` : `Block ${f.index}`;
    return `- ${name} (\`${fence}\`${f.first ? `, starting \`${f.first}\`` : ""}): ${what}`;
  };
  const broken = failures.filter((f) => !f.cramped).length;
  const cramped = failures.length - broken;
  const n = reply.length;
  const head = [
    broken ? `Sova could not draw ${broken === 1 ? "one vis block" : `${broken} vis blocks`}${n ? " in your last reply" : ""}; the user sees ${broken === 1 ? "its" : "their"} source instead` : "",
    cramped ? `${broken ? "and " : ""}${cramped === 1 ? "one wireframe draws" : `${cramped} wireframes draw`} cramped (labels squeezed into boxes too narrow to read)` : "",
  ].filter(Boolean);
  const head1 = head.join("; ");
  return [
    `${head1.charAt(0).toUpperCase()}${head1.slice(1)}:`,
    ...failures.map(row),
    "",
    ...(cramped
      ? [
          "Give a cramped screen room: fewer blocks side by side (a row of 2, not 4; a grid in a wider column), shorter labels, or a desktop screen. When the screen is dense (panes side by side, an editor in a dialog, a dense desktop layout) or its look matters, draw it as a clickable `vis html` prototype instead.",
        ]
      : []),
    ...(n
      ? [
          `Re-send only the fixed ${n === 1 ? "block as a complete fence," : "blocks, each as a complete fence,"} with at most one short line before ${n === 1 ? "it" : "them"}. Do not repeat the rest of your reply or mention this note.`,
        ]
      : []),
    ...(card.length
      ? [
          `Fix ${card.length === 1 ? "the card's visual" : "each card visual"} with align: edit_question {q, visual} for a question's, edit_doc {visual} for the alignment's own, giving the whole fixed visual. ${n ? "" : "Then end with at most one short line; do not repeat your reply or mention this note."}`.trim(),
        ]
      : []),
  ].join("\n");
}

/** The boundary entry a retry adds (a pi CustomMessageEntryDraft). */
export function retryEntry(failures: readonly VisFailure[]) {
  return {
    type: "custom_message" as const,
    customType: VIS_RETRY_MESSAGE,
    display: false,
    content: retryText(failures),
    details: {
      v: 1,
      blocks: failures.map(({ index, kind, line, message, cramped, card }) => ({ index, kind, line, message, ...(cramped ? { cramped: cramped.length } : {}), ...(card ? { card } : {}) })),
    },
  };
}

/** What the hosting chat answers for the retry and the tool. */
export interface VisCheckHost {
  /** Drawings are on in this chat (the retry's gate): the vis tools' one rule, visToolsWanted. */
  drawingsOn(state: StateView): boolean;
  /** The vis tools belong in this chat's loadout now (visToolsWanted over its mode and its launch Visuals). */
  visToolsOn(state: StateView): boolean;
  /** A message waits behind this run (Sova's queue or the SDK's): it goes first, no retry. */
  queued(): boolean;
  /** This runtime may still write the file (no TUI took it, no foreign writer seen). */
  writable(): boolean;
}

/** The vis minor mode is on for the mode a branch resolves to, by the server's own rule (the extension's too). */
export const visOnBranch = (state: StateView): boolean => chatModeOf(state).minorModes.includes("vis");

/**
 * Whether the vis tools are wanted on a branch with no chat to ask: the one rule (visToolsWanted) over the
 * branch's mode and the Visuals its launch record holds (none yet: off, as at the chat's first start
 * before its record is written — the hosting chat answers from its own launch values once bound).
 */
export const visToolsOnBranch = (state: StateView): boolean => visToolsWanted(chatModeOf(state).minorModes, state.first(ALIGN_LAUNCH)?.data.visuals ?? false);

/**
 * The retry's state for one runtime: the run's assistant text, and whether this run has had its
 * retry. Separate from pi so the one-retry rule is testable without a session.
 */
export class VisRetry {
  private blocks: string[] = [];
  /** The card's visuals this run wrote, by where they sit: the latest write wins, a removal (null) drops it. */
  private visuals = new Map<string, CardVisual & { call: string }>();
  private retried = false;

  /** An assistant message ended: its text blocks join the run's reply, its align calls' visuals the card's. */
  assistant(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) this.blocks.push(b.text);
      else if (b?.type === "toolCall" && isAlignTool(b.name)) for (const [where, v] of alignVisuals(b.arguments)) v ? this.visuals.set(where, { ...v, call: String(b.id ?? "") }) : this.visuals.delete(where);
    }
  }

  /** A tool's result: a failed align call wrote nothing, so its visuals don't count. */
  toolResult(message: { toolCallId?: unknown; isError?: unknown }): void {
    if (message.isError !== true) return;
    for (const [where, v] of this.visuals) if (v.call === message.toolCallId) this.visuals.delete(where);
  }

  /**
   * The run is about to settle: the hidden entry to add and continue with, or null. Checked once per
   * run at most — the run's blocks are cleared once a retry is sent, so its own reply is judged by
   * nobody. `outcome` other than "completed" (aborted, error) never retries.
   */
  beforeSettle(outcome: string, host: { drawingsOn(): boolean; queued(): boolean; writable(): boolean }): ReturnType<typeof retryEntry> | null {
    if (this.retried || outcome !== "completed" || (!this.blocks.length && !this.visuals.size)) return null;
    if (!host.drawingsOn() || host.queued() || !host.writable()) return null;
    const failures = [...visFailures(visFences(this.blocks)), ...cardFailures([...this.visuals.values()])];
    if (!failures.length) return null;
    this.retried = true;
    this.blocks = [];
    this.visuals.clear();
    return retryEntry(failures);
  }

  /** The run settled: the next one starts clean. */
  settled(): void {
    this.blocks = [];
    this.visuals.clear();
    this.retried = false;
  }
}

/** The align tool by its name in the loadout (bare, or behind a provider's prefix such as `mcp__sova__`). */
const isAlignTool = (name: unknown): boolean => typeof name === "string" && (name === ALIGN_TOOL || name.endsWith(`__${ALIGN_TOOL}`));

/** A visual's body as the card stores it: a whole `vis` fence given as the source is the body inside it (§chat.alignment/visuals). */
const visualBody = (source: string): string => /^\s*(`{3,}|~{3,})vis [a-z]+[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(source)?.[2] ?? source;

/**
 * The visuals one align call writes inline, by where they sit on the card: a create's own and its questions' (by their
 * place in it), an edit_question's (by its q) and an edit_doc's. null: a removal. Anything malformed is skipped: the
 * tool refuses it, so the card never holds it.
 */
export function alignVisuals(args: unknown): [string, CardVisual | null][] {
  const out: [string, CardVisual | null][] = [];
  const ops = (args as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) return out;
  const visual = (card: string, v: unknown) => {
    if (v === null) return out.push([card, null]);
    const { kind, source } = (v ?? {}) as { kind?: unknown; source?: unknown };
    if (typeof kind === "string" && typeof source === "string") out.push([card, { card, kind, body: visualBody(source) }]);
  };
  for (const op of ops as Record<string, unknown>[]) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "create") {
      if ("visual" in op) visual("the alignment's own (create)", op.visual);
      if (Array.isArray(op.questions)) op.questions.forEach((q: { visual?: unknown }, i: number) => q && "visual" in q && visual(`question ${i + 1} of the create`, q.visual));
    } else if (op.op === "edit_question" && typeof op.q === "string" && "visual" in op) visual(op.q, op.visual);
    else if (op.op === "edit_doc" && "visual" in op) visual("the alignment's own", op.visual);
  }
  return out;
}

// ---- vis_check ---------------------------------------------------------------------------------

/**
 * The document part of an html/svg body: the frame parser's rule (src/vis/kinds/frame/parse.ts)
 * — leading blank and `title:` / `caption:` lines are ours — trimmed. vis-check.test.ts pins that it
 * equals the parser's own `spec.source` on every body the parser accepts.
 */
export function frameDocument(body: string): string {
  const all = body.split("\n");
  let k = 0;
  while (k < all.length) {
    const t = all[k]!.trim();
    if (t !== "" && !/^(title|caption):\s+/.test(t)) break;
    k++;
  }
  return all.slice(k).join("\n").trim();
}

/** Characters as the frame budget counts them (code points), not UTF-16 units or bytes. */
export const charCount = (s: string): number => [...s].length;

export interface VisCheckDetails {
  v: 1;
  kind: "html" | "svg" | "wireframe";
  ok: boolean;
  /** A hard error: the block would not draw. */
  error?: { line: number; message: string };
  warnings: { line: number; message: string }[];
  /** html, svg: the document's size against the budget. */
  chars?: number;
  soft?: number;
  hard?: number;
  /** wireframe: the blocks whose text is cramped (§chat.markdown/vis-wireframe-room). */
  cramped?: Cramp[];
}

export type VisCheckKind = VisCheckDetails["kind"];

/** Check a draft body: what the reader would get, and for html/svg its size against the budget, for a wireframe its cramped blocks. */
export function visCheck(kind: VisCheckKind, source: string, parse: (kind: string, body: string) => ParseResult = parseVis): { text: string; details: VisCheckDetails } {
  if (kind === "wireframe") return wireframeCheck(source, parse);
  const r = parse(kind, source);
  const chars = charCount(frameDocument(source));
  const warnings = r.ok ? [...(r.warnings ?? [])] : [];
  const details: VisCheckDetails = {
    v: 1,
    kind,
    ok: r.ok,
    ...(r.ok ? {} : { error: { line: r.line, message: r.message } }),
    warnings,
    chars,
    soft: FRAME_SOFT_CHARS,
    hard: FRAME_HARD_CHARS,
  };
  const at = (line: number) => (line > 0 ? `line ${line}: ` : "");
  const size =
    chars > FRAME_HARD_CHARS
      ? `over the hard limit of ${FRAME_HARD_CHARS} characters: it will not draw`
      : chars > FRAME_SOFT_CHARS
        ? `over the ${FRAME_SOFT_CHARS}-character target (hard limit ${FRAME_HARD_CHARS}): it draws, marked large; cut it down if you can`
        : `within the ${FRAME_SOFT_CHARS}-character target (hard limit ${FRAME_HARD_CHARS})`;
  const lines = [
    r.ok ? `OK: this vis ${kind} block draws.` : `ERROR: this vis ${kind} block would not draw (${at(r.line)}${r.message}); the reader would see its source.`,
    `Size: ${chars} characters of ${kind} (after the title/caption lines), ${size}.`,
    ...warnings.map((w) => `Warning: ${at(w.line)}${w.message}`),
  ];
  return { text: lines.join("\n"), details };
}

/** A draft wireframe: whether it draws, its warnings, and each cramped block, with what to do about them. */
function wireframeCheck(source: string, parse: (kind: string, body: string) => ParseResult): { text: string; details: VisCheckDetails } {
  const r = parse("wireframe", source);
  const warnings = r.ok ? [...(r.warnings ?? [])] : [];
  const cramped = crampedOf("wireframe", r);
  const at = (line: number) => (line > 0 ? `line ${line}: ` : "");
  const lines = [
    r.ok ? `OK: this vis wireframe block draws.` : `ERROR: this vis wireframe block would not draw (${at(r.line)}${r.message}); the reader would see its source.`,
    ...(r.ok
      ? cramped.length
        ? [
            `Cramped: ${cramped.length === 1 ? "one block's text has" : `${cramped.length} blocks' text has`} no room (each frame at its full width):`,
            ...cramped.map((c) => `- ${crampText(c)}`),
            "Give it room (fewer blocks side by side, shorter labels, a desktop screen), or for a dense screen draw a clickable `vis html` prototype instead.",
          ]
        : ["Room: every block's text fits."]
      : []),
    ...warnings.map((w) => `Warning: ${at(w.line)}${w.message}`),
  ];
  return { text: lines.join("\n"), details: { v: 1, kind: "wireframe", ok: r.ok, ...(r.ok ? {} : { error: { line: r.line, message: r.message } }), warnings, cramped } };
}

type VisCheckParams = { kind: VisCheckKind; source: string };
const VIS_CHECK_KINDS: readonly VisCheckKind[] = ["html", "svg", "wireframe"];

export const visCheckTool: ToolSpec<any, VisCheckDetails> = {
  name: VIS_CHECK_TOOL,
  label: "vis check",
  description:
    `Check a draft \`vis html\`, \`vis svg\` or \`vis wireframe\` block before you post it: whether it would draw and any warnings; for html and svg its size in characters against the budget (aim under ${FRAME_SOFT_CHARS}; over ${FRAME_HARD_CHARS} does not draw); for a wireframe each block whose text would be cramped. Pass the fence body exactly as you would write it between the fence lines, including any title:/caption: lines. Only html, svg and wireframe.`,
  promptSnippet: "Check a draft vis html/svg/wireframe block: would it draw, its size against the budget, cramped text",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...VIS_CHECK_KINDS], description: "The fence's kind: html, svg or wireframe" },
      source: { type: "string", description: "The fence body, without the ``` lines" },
    },
    required: ["kind", "source"],
    additionalProperties: false,
  },
  async execute(_id, params: VisCheckParams) {
    if (!VIS_CHECK_KINDS.includes(params.kind)) throw new Error("vis_check checks only html, svg and wireframe blocks");
    const { text, details } = visCheck(params.kind, String(params.source ?? ""));
    return { content: [{ type: "text", text }], details };
  },
};

// ---- the extension ------------------------------------------------------------------------------

/**
 * The inline extension (`hidden`, so no extension list shows it). `host` is late-bound: the runtime
 * is built before the ChatSession that hosts it, and null means "no chat yet" (no queue to wait on).
 */
export function visCheckExtension(host: () => VisCheckHost | null) {
  return {
    name: "sova-vis-check",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      const retry = new VisRetry();
      pi.registerTool(toPiTool(visCheckTool));

      // The tool is in the loadout exactly while the vis tools are wanted (visToolsWanted: vis on, or
      // align on with the chat's Visuals). pi activates every extension tool at registration, so
      // session_start takes it out of a chat that doesn't want it before any request; a switch made
      // meanwhile is picked up when the next run starts, or when this one settles.
      const syncTool = (c: HookCtx) => {
        try {
          const want = host()?.visToolsOn(c.state()) ?? visToolsOnBranch(c.state());
          const current = pi.getActiveTools();
          const has = current.includes(VIS_CHECK_TOOL);
          if (want && !has) pi.setActiveTools([...current, VIS_CHECK_TOOL]);
          else if (!want && has) pi.setActiveTools(current.filter((t) => t !== VIS_CHECK_TOOL));
        } catch {
          // No loadout to change yet.
        }
      };
      pi.on("session_start", async (_e, ctx) => syncTool(toolCtx(ctx)));
      pi.on("before_agent_start", async (_e, ctx) => syncTool(toolCtx(ctx)));

      pi.on("message_end", async (event) => {
        const m = event.message as { role?: string; content?: unknown; toolCallId?: unknown; isError?: unknown };
        if (m?.role === "assistant") retry.assistant(m.content);
        else if (m?.role === "toolResult") retry.toolResult(m);
      });

      pi.on("agent_before_settle", async (event, ctx) => {
        const h = host();
        const c = toolCtx(ctx);
        const entry = retry.beforeSettle(event.outcome, {
          drawingsOn: () => (h ? h.drawingsOn(c.state()) : visToolsOnBranch(c.state())),
          queued: () => h?.queued() ?? false,
          writable: () => h?.writable() ?? true,
        });
        if (!entry) return;
        return { entries: [...event.entries, entry], continue: true };
      });

      pi.on("agent_settled", async (_e, ctx) => {
        retry.settled();
        syncTool(toolCtx(ctx));
      });
    },
  };
}
