import type { ReportInfo, TeamEvent, TeamEventKind, TeamMessageInfo } from "../shared/protocol";

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

// ---------------------------------------------------------------------------
// Coordinated teams (pi-config subagents/index.ts, `case "report"` / `case "question"` of the
// member request handler, and appendTeamEvent). Parsed strictly: a message whose header doesn't
// match stays the generic report row, an event that doesn't decode renders nothing.

export const TEAM_REPORT_TYPE = "team-report";
export const TEAM_QUESTION_TYPE = "team-question";
export const TEAM_EVENT_TYPE = "subagents-team-event-v1";

/** "[Team report from coordinator coordinator (ag_01), team_01 — e2e-file-test · milestone]" */
export const TEAM_REPORT_HEADER = /^\[Team report from coordinator (.+?) \((ag_\d+)\), (team_\d+) — (.+?)(?: · (milestone|concern))?\]$/;
/** "[Team question from writer, orchestrator (ag_02), team_01 — e2e-file-test]" */
export const TEAM_QUESTION_HEADER = /^\[Team question from (.+?)(, orchestrator)? \((ag_\d+)\), (team_\d+) — (.+)\]$/;
const REPORT_TRAILER = /^\(Informational: no action is requested\..*\)$/;
/** A body cut at QUESTION_CHARS ends in this line. */
const CUT = "[truncated]";
const LABEL_LINE = /^\s*(milestone|concern)\s*(?::|—|-)\s*/i;

export interface TeamMessage {
  team: TeamMessageInfo;
  body: string;
  truncated: boolean;
}

/** Drop trailing blank lines, then the cut marker if it is the last line. */
function peelCut(lines: string[]): boolean {
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (lines[lines.length - 1] !== CUT) return false;
  lines.pop();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return true;
}

/** A team-report or team-question message, or null when it isn't one or its header doesn't parse. */
export function parseTeamMessage(customType: string, text: string): TeamMessage | null {
  const lines = text.split("\n");
  const first = lines.shift() ?? "";
  if (customType === TEAM_REPORT_TYPE) {
    const m = TEAM_REPORT_HEADER.exec(first);
    if (!m) return null;
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (REPORT_TRAILER.test(lines[lines.length - 1] ?? "")) lines.pop();
    const truncated = peelCut(lines);
    let body = lines.join("\n").replace(/^\n+/, "");
    let label = m[5] as TeamMessageInfo["label"];
    // The body's own leading label: the fallback for a header without a kind, and never repeated
    // under a chip that already says it.
    const lead = LABEL_LINE.exec(body);
    const said = lead?.[1]?.toLowerCase() as TeamMessageInfo["label"];
    if (lead && (!label || label === said)) {
      label = said;
      body = body.slice(lead[0].length);
    }
    const team: TeamMessageInfo = { kind: "report", role: m[1]!, workerId: m[2]!, teamId: m[3]!, teamName: m[4]!, ...(label ? { label } : {}) };
    return { team, body, truncated };
  }
  if (customType === TEAM_QUESTION_TYPE) {
    const m = TEAM_QUESTION_HEADER.exec(first);
    if (!m) return null;
    const workerId = m[3]!;
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    // Only the answer line that names this asker is the trailer.
    if ((lines[lines.length - 1] ?? "").startsWith(`Answer with agent_steer { id: "${workerId}"`)) lines.pop();
    const truncated = peelCut(lines);
    const team: TeamMessageInfo = { kind: "question", role: m[1]!, workerId, teamId: m[4]!, teamName: m[5]!, ...(m[2] ? { orchestrator: true } : {}) };
    return { team, body: lines.join("\n").replace(/^\n+/, ""), truncated };
  }
  return null;
}

const EVENT_KINDS: ReadonlySet<string> = new Set<TeamEventKind>(["handover", "retire", "pause", "resume", "wrap-up"]);
const TEAM_ID = /^team_\d+$/;
const WORKER_ID = /^ag_\d+$/;
const DETAIL_MAX = 500;

