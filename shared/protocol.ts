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
  /** "provider/model" from the first model_change entry, else null. */
  model: string | null;
  /** Non-null when the session is currently open in a TUI (from ~/.pi/agent/sessions/live/*.json). */
  live: {
    pid: number;
    status: string;
    /** Subagent workers of that live session (from presence.workerCounts); enables sidebar badges. */
    workers?: { working: number; total: number };
  } | null;
  /** "web" if spawned via this webapp's POST /api/sessions (tracked persistently by the server,
      survives restarts); "external" for anything else. Pane rule: top region shows
      live!=null || origin==="web"; everything else goes to the bottom archive section. */
  origin: "web" | "external";
}

export type EntryKind =
  | "user"
  | "assistant-text"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "info" // session_info, model_change, compaction, labels, branch summaries etc.
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
  raw: unknown;
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
// GET  /api/transcript?path=…   -> { items: TranscriptItem[] }   (active branch only)
// GET  /api/cwds                -> string[]                          (distinct cwds, for the new-session picker)
// GET  /api/models              -> ModelInfo[]                       (available models; favorite=true mirrors the TUI Ctrl+P palette)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  /** "provider/modelId" — the canonical ref used in set_model. */
  ref: string;
  provider: string;
  id: string;
  /** Mirrors the command-palette extension's favorites when its storage is readable. */
  favorite: boolean;
}

/** WS /ws/chat?path= — full-duplex chat for webapp-owned sessions. */
export type ChatClientMessage =
  | { type: "prompt"; text: string; images?: OutboundImage[] }
  | { type: "steer"; text: string; images?: OutboundImage[] }
  | { type: "abort" }
  | { type: "set_model"; ref: string }   // calls session.setModel; server replies {type:"model"} or error
  | { type: "ui_response"; id: string; value: unknown };

export type ChatServerMessage =
  /** First message after connect: current transcript + live state. */
  | { type: "hello"; items: TranscriptItem[]; isStreaming: boolean; model: string | null }
  /** Raw pi SDK agent event passthrough. Shapes documented in pi docs/rpc.md "Events":
      message_update (assistantMessageEvent: text_delta | thinking_delta | toolcall_start/delta/end),
      tool_execution_start/update/end, turn_start/end, agent_start/end, agent_settled, ... */
  | { type: "event"; event: unknown }
  /** Extension dialog bridge (select/confirm/input). Optional in MVP. */
  | { type: "model"; model: string }    // active model changed (model_change passthrough events also exist)
  | { type: "ui_request"; id: string; request: unknown }
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

export interface UsageWindow { label: string; pct: number; resetsAt?: string }
export interface UsageProvider {
  id: "claude" | "openai" | "ollama";
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
  providers: UsageProvider[]; // fixed order: claude, openai, ollama
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
