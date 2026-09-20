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
  /** "provider/model" that produced this row: the assistant message's own provider/model,
      else the nearest prior model_change on the branch. Set on assistant-text, thinking and
      tool-call rows; absent on other kinds and entries with neither (renderers fall back to
      the session's current model). */
  model?: string;
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
  /** source "align-doc" only: the mode extension's align document (custom entry, full snapshot per
      revision; only the newest on the branch becomes a row). `body` is its markdown verbatim,
      open questions as "1. [ ] …" / "2. [x] … — decision" checklist items; `agent` is absent. */
  align?: AlignReportInfo;
  /** source "explain-doc" only: a forked /explain subagent finished and wrote its HTML page +
      meta to the explanations store. `preview` is the topic; `agent` is absent. */
  explain?: ExplanationInfo;
}

/** One /explain artifact: a self-contained HTML page in the explanations store
    (~/.pi/agent/explanations/<id>/), written by a forked subagent. */
export interface ExplanationInfo {
  id: string; // store dir name, [A-Za-z0-9_-]+; served at /explain/<id>
  topic: string;
  /** One honest paragraph, written by the explainer for lists/cards. */
  summary: string;
  createdAt: string; // ISO 8601
  parentSessionId: string; // session that ran /explain
  /** FATAL: the run wrote no servable page, so nothing may link to /explain/<id>. The explainer's
      one-line reason. Only ever set on a transcript row's `report.explain` (alongside
      `report.error`): the lists — SessionInsight.explanations and GET /api/explanations — carry
      openable pages only, so an entry there never has it. */
  error?: string;
  /** ADVISORY: the page is complete and opens, but the run errored or was aborted afterwards, so
      it may be unfinished work. The link stays; show the reason alongside it. Appears on rows and
      in SessionInsight.explanations. At most one of `error`/`note` is ever set. */
  note?: string;
  /** The model that produced the page, as the extension spawned it (e.g. "zai/glm-5.3"). Absent
      on older stores. */
  model?: string;
}

/** Status and metrics of an align document. status: explicit "implementing"/"confirmed" first,
    else "questions-open" (open > 0), "ready" (total > 0, none open), else "aligning". */
