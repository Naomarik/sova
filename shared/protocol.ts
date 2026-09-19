/**
 * Wire contract between server/ and src/. BOTH sides import these types.
 * Do not change a shape without telling the other side (team_msg).
 */

export interface SessionSummary {
  /** Session id from the JSONL header line. */
  id: string;
  /** Absolute path of the .jsonl file. Used as THE session key in /api and /ws params. */
  path: string;
  cwd: string;
  /** First user message truncated to ~80 chars, or "Untitled". */
  title: string;
  createdAt: string; // ISO, from header
  lastActiveAt: string; // ISO, file mtime
  /** Latest "provider/model": the model_change or assistant message closest to the end of the
      file (last 256KB), else the first one in the head, else null. */
  model: string | null;
  /** Non-null when the session is currently open in a TUI (from ~/.pi/agent/sessions/live/*.json). */
  live: {
    pid: number;
    status: string;
    /** Subagent workers of that live session (from presence.workerCounts); enables sidebar badges. */
    workers?: { working: number; total: number };
  } | null;
  /** Subagent workers of this session, whoever runs it: the TUI's (same as live.workers) or this
      server's own embedded runtime (its own live record, which never sets `live`). Absent when no
      record reports counts, and from older servers: fall back to live?.workers. */
  workers?: { working: number; total: number };
  /** While the server holds this session's runtime AND it is mid-agent-turn (streaming): true.
      The sidebar shows a "Busy" marker. false when idle/closed or not held by this server.
      Never pulsing (design rule). */
  busy: boolean;
  /** "web" if spawned via this webapp's POST /api/sessions (tracked persistently by the server,
      survives restarts); "external" for anything else. Pane rule: top region shows
      live!=null || (origin==="web" && !archived); everything else goes to the bottom archive section. */
  origin: "web" | "external";
  /** The user archived this web-spawned session by hand (POST /api/sessions/archive; ids persist in
      ~/.pi/agent/pi-web/archived-sessions.json). Only moves it between regions; it opens as before,
      and a live one still shows on top. Absent from older servers: treat as false. */
  archived: boolean;
}

export type EntryKind =
  | "user"
  | "assistant-text"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "info" // session_info, model_change, compaction, labels, branch summaries etc.
  | "report" // subagent reports and other long extension messages (custom_message); see `report`
  | "unknown";

/** A normalized transcript row. `raw` carries the full parsed JSONL entry for advanced rendering. */
export interface TranscriptItem {
  id: string; // entry id
  kind: EntryKind;
  /** Display text for user/assistant-text/thinking/info; tool name for tool-call; result summary for tool-result. */
  text?: string;
  /** Tool call id pairing a tool-call with its tool-result, when applicable. */
  toolCallId?: string;
  /** Images attached to this row (user messages, tool results), as ready-to-render
      data URLs (`data:<mime>;base64,…`). pi stores ImageContent {type:"image", data: base64, mimeType}. */
  images?: string[];
  /** Image paths directly in /tmp named in the row's text (pi's TUI pastes a clipboard image as
      `/tmp/pi-clipboard-<uuid>.png`; replies, tool output and subagent reports quote it). Set on
      user, assistant-text, info (custom messages) and tool-result rows. Only concrete names outside
      markdown code spans/fences (shared/tmp-paths.ts), first 8 distinct per row. User rows: pi's own
      clipboard paths are removed from `text`; every other row keeps its text as-is. `raw` is
      untouched. Bytes: GET /api/attachment?path=. */
  attachments?: TmpAttachment[];
  /** kind "report" only: the parsed message. `text` holds the same body. */
  report?: ReportInfo;
  raw: unknown;
}

/**
 * An extension message shown as a collapsed report row instead of a centered info row: every
 * `subagent-complete` (pi-config subagents: "### <id> (<name>) — <status>[ · task <outcome>]",
 * optional "Error: …" and "Session: …" lines, then the worker's final output), and any other
 * custom message longer than 200 characters or spanning lines. Parsed server-side; `raw` is
 * untouched.
 */
