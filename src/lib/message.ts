// Defensive readers for pi message/entry shapes (docs/rpc.md "Types", docs/session-format.md).
// Everything arrives as `unknown` over the wire, so nothing here trusts a shape.

import type { TranscriptItem } from "../../shared/protocol";

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Joins the text blocks of a string-or-array `content` field. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A tool call row's arguments, when its row carries them (a card tool, EAGER_TOOLS); a lazy
    row's come from GET /api/transcript/tool (lib/tool-content). */
export function toolCallArgs(row: TranscriptItem | undefined): unknown {
  return row?.tool?.args;
}

export interface ToolResultView {
  output: string;
  isError: boolean;
}

/** A tool result row as its card reads it. A lazy row carries no output: its card fetches it. */
export function toolResultView(row: TranscriptItem): ToolResultView {
  return { output: row.tool?.output || row.text || "", isError: row.meta?.isError === true };
}

/** A tool result row's `details`, when its row carries them (a card tool). */
export function resultDetails(row: TranscriptItem | undefined): unknown {
  return row?.tool?.details;
}

/** One-line summary of tool args for a collapsed card header. */
export function argsSummary(args: unknown): string {
  if (!isObj(args)) return typeof args === "string" ? args : "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    const v = args[key];
    if (typeof v === "string") return v;
  }
  const first = Object.values(args).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

/** The tools that start a subagent or a team: the Timeline marks each. */
export const SPAWN_TOOLS: ReadonlySet<string> = new Set(["agent_spawn", "team_create"]);

/** The name a spawn call gave its agent or team, when the arguments carried one. */
export function spawnName(args: unknown): string {
  if (!isObj(args)) return "";
  for (const key of ["name", "team", "agent", "id"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
