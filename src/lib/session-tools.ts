// The setup card's Tools group (§chat.transcript/setup-card-tools): what it draws from a GET
// /api/sessions/tools answer. Pure, so its words and figures are tested without a DOM.
import type { SessionTool, SessionTools } from "../../shared/protocol";
import { TOKEN_NOTE, tokenFacts } from "./session-setup";

export const TOOLS_LABEL = "Tools";
export const toolsHeading = (n: number) => `${TOOLS_LABEL} · ${n}`;
export const PI_TOOLS_NOTE = "Declared to the model with every request.";
export const CLAUDE_TOOLS_NOTE = "Claude Code calls these through Sova's MCP server.";
export const TOOLS_NONE = "No tools are declared to the model.";
export const toolsFailed = (message: string) => `Couldn't read this session's tools. ${message}`;

/** Where a tool comes from, in one muted word: pi's own, the extension's name, or Sova. */
export function sourceWord(t: Pick<SessionTool, "source" | "origin">): string {
  if (t.source === "builtin") return "built-in";
  if (t.source === "sova") return "Sova";
  return t.origin ?? "extension";
}

/** One row: `key` is the tool's own name (what keeps a row open across a backend switch), `name` the one
    the model calls. */
export interface ToolRow {
  key: string;
  name: string;
  source: string;
  facts: string;
  description: string;
}

export type ToolsView =
  | { kind: "list"; heading: string; total: string; note: string; rows: ToolRow[] }
  /** Not listed: the plain heading and one sentence. */
  | { kind: "line"; heading: string; text: string };

export function toolsView(answer: { ok: SessionTools } | { error: string }): ToolsView {
  if ("error" in answer) return { kind: "line", heading: TOOLS_LABEL, text: toolsFailed(answer.error) };
  const t = answer.ok;
  if (t.state !== "ok") return { kind: "line", heading: TOOLS_LABEL, text: t.reason };
  if (t.tools.length === 0) return { kind: "line", heading: TOOLS_LABEL, text: TOOLS_NONE };
  return {
    kind: "list",
    heading: toolsHeading(t.tools.length),
    total: tokenFacts(t.tools.reduce((sum, x) => sum + x.tokens, 0)),
    note: `${t.backend === "claude-code" ? CLAUDE_TOOLS_NOTE : PI_TOOLS_NOTE} ${TOKEN_NOTE}`,
    rows: t.tools.map((x) => ({ key: x.name, name: x.callName, source: sourceWord(x), facts: tokenFacts(x.tokens), description: x.description })),
  };
}

/** What the group re-reads on, as one string (a memo of it gates on the value): the chat's model, its
    mode triple, and how many times it has (re)connected. */
export function toolsKeyOf(model: string | null, mode: { mode: string; strict: boolean; minorModes: readonly string[] } | null, hellos: number): string {
  return JSON.stringify([model, mode?.mode ?? null, mode?.strict ?? null, mode ? [...mode.minorModes] : null, hellos]);
}

/** The open rows that are still listed after a re-read: a row stays open while its tool is listed. */
export function stillOpen(open: ReadonlySet<string>, view: ToolsView): Set<string> {
  if (view.kind !== "list") return new Set();
  const listed = new Set(view.rows.map((r) => r.key));
  return new Set([...open].filter((k) => listed.has(k)));
}