/** The data of a subagents-team-event-v1 entry, strictly; null when any field is off. */
export interface TeamEventData {
  teamId: string;
  kind: TeamEventKind;
  workerId: string;
  role: string;
  at: number;
  detail?: string;
}
export function decodeTeamEventData(d: unknown): TeamEventData | null {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  if (r.version !== 1 || typeof r.teamId !== "string" || !TEAM_ID.test(r.teamId)) return null;
  if (typeof r.kind !== "string" || !EVENT_KINDS.has(r.kind)) return null;
  if (typeof r.workerId !== "string" || !WORKER_ID.test(r.workerId)) return null;
  if (typeof r.role !== "string" || !r.role) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (r.detail !== undefined && (typeof r.detail !== "string" || r.detail.length > DETAIL_MAX)) return null;
  return { teamId: r.teamId, kind: r.kind as TeamEventKind, workerId: r.workerId, role: r.role, at: r.at, ...(r.detail ? { detail: r.detail } : {}) };
}

/** handover detail: "successor writer-2 (ag_04) on pi/zai/glm-5.3-flash; retire on …" */
const HANDOVER = /^successor (.+?) \((ag_\d+)\)(?: |;|$)/;
const RETIRED_CONFIRMED = /^retired: successor (.+?) \((ag_\d+)\) confirmed the takeover/;
const RETIRED_TIMEOUT = /^retired: handover to (.+?) \((ag_\d+)\) timed out/;
/** pause/resume detail: "pause → coordinator, writer: <message>" */
const NOTICE = /^(?:pause|resume) → [^:]*: ([\s\S]*)$/;

/** The successor a handover event names, if its detail says. */
export function handoverSuccessor(e: Pick<TeamEventData, "kind" | "detail">): { role: string; workerId: string } | null {
  const m = e.kind === "handover" && e.detail ? HANDOVER.exec(e.detail) : null;
  return m ? { role: m[1]!, workerId: m[2]! } : null;
}

export function retireReason(e: Pick<TeamEventData, "kind" | "detail">): "confirmed" | "timeout" | undefined {
  if (e.kind !== "retire" || !e.detail) return undefined;
  if (RETIRED_CONFIRMED.test(e.detail)) return "confirmed";
  if (RETIRED_TIMEOUT.test(e.detail)) return "timeout";
  return undefined;
}

/** A notice's message on one line, cut at 120 characters (the whole detail goes in a title),
    with its own end punctuation. */
function noticeLine(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length > 120) return `${one.slice(0, 119).trimEnd()}…`;
  return /[.!?…]$/.test(one) ? one : `${one}.`;
}

/** One sentence per event, without the team: "writer handed over to writer-2 (ag_04)." */
export function teamEventText(e: TeamEventData): string {
  switch (e.kind) {
    case "handover": {
      const next = handoverSuccessor(e);
      return next ? `${e.role} handed over to ${next.role} (${next.workerId}).` : `${e.role} is handing over to a successor.`;
    }
    case "retire": {
      const confirmed = e.detail ? RETIRED_CONFIRMED.exec(e.detail) : null;
      if (confirmed) return `${e.role} retired. ${confirmed[1]} confirmed the takeover.`;
      const timeout = e.detail ? RETIRED_TIMEOUT.exec(e.detail) : null;
      if (timeout) return `${e.role} retired. The handover to ${timeout[1]} timed out.`;
      return `${e.role} retired.`;
    }
    case "pause": {
      const why = e.detail ? NOTICE.exec(e.detail)?.[1]?.trim() : undefined;
      return why ? `${e.role} paused the team: ${noticeLine(why)}` : `${e.role} paused the team.`;
    }
    case "resume":
      return `${e.role} resumed the team.`;
    case "wrap-up": {
      const why = e.detail?.replace(/\s+/g, " ").trim().replace(/[.]$/, "");
      return why ? `${e.role} was asked to wrap up: ${why.length > 120 ? `${why.slice(0, 119).trimEnd()}…` : `${why}.`}` : `${e.role} was asked to wrap up.`;
    }
  }
}

/** A subagents-team-event-v1 entry as the wire's TeamEvent, or null when it doesn't decode. */
export function teamEventOf(entry: { id?: unknown; data?: unknown }, fallbackId = "?"): TeamEvent | null {
  const d = decodeTeamEventData(entry.data);
  if (!d) return null;
  return {
    id: typeof entry.id === "string" ? entry.id : fallbackId,
    teamId: d.teamId,
    kind: d.kind,
    workerId: d.workerId,
    role: d.role,
    at: new Date(d.at).toISOString(),
    ...(d.detail ? { detail: d.detail } : {}),
    text: teamEventText(d),
  };
}
