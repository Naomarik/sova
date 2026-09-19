// Defensive readers for pi message/entry shapes (docs/rpc.md "Types", docs/session-format.md).
// Everything arrives as `unknown` over the wire, so nothing here trusts a shape.

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

/** The `message` of a JSONL `message` entry, if any. */
export function entryMessage(raw: unknown): Record<string, unknown> | undefined {
  return isObj(raw) && isObj(raw.message) ? raw.message : undefined;
}

/** Arguments of a tool call inside an assistant message entry. */
export function toolCallArgs(raw: unknown, toolCallId: string | undefined): unknown {
  const msg = entryMessage(raw);
  if (!msg || !Array.isArray(msg.content)) return undefined;
  const block = msg.content.find((c) => isObj(c) && c.type === "toolCall" && c.id === toolCallId);
  return isObj(block) ? block.arguments : undefined;
}

export interface ToolResultView {
  output: string;
  isError: boolean;
}

export function toolResultView(raw: unknown, fallback?: string): ToolResultView {
  const msg = entryMessage(raw);
  const output = msg ? contentText(msg.content) : "";
  return { output: output || fallback || "", isError: msg?.isError === true };
}

export function timestampOf(raw: unknown): string | undefined {
  return isObj(raw) ? str(raw.timestamp) : undefined;
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