export interface AlignReportInfo {
  status: "aligning" | "questions-open" | "ready" | "confirmed" | "implementing";
  title: string;
  lines: number; // markdown.split("\n").length
  open: number; // unchecked questions
  settled: number; // checked questions
  total: number;
  revision: number;
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

/** A web-uploaded image, stored like a TUI clipboard paste (POST /api/upload: raw bytes,
    Content-Type image/png|jpeg|webp|gif -> 201). The prompt text references `path`. */
export interface UploadResult {
  path: string; // /tmp/pi-web-<uuid>.<ext>
  name: string; // basename
  mimeType: string;
  size: number;
}

// ---------------------------------------------------------------------------
// REST (JSON)
//
// GET  /api/sessions            -> SessionSummary[]
// POST /api/sessions { cwd }    -> SessionSummary   (creates a NEW empty webapp-owned session)
// POST /api/sessions/archive { path, archived: boolean } -> SessionSummary   (sets/clears the archive mark; never
//                                  writes the session file. 400 bad body/path, 404 missing, 409 archiving a live
//                                  or non-web session)
// POST /api/sessions/cleanup { mode:"age", minAgeDays:7|30, dryRun? } | { mode:"husks", dryRun? }
//     -> { deletedCount, deletedIds: string[], skipped:{live,busy,recent,failed} }   (permanently deletes
//     transcript files; dryRun reports candidates in deletedIds with deletedCount 0; live, mid-turn and
//     just-written sessions are skipped and counted)
// GET  /api/transcript?path=…   -> { items: TranscriptItem[]; context: ContextInfo | null }   (active branch only)
// GET  /api/cwds                -> string[]                          (distinct cwds, for the new-session picker)
// GET  /api/folders?path=…&hidden=1 -> FolderListing   (subfolders for the New Session folder picker; no path = $HOME;
//                                  400 not absolute, 403 unreadable, 404 missing or not a folder)
// GET  /api/models              -> ModelInfo[]                       (available models; favorite=true mirrors the TUI Ctrl+P palette)
// GET  /api/attachment?path=…   -> image bytes (TmpAttachment.path; only /tmp/<name>.png|jpg|jpeg|webp|gif, ≤ 20MB;
//                                  400 bad shape, 403 resolves outside /tmp or too large, 404 missing)
// GET  /api/mode                -> ModeInfo   (the DEFAULT for new sessions: ~/.pi/agent/mode.json; missing file → defaults)
// POST /api/mode { mode?, minorModes? } -> ModeInfo   (writes that default only, merged into the fresh file with the
//                                  other fields kept. No open chat changes. 400 bad body or unknown name)
// POST /api/mode?path=… { mode?, minorModes? } -> ChatModeResult   (switches THAT chat only, from its next message;
//                                  mode.json is not written. 400 bad body/unknown name/bad path,
//                                  404 that session isn't held open by this server)
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
  /** Thinking levels this model supports, ladder order (off…max). Mirrors pi 0.85.1
      getSupportedThinkingLevels: thinkingLevelMap nulls are dropped, xhigh/max need an explicit
      map entry, and non-reasoning models support only "off". */
  thinkingLevels: string[];
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

/** The mode extension's settings (pi-config/extensions/mode). One major mode, any set of minor
    modes. The mode itself is per session; `mode`/`minorModes`/`strict` here are the **default for
    new sessions** (~/.pi/agent/mode.json), never one chat's state. `strict` is shown, never
    changed here. `modes`/`minors` list what exists. */
export interface ModeInfo {
  mode: string; // "normal" | "claude-heavy"
  minorModes: string[]; // canonical order
  strict: boolean;
  modes: { id: string; description: string }[];
  minors: { id: string; description: string }[];
}

/** Where a switch stands for the one chat it was sent to: "now" = its next message follows it;
    "after-turn" = switched mid-turn, so messages queued in this turn keep the old one;
    "new-chats" = this chat can't take a switch at all (the mode extension isn't loaded in it, or
    a foreign writer was seen), so only the default applies — to sessions started later. */
export type ModeApplies = "now" | "after-turn" | "new-chats";

/** POST /api/mode?path=…: the chat's mode after the switch, plus how it took (ModeApplies).
    The same values reach every client of that chat as a "mode" server message. */
export interface ChatModeResult extends ModeInfo {
  applies: ModeApplies;
}

/** WS /ws/chat?path= — full-duplex chat for webapp-owned sessions. */
export type ChatClientMessage =
  | { type: "prompt"; text: string; images?: OutboundImage[] }
  | { type: "steer"; text: string; images?: OutboundImage[] }
  | { type: "abort" }
  | { type: "set_model"; ref: string }   // calls session.setModel; server replies {type:"model"} or error
  | { type: "set_thinking"; level: string } // calls session.setThinkingLevel (clamped to the model); server replies {type:"thinking"}
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
  /** First message after connect: current transcript + live state + context fill.
      thinking = the session's active thinking level (one of off…max), clamped to its model. */
  | { type: "hello"; items: TranscriptItem[]; isStreaming: boolean; model: string | null; thinking: string; context: ContextInfo | null }
  /** Raw pi SDK agent event passthrough. Shapes documented in pi docs/rpc.md "Events":
      message_update (assistantMessageEvent: text_delta | thinking_delta | toolcall_start/delta/end),
      tool_execution_start/update/end, turn_start/end, agent_start/end, agent_settled, ... */
  | { type: "event"; event: unknown }
  /** Extension dialog bridge (select/confirm/input). Optional in MVP. */
  | { type: "model"; model: string }    // active model changed (model_change passthrough events also exist)
  /** Active thinking level after a change: sent with hello, after set_thinking, and after a
      model switch (the level may have been clamped to the new model's supported ladder). */
  | { type: "thinking"; level: string }
  /** Display entries appended outside a turn (mode markers, align docs, …), as they're written:
      rows exactly as normalizeEntry renders them, so the pane updates without a remount/resync. */
  | { type: "append"; items: TranscriptItem[] }
  /** THIS chat's own mode, and how the last switch applies to it. Sent after hello and after
      every switch of this chat. No other chat's switch, and no write of the default, sends one. */
  | { type: "mode"; mode: string; minorModes: string[]; strict: boolean; applies: ModeApplies }
  /** Slash commands available in this session (sent right after hello, and again after a runtime
      reload). Same enumeration as pi rpc get_commands: extension commands, prompt templates, skills.
      TUI built-ins (/tree, /model, …) are not included. Send one as a normal prompt "/name args". */
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "ui_request"; id: string; request: unknown }
  /** This chat's subagent workers, from the runtime's own live record (presence.workers/workerCounts).
      Sent after hello when the record has workers, then whenever the snapshot changes (polled ~3s),
      so it keeps coming after the parent turn settles. working 0 = none running. */
  /** `usageTotal` is the session-lifetime token Σ across every worker this runtime ever spawned
      (live ones plus the ones its retention cap dropped), so it is NOT the sum of `workers[].usage`.
      Absent when the live record predates it. */
  | { type: "workers"; working: number; total: number; workers: WorkerInfo[]; usageTotal?: TokenUsageTotal }
  // Codes: "busy" = a TUI owns the session (never retry with force); "recent" = file written by an
  // unknown process, at connect or mid-chat (client may reconnect with &force=1);
  // "reloaded" = runtime reloaded by another client, or message sent to a closed runtime (reconnect);
  // "config" = the session cannot be opened until something outside the server changes (its stored
  // cwd no longer exists). PERMANENT: show it once and stop reconnecting — retrying re-runs the
  // same failure and appends another banner. The socket closes 4422; "internal" closes 4500.
  // "internal" = server error, transient, safe to retry.
  | { type: "error"; message: string; code?: "busy" | "recent" | "reloaded" | "config" | "internal" };