export interface ReportInfo {
  /** The message's customType, e.g. "subagent-complete", "intercom_message". */
  source: string;
  /** Present when the header parsed (current format, or the older "Subagent <id> (<name>) finished its task."). */
  agent?: {
    id: string; // "ag_01"
    name: string; // "orchestrator"
    status: string; // worker status: starting | running | waiting | stopping | done | error | killed
    outcome?: string; // task outcome: success | error | aborted
  };
  error?: string; // the "Error: …" line
  session?: string; // the "Session: …" line: a session file path or id
  /** Markdown, verbatim, without the header lines and without the truncation trailer. */
  body: string;
  /** First non-empty body line with markdown markers stripped, for the collapsed row. */
  preview: string;
  /** The extension cut the message at 4000 characters ("[Use agent_transcript for more.]"). */
  truncated: boolean;
}

/** An image a transcript row names by /tmp path: user messages, assistant text, info rows
    (custom messages such as subagent reports) and tool results. */
export interface TmpAttachment {
  path: string; // absolute, as written in the message
  name: string; // basename
  mimeType: string; // from the extension
  /** Bytes on disk, when the file exists. */
  size?: number;
  /** Servable at parse time: a regular file directly in /tmp, ≤ 20MB. false once /tmp was cleaned
      (or when over the cap: then `size` is set). */
  available: boolean;
}

/** Client→server image attachment. Base64 payload WITHOUT the data: prefix. */
export interface OutboundImage {
  data: string; // base64
  mimeType: string; // e.g. image/png, image/jpeg
}

// ---------------------------------------------------------------------------
// REST (JSON)
//
// GET  /api/sessions            -> SessionSummary[]
// POST /api/sessions { cwd }    -> SessionSummary   (creates a NEW empty webapp-owned session)
// POST /api/sessions/archive { path, archived: boolean } -> SessionSummary   (sets/clears the archive mark; never
//                                  writes the session file. 400 bad body/path, 404 missing, 409 archiving a live
//                                  or non-web session)
// GET  /api/transcript?path=…   -> { items: TranscriptItem[]; context: ContextInfo | null }   (active branch only)
// GET  /api/cwds                -> string[]                          (distinct cwds, for the new-session picker)
// GET  /api/folders?path=…&hidden=1 -> FolderListing   (subfolders for the New Session folder picker; no path = $HOME;
//                                  400 not absolute, 403 unreadable, 404 missing or not a folder)
// GET  /api/models              -> ModelInfo[]                       (available models; favorite=true mirrors the TUI Ctrl+P palette)
// GET  /api/attachment?path=…   -> image bytes (TmpAttachment.path; only /tmp/<name>.png|jpg|jpeg|webp|gif, ≤ 20MB;
//                                  400 bad shape, 403 resolves outside /tmp or too large, 404 missing)
// GET  /api/mode                -> ModeInfo   (the global ~/.pi/agent/mode.json; missing file → defaults)
// POST /api/mode { mode?, minorModes? } -> ModeInfo   (merged into the fresh file, other fields kept; applied to
//                                  every chat this server holds, see ModeApplies. 400 bad body or unknown name)
// ---------------------------------------------------------------------------

/** Context-window fill of a session: last assistant entry's usage (input+cacheRead+cacheWrite)
    vs the model's contextWindow from models-store.json. null when no assistant message yet or
    window unknown. Live-updates via the assistant usage in passthrough events at turn end. */
export interface ContextInfo { tokens: number; window: number | null }

export interface ModelInfo {
  /** "provider/modelId" — the canonical ref used in set_model. */
  ref: string;
  provider: string;
  id: string;
  /** Mirrors the command-palette extension's favorites when its storage is readable. */
  favorite: boolean;
}

/** One folder's subfolders (GET /api/folders). Directories only, never files: a symlink is listed
    when its target is a directory; dangling and unreadable entries are left out. Dot folders only
    with hidden=1. Sorted by name, case-insensitive. */
