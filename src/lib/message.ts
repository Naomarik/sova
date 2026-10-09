// Defensive readers for pi message/entry shapes (docs/rpc.md "Types", docs/session-format.md).
// Everything arrives as `unknown` over the wire, so nothing here trusts a shape.

import type { TranscriptItem } from "../../shared/protocol";
import { rowFacts } from "../../shared/wire-v1";
import { recallSummary } from "../../shared/memory";

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
  return { output: row.tool?.output || row.text || "", isError: rowFacts(row)?.tool?.isError === true };
}

/** A tool result row's `details`, when its row carries them (a card tool). */
export function resultDetails(row: TranscriptItem | undefined): unknown {
  return row?.tool?.details;
}

/** pi's codemode tool (§chat.transcript/codemode-card). */
export const CODEMODE_TOOL = "codemode";

/** A codemode script's folded line: its first line that isn't blank or its `// @options:` line. */
export function codemodeHead(code: string): string {
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (t && !/^\/\/\s*@options:/.test(t)) return t;
  }
  return "";
}

/** One call a codemode script made, as pi records it in the result's details. */
export interface CodemodeCall {
  id: string;
  name: string;
  /** The arguments' preview (pi cuts it at 200 characters); a model call's is its "provider/id". */
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  /** USD, when a model call reported it. */
  cost?: number;
}

/** A codemode result's details, read defensively: its calls, and the file with all of a cut output. */
export function codemodeDetails(details: unknown): { calls: CodemodeCall[]; fullOutputPath?: string } | null {
  if (!isObj(details) || !Array.isArray(details.calls)) return null;
  const calls: CodemodeCall[] = [];
  for (const c of details.calls) {
    if (!isObj(c) || typeof c.name !== "string") continue;
    const status = c.status === "running" || c.status === "ok" || c.status === "error" || c.status === "cancelled" ? c.status : "error";
    calls.push({
      id: str(c.id) ?? "",
      name: c.name,
      args: str(c.args) ?? "",
      status,
      ...(typeof c.durationMs === "number" && Number.isFinite(c.durationMs) ? { durationMs: c.durationMs } : {}),
      ...(typeof c.error === "string" ? { error: c.error } : {}),
      ...(typeof c.cost === "number" && Number.isFinite(c.cost) ? { cost: c.cost } : {}),
    });
  }
  const path = str(details.fullOutputPath);
  return { calls, ...(path ? { fullOutputPath: path } : {}) };
}

/** A script's calls as its folded line counts them. */
export interface CodemodeTally {
  total: number;
  failed: number;
  running: number;
}

export function codemodeTally(calls: readonly CodemodeCall[]): CodemodeTally {
  return { total: calls.length, failed: calls.filter((c) => c.status === "error").length, running: calls.filter((c) => c.status === "running").length };
}

/** "4 calls · 1 failed" (· "2 running" while some run); "" before the first call. */
export function codemodeTallyText(t: CodemodeTally): string {
  if (t.total === 0) return "";
  return [`${t.total} ${t.total === 1 ? "call" : "calls"}`, ...(t.failed ? [`${t.failed} failed`] : []), ...(t.running ? [`${t.running} running`] : [])].join(" · ");
}

/** One-line summary of tool args for a collapsed card header (`name`: the tool, when its args read their own way). */
export function argsSummary(args: unknown, name?: string): string {
  if (name === CODEMODE_TOOL && isObj(args) && typeof args.code === "string") return codemodeHead(args.code);
  // A memory recall reads what it opened (§chat.memory/recall): "Recalled messages 40–47".
  const recall = recallSummary(name, args);
  if (recall) return recall;
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