/** WS /ws/watch?path= — read-only live view. Safe for sessions a TUI currently owns. Never writes.
    Also accepts `?claude=<uuid>` instead of `?path=`: a claude-code worker's own Claude Code
    session (WorkerInfo.sessionId), found under ~/.claude/projects and normalized into the same
    rows. Same `snapshot`/`append`/`error` messages; an unknown id closes with 4404 like a bad path.

    Both `snapshot` and `append` may carry `usage`: the tokens the whole transcript has used so
    far (always cumulative, never a delta), so an open header can tick while the file grows. It is
    absent while the transcript reports no usage at all, and carries no cost for a Claude session. */
export type WatchServerMessage =
  | { type: "snapshot"; items: TranscriptItem[]; usage?: TokenUsage }
  | { type: "append"; items: TranscriptItem[]; usage?: TokenUsage } // new JSONL rows since snapshot, as they appear
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// INSIGHTS (pi-web-insights team) — all GET, all read-only, never 500 on
// missing/corrupt sources: they return an honest empty/unavailable payload.
// ---------------------------------------------------------------------------
// GET /api/insights/usage          -> UsageInsight
// GET /api/insights/agents         -> AgentsInsight     (all live pi processes; poll ~5s)
// POST /api/upload                -> UploadResult 201  (raw image bytes; Content-Type: image/*)
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
/** Cumulative token counts. Non-negative integers; `cost` is USD and only present when the
    backend reports one. */
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }
/** A token Σ plus the number of workers it covers — a session-lifetime count that can exceed the
    workers currently listed, because evicted ones keep counting. */
export interface TokenUsageTotal extends TokenUsage { workers: number }
export interface WorkerInfo {
  id: string; name: string; status: WorkerStatus; working: boolean;
  model?: string; backend?: string; preview?: string;
  startedAt?: number; lastActivity?: number; endedAt?: number;
  outcome?: "success" | "error" | "aborted";
  teamId?: string;
  /** Path to this worker's own pi session JSONL, so its transcript can be read (live registry
      presence.workers[].sessionFile). Absent for a claude-code worker, or when the writer didn't
      publish it (older pi-config). Read-only consumers: never write to a worker's session. */
  sessionFile?: string;
  /** Backend session id when there is no pi session file (claude-code: its Claude session id). */
  sessionId?: string;
  /** Tokens this worker has used so far (both backends report them). Absent for a worker that
      has spent nothing yet, and from live records written by an older pi-config. */
  usage?: TokenUsage;
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
  /** Lifetime token Σ across every worker this session ever spawned (presence.workerUsage), so
      it can cover more workers than `workers` lists. Absent from older records and servers. */
  usageTotal?: TokenUsageTotal;
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
/** Where a model's tokens were spent: the main thread, plain subagents, or team members. */
export type SpendOrigin = "main" | "subagents" | "team";
/** One model's token spend from one origin; cost is USD when reported. */
export interface ModelSpend extends TokenUsage { model: string; origin: SpendOrigin }
/** This session's token spend. `models` holds one row per model × origin — a mid-session model
    switch adds a row. Main rows tally the active branch's assistant usage (rewinds don't count);
    worker rows come from the live record's per-worker usage, so they cover listed workers only —
    `workersTotal` is the session-lifetime Σ across every worker ever spawned and can exceed their
    sum (evicted workers surface there, not as rows). */
export interface SessionUsage {
  total: TokenUsage;
  main: TokenUsage;
  models: ModelSpend[];
  workersTotal?: TokenUsageTotal;
}
export interface SessionInsight {
  outline: SessionOutline | null; // null: no topic-outline entries on the active branch
  compactions: CompactionInfo[]; // active branch, oldest first
  teams: TeamInfo[]; // live-joined when the session is running, else history
  /** This session's own subagent workers, from its live record (empty when it isn't live, or
      absent from an older server). The nested subagents pane lists these. */
  workers?: WorkerInfo[];
  /** The same lifetime token Σ as LiveAgentSession.usageTotal, for the session on screen. */
  usageTotal?: TokenUsageTotal;
  /** Token spend for the whole session: per model × origin rows plus the Σs (see SessionUsage).
      Absent when nothing has been spent yet, or from an older server. */
  usage?: SessionUsage;
  /** /explain artifacts parented to this session (store ∪ JSONL explain-doc entries, deduped by
      id, newest first). Absent from older servers. */
  explanations?: ExplanationInfo[];
}