export interface FolderListing {
  path: string; // absolute and normalized (path.resolve, symlinks kept as written)
  parent: string | null; // null at the filesystem root
  entries: { name: string; path: string; symlink?: true }[];
  /** More than 500 subfolders: `entries` holds the first 500 in sort order. */
  truncated: boolean;
}

/** The mode extension's global switch (pi-config/extensions/mode). One major mode, any set of
    minor modes. `strict` is shown, never changed here. `modes`/`minors` list what exists. */
export interface ModeInfo {
  mode: string; // "normal" | "claude-heavy"
  minorModes: string[]; // canonical order
  strict: boolean;
  modes: { id: string; description: string }[];
  minors: { id: string; description: string }[];
}

/** Where the current mode stands for one open chat: "now" = its next message follows it;
    "after-turn" = switched mid-turn, so messages queued in this turn keep the old one;
    "new-chats" = this chat can't take it (no mode extension here, or another writer seen). */
export type ModeApplies = "now" | "after-turn" | "new-chats";

/** WS /ws/chat?path= — full-duplex chat for webapp-owned sessions. */
export type ChatClientMessage =
  | { type: "prompt"; text: string; images?: OutboundImage[] }
  | { type: "steer"; text: string; images?: OutboundImage[] }
  | { type: "abort" }
  | { type: "set_model"; ref: string }   // calls session.setModel; server replies {type:"model"} or error
  | { type: "ui_response"; id: string; value: unknown };

export interface SlashCommand {
  /** Invocation name without the leading slash, e.g. "sessions", "skill:omarchy". */
  name: string;
  /** Optional for extension commands (pi docs/rpc.md); the UI shows a badge-only row then. */
  description?: string;
  source: "extension" | "prompt" | "skill";
  /** Where it comes from: extension path, or template/skill location (project, user, …) + path. */
  location?: string;
  path?: string;
}

export type ChatServerMessage =
  /** First message after connect: current transcript + live state + context fill. */
  | { type: "hello"; items: TranscriptItem[]; isStreaming: boolean; model: string | null; context: ContextInfo | null }
  /** Raw pi SDK agent event passthrough. Shapes documented in pi docs/rpc.md "Events":
      message_update (assistantMessageEvent: text_delta | thinking_delta | toolcall_start/delta/end),
      tool_execution_start/update/end, turn_start/end, agent_start/end, agent_settled, ... */
  | { type: "event"; event: unknown }
  /** Extension dialog bridge (select/confirm/input). Optional in MVP. */
  | { type: "model"; model: string }    // active model changed (model_change passthrough events also exist)
  /** The global mode and how it applies to this chat. Sent after hello and on every change
      (a switch from any tab, or the TUI writing mode.json). */
  | { type: "mode"; mode: string; minorModes: string[]; strict: boolean; applies: ModeApplies }
  /** Slash commands available in this session (sent right after hello, and again after a runtime
      reload). Same enumeration as pi rpc get_commands: extension commands, prompt templates, skills.
      TUI built-ins (/tree, /model, …) are not included. Send one as a normal prompt "/name args". */
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "ui_request"; id: string; request: unknown }
  /** This chat's subagent workers, from the runtime's own live record (presence.workers/workerCounts).
      Sent after hello when the record has workers, then whenever the snapshot changes (polled ~3s),
      so it keeps coming after the parent turn settles. working 0 = none running. */
  | { type: "workers"; working: number; total: number; workers: WorkerInfo[] }
  // Codes: "busy" = a TUI owns the session (never retry with force); "recent" = file written by an
  // unknown process, at connect or mid-chat (client may reconnect with &force=1);
  // "reloaded" = runtime reloaded by another client, or message sent to a closed runtime (reconnect);
  // "internal" = server error.
  | { type: "error"; message: string; code?: "busy" | "recent" | "reloaded" | "internal" };

