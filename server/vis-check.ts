/**
 * The vis feedback loop for hosted sessions (§chat.markdown/visuals): the model learns when a `vis`
 * block it wrote could not be drawn, and gets one chance to fix it.
 *
 * - The retry: when a run is about to settle with the vis minor mode on, every `vis` fence in the
 *   run's assistant text is parsed with the renderer's own parser (src/vis/parse.ts). A block with a
 *   HARD error (`ok: false`: the reader sees its source) adds ONE hidden custom message
 *   (`sova-vis-retry`, `display: false`) naming each failed block, its line and the error, and
 *   continues the run for one more request, in which the model re-sends only the fixed blocks. At
 *   most once per run, so the retry's own reply is never retried. Soft warnings (the figure draws)
 *   never trigger it; neither does a run that was aborted or errored, nor one the user has already
 *   queued a message behind (that message goes first).
 * - `vis_check`: a tool, active only while vis is on, that checks a draft `vis html` / `vis svg`
 *   body before it is posted: the parse result and the document's size against the budget.
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
import { toolCtx, toPiTool } from "./harness/pi/tools";
import { chatModeOf } from "./mode-state";

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

/** A block that does not draw. */
export interface VisFailure {
  index: number;
  kind: string;
  /** The block's first non-blank body line, cut to 80 characters: how the model finds it. */
  first: string;
  /** 1-based body line of the error; 0 = the block as a whole. */
  line: number;
  message: string;
}

/** The fences whose parse is a HARD error. A success with warnings draws, so it is not a failure. */
export function visFailures(fences: readonly VisFence[], parse: (kind: string, body: string) => ParseResult = parseVis): VisFailure[] {
  const out: VisFailure[] = [];
  for (const f of fences) {
    const r = parse(f.kind, f.body);
    if (r.ok) continue;
    const first = f.body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    out.push({ index: f.index, kind: f.kind, first: first.length > 80 ? `${first.slice(0, 79)}…` : first, line: r.line, message: r.message });
  }
  return out;
}

/** The hidden message's text: every failed block, then the one thing to do. */
export function retryText(failures: readonly VisFailure[]): string {
  const n = failures.length;
  const rows = failures.map((f) => {
    const fence = f.kind ? `vis ${f.kind}` : "vis";
    const where = f.line > 0 ? `line ${f.line}` : "the block as a whole";
    return `- Block ${f.index} (\`${fence}\`${f.first ? `, starting \`${f.first}\`` : ""}): ${where}: ${f.message}`;
  });
  return [
    `Sova could not draw ${n === 1 ? "one vis block" : `${n} vis blocks`} in your last reply; the user sees ${n === 1 ? "its" : "their"} source instead:`,
    ...rows,
    "",
    `Re-send only the fixed ${n === 1 ? "block as a complete fence," : "blocks, each as a complete fence,"} with at most one short line before ${n === 1 ? "it" : "them"}. Do not repeat the rest of your reply or mention this note.`,
  ].join("\n");
}

/** The boundary entry a retry adds (a pi CustomMessageEntryDraft). */
export function retryEntry(failures: readonly VisFailure[]) {
  return {
    type: "custom_message" as const,
    customType: VIS_RETRY_MESSAGE,
    display: false,
    content: retryText(failures),
    details: { v: 1, blocks: failures.map(({ index, kind, line, message }) => ({ index, kind, line, message })) },
  };
}

/** What the hosting chat answers for the retry and the tool. */
export interface VisCheckHost {
  /** The vis minor mode is on for this chat. */
  visOn(state: StateView): boolean;
  /** A message waits behind this run (Sova's queue or the SDK's): it goes first, no retry. */
  queued(): boolean;
  /** This runtime may still write the file (no TUI took it, no foreign writer seen). */
  writable(): boolean;
}

/** The mode a branch resolves to, by the server's own rule (the extension's too). */
export const visOnBranch = (state: StateView): boolean => chatModeOf(state).minorModes.includes("vis");

/**
 * The retry's state for one runtime: the run's assistant text, and whether this run has had its
 * retry. Separate from pi so the one-retry rule is testable without a session.
 */
export class VisRetry {
  private blocks: string[] = [];
  private retried = false;

  /** An assistant message ended: its text blocks join the run's reply. */
  assistant(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content) if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) this.blocks.push(b.text);
  }

  /**
   * The run is about to settle: the hidden entry to add and continue with, or null. Checked once per
   * run at most — the run's blocks are cleared once a retry is sent, so its own reply is judged by
   * nobody. `outcome` other than "completed" (aborted, error) never retries.
   */
  beforeSettle(outcome: string, host: { visOn(): boolean; queued(): boolean; writable(): boolean }): ReturnType<typeof retryEntry> | null {
    if (this.retried || outcome !== "completed" || !this.blocks.length) return null;
    if (!host.visOn() || host.queued() || !host.writable()) return null;
    const failures = visFailures(visFences(this.blocks));
    if (!failures.length) return null;
    this.retried = true;
    this.blocks = [];
    return retryEntry(failures);
  }

  /** The run settled: the next one starts clean. */
  settled(): void {
    this.blocks = [];
    this.retried = false;
  }
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
  kind: "html" | "svg";
  ok: boolean;
  /** A hard error: the block would not draw. */
  error?: { line: number; message: string };
  warnings: { line: number; message: string }[];
  chars: number;
  soft: number;
  hard: number;
}

/** Check a draft html/svg body: what the reader would get, and its size against the budget. */
export function visCheck(kind: "html" | "svg", source: string, parse: (kind: string, body: string) => ParseResult = parseVis): { text: string; details: VisCheckDetails } {
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

type VisCheckParams = { kind: "html" | "svg"; source: string };

export const visCheckTool: ToolSpec<any, VisCheckDetails> = {
  name: VIS_CHECK_TOOL,
  label: "vis check",
  description:
    `Check a draft \`vis html\` or \`vis svg\` block before you post it: whether it would draw, any warnings, and its size in characters against the budget (aim under ${FRAME_SOFT_CHARS}; over ${FRAME_HARD_CHARS} does not draw). Pass the fence body exactly as you would write it between the fence lines, including any title:/caption: lines. Only html and svg.`,
  promptSnippet: "Check a draft vis html/svg block: would it draw, and its size against the budget",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["html", "svg"], description: "The fence's kind: html or svg" },
      source: { type: "string", description: "The fence body, without the ``` lines" },
    },
    required: ["kind", "source"],
    additionalProperties: false,
  },
  async execute(_id, params: VisCheckParams) {
    if (params.kind !== "html" && params.kind !== "svg") throw new Error("vis_check checks only html and svg blocks");
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

      // The tool is in the loadout exactly while vis is on. pi activates every extension tool at
      // registration, so session_start takes it out of a chat without vis before any request; a
      // switch made meanwhile is picked up when the next run starts, or when this one settles.
      const syncTool = (c: HookCtx) => {
        try {
          const want = host()?.visOn(c.state()) ?? visOnBranch(c.state());
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
        const m = event.message as { role?: string; content?: unknown };
        if (m?.role === "assistant") retry.assistant(m.content);
      });

      pi.on("agent_before_settle", async (event, ctx) => {
        const h = host();
        const c = toolCtx(ctx);
        const entry = retry.beforeSettle(event.outcome, {
          visOn: () => (h ? h.visOn(c.state()) : visOnBranch(c.state())),
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
