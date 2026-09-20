import type { ReportInfo } from "../shared/protocol";

// Extension messages (custom_message) that would otherwise be a centered info row: subagent
// reports, and any other long or multi-line payload. pi-config subagents/index.ts `summary()`
// builds the report text; it's cut at 4000 characters with a trailer line.

/** Longer than this (or spanning lines) and a custom message becomes a report row. */
export const REPORT_MIN_CHARS = 200;

/** "### ag_01 (orchestrator) — waiting · task success" */
const HEADER = /^### (\S+) \((.*)\) — (\S+)(?: · task (\S+))?\s*$/;
/** Older subagents builds: "Subagent ag_01 (ui-review) finished its task." / "… was killed." */
const OLD_HEADER = /^Subagent (\S+) \((.*)\) (finished its task|was killed)\.\s*$/;
const TRAILER = /\n?\[Use agent_transcript for more\.\]\s*$/;

export function isReport(customType: string, text: string): boolean {
  return customType === "subagent-complete" || text.length > REPORT_MIN_CHARS || text.includes("\n");
}

/** First non-empty line, without the markdown that would show as literal marks in one line. */
export function previewLine(markdown: string): string {
  const line = markdown.split("\n").find((l) => l.trim()) ?? "";
  const plain = line
    .trim()
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .trim();
  return plain.length > 240 ? `${plain.slice(0, 240)}…` : plain;
}

/**
 * The "Model: <model> · thinking: <level>[ · backend: <name>]" line's value, split on the middle
 * dot: first segment is the model (it may contain "/"), the rest are "key: value" pairs. Unknown
 * keys are ignored so a newer subagents build can add one without breaking the body.
 */
function parseModelLine(value: string): { model?: string; effort?: string; backend?: string } {
  const [first, ...rest] = value.split(" \u00b7 ");
  const model = first?.trim();
  if (!model) return {};
  const out: { model?: string; effort?: string; backend?: string } = { model };
  for (const part of rest) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (!val) continue;
    if (key === "thinking") out.effort = val;
    else if (key === "backend") out.backend = val;
  }
  return out;
}

export function parseReport(source: string, text: string): ReportInfo {
  const truncated = TRAILER.test(text);
  const lines = (truncated ? text.replace(TRAILER, "") : text).split("\n");
  const info: Omit<ReportInfo, "body" | "preview"> = { source, truncated };
  let start = 0;
  const head = HEADER.exec(lines[0] ?? "");
  const old = head ? null : OLD_HEADER.exec(lines[0] ?? "");
  if (head) {
    info.agent = { id: head[1]!, name: head[2]!, status: head[3]!, ...(head[4] ? { outcome: head[4] } : {}) };
    start = 1;
    if (lines[start]?.startsWith("Error: ")) info.error = lines[start++]!.slice("Error: ".length);
    if (lines[start]?.startsWith("Session: ")) info.session = lines[start++]!.slice("Session: ".length);
    if (lines[start]?.startsWith("Model: "))
      Object.assign(info, parseModelLine(lines[start++]!.slice("Model: ".length)));
  } else if (old) {
    info.agent = { id: old[1]!, name: old[2]!, status: old[3] === "was killed" ? "killed" : "done" };
    start = 1;
    while (start < lines.length && !lines[start]!.trim()) start++;
    if (lines[start]?.trim() === "Final output:") start++; // a label, like the header
  }
  const body = lines.slice(start).join("\n").replace(/^\n+/, "");
  return { ...info, body, preview: previewLine(body) };
}