/** WS /ws/watch?path= — read-only live view. Safe for sessions a TUI currently owns. Never writes. */
export type WatchServerMessage =
  | { type: "snapshot"; items: TranscriptItem[] }
  | { type: "append"; items: TranscriptItem[] } // new JSONL rows since snapshot, as they appear
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// INSIGHTS (pi-web-insights team) — all GET, all read-only, never 500 on
// missing/corrupt sources: they return an honest empty/unavailable payload.
// ---------------------------------------------------------------------------
// GET /api/insights/usage          -> UsageInsight
// GET /api/insights/agents         -> AgentsInsight     (all live pi processes; poll ~5s)
// GET /api/insights/session?path=  -> SessionInsight    (400/404 semantics like /api/transcript)

export interface UsageWindow { label: string; pct: number; resetsAt?: string; /** Raw counts when the provider exposes them (e.g. z.ai MCP calls: used/limit). */
  used?: number; limit?: number; /** Model-family scope when the window only covers a subset (e.g. Claude's "7d scoped" Fable window). */
  scope?: string; /** Provider-flagged binding constraint (currently active limit). */
  active?: boolean }
export interface UsageProvider {
  id: "claude" | "openai" | "ollama" | "zai";
  state: "ok" | "nologin" | "expired" | "nokey" | "badkey" | "na" | "error";
  windows: UsageWindow[];
  error?: string;
}
export interface UsageInsight {
  available: boolean;
  reason?: "missing" | "corrupt";
  fetchedAt: number | null;
  nextFetchAt: number | null;
  stale: boolean; // now - fetchedAt > 10 min (no TUI pi refreshing the cache)
  providers: UsageProvider[]; // fixed order: claude, openai, ollama, zai
}

export type WorkerStatus = "starting" | "running" | "waiting" | "stopping" | "done" | "error" | "killed";
export interface WorkerInfo {
  id: string; name: string; status: WorkerStatus; working: boolean;
  model?: string; backend?: string; preview?: string;
  startedAt?: number; lastActivity?: number; endedAt?: number;
  outcome?: "success" | "error" | "aborted";
  teamId?: string;
}
export interface TeamMember {
  workerId: string; role: string; orchestrator: boolean; backend: string; model?: string;
  ownedPaths: string[]; addedAt: number;
  worker: WorkerInfo | null; // null: not in the live record (history team / trimmed worker)
  lastReport?: { status: string; outcome?: string; at: string };
}
export interface TeamInfo {
  id: string; name: string; objective: string; createdAt: number;
  parentPath: string; // session key → #/s/<path>
  live: boolean; // parent session currently running
  members: TeamMember[];
  working: number;
}
export interface LiveAgentSession {
  path: string | null; sessionId: string | null; name: string | null; cwd: string; pid: number; mode: string | null;
  fresh: boolean; // heartbeat ≤ 15s
  /** A chat runtime embedded in this pi-web server (own pid). Its mode is "rpc" like a headless
      worker pi, but it's a real session that hosts agents. Absent from older servers. */
  embedded?: boolean;
  state: "working" | "idle" | "needs-input" | "error";
  workerCounts: { total: number; working: number; waiting: number; done: number; error: number; killed: number };
  workers: WorkerInfo[]; // may be shorter than workerCounts.total
  teams: TeamInfo[];
}
export interface AgentsInsight {
  at: number;
  totals: { sessions: number; working: number; total: number; teams: number; teamWorking: number; soloWorking: number };
  sessions: LiveAgentSession[]; // working first, then by lastActivity
}

export interface OutlineTopic {
  id: string; heading: string; bullets: string[]; at: number; manual: boolean;
  entryId: string | null; // anchor → TranscriptItem id to scroll to
}
export interface SessionOutline {
  now: string; overall: string; lastHeading: string | null;
  state: "none" | "drafting" | "fresh" | "updating" | "stale" | "failed-keeping-last";
  generatedAt: number; // 0 = never
  topics: OutlineTopic[];
}
export interface CompactionInfo {
  id: string; timestamp: string; tokensBefore: number | null; summary: string;
  readFiles: string[]; modifiedFiles: string[];
}
export interface SessionInsight {
  outline: SessionOutline | null; // null: no topic-outline entries on the active branch
  compactions: CompactionInfo[]; // active branch, oldest first
  teams: TeamInfo[]; // live-joined when the session is running, else history
}
