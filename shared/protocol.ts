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
  live: { pid: number; status: string } | null;
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
// ---------------------------------------------------------------------------

/** WS /ws/chat?path= — full-duplex chat for webapp-owned sessions. */
export type ChatClientMessage =
  | { type: "prompt"; text: string; images?: OutboundImage[] }
  | { type: "steer"; text: string; images?: OutboundImage[] }
  | { type: "abort" }
  | { type: "ui_response"; id: string; value: unknown };

export type ChatServerMessage =
  /** First message after connect: current transcript + live state. */
  | { type: "hello"; items: TranscriptItem[]; isStreaming: boolean; model: string | null }
  /** Raw pi SDK agent event passthrough. Shapes documented in pi docs/rpc.md "Events":
      message_update (assistantMessageEvent: text_delta | thinking_delta | toolcall_start/delta/end),
      tool_execution_start/update/end, turn_start/end, agent_start/end, agent_settled, ... */
  | { type: "event"; event: unknown }
  /** Extension dialog bridge (select/confirm/input). Optional in MVP. */
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
