/**
 * Wire contract between server/ and src/. BOTH sides import these types.
 * Do not change a shape without telling the other side (team_msg).
 */

import type { WakeInfo } from "./wake";
export type { WakeInfo };

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
  /** The topic-outline's rolling "now" line — the session's latest summary snapshot, from the
      last `topic-outline` entry in the file, overlaid by the live record's fresher broadcast.
      Absent when the session has none (topic-outline off, older sessions). */
  outlineNow?: string;
  /** When that outline snapshot was generated (ms epoch); 0 when unknown. */
  outlineAt?: number;
  /** Outline topics in that same snapshot — the count the sidebar shows beside the "now" line.
      Absent when the snapshot is missing, like outlineNow. 0 is a real count. */
  outlineTopics?: number;
  /** Context fill at the file's last assistant reply: the head's own rule (input + cacheRead +
      cacheWrite of the last assistant usage on the branch; a compaction after it means no value),
      but read from the FILE TAIL, so a rewound branch can disagree with the head's gauge. Absent
      when the tail has no reply usage. `window` is null when the model isn't in the catalog. */
  context?: ContextInfo;
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
  /** The user's group for this session (`SessionGroup.id`, POST /api/session-groups/assign; ids
      persist in ~/.pi/agent/pi-web/session-groups.json). One group at most, and purely additive:
      a grouped session stays in its region (Live & web, or the Archive) as well. Absent when it
      belongs to none, and from an older server: treat as ungrouped. */
  groupId?: string;
  /** The session this one was forked from: the header's `parentSession`, canonicalized like every
      other session path here (so it is byte-identical to that session's `path`), and only while
      that file still exists and is a .jsonl inside the sessions dir. Absent for every session that
      was not branched, and from an older server. Lets a group show fork points without reading
      each transcript. */
  parent?: string;
  /** The same parent as a session id (that session's `id`, read from its filename): what
      `GroupMember.id`, the group assignments and every group route key on. Set exactly when
      `parent` is. Use `parent` to link or open (routes take paths), `parentId` to match.
      LINEAGE ONLY, and the distinction matters: this pair says a session was forked from THAT
      file, never at WHICH entry. A fork marker needs the leaf it diverged at, which only a group
      pi-web fanned out carries (`seed`), so a marker position must never be inferred from here —
      a marker in the wrong place is a false claim about which part of the transcript is shared
      (spec/14-workspaces.md "Data", spec/14b-fanout.md "The fork point in a transcript"). */
  parentId?: string;
  /** Remote session: the target name from ~/.pi/agent/targets.json. Derived from `cwd`, which for a
      remote session is the local placeholder ~/.pi/agent/pi-web/targets/<target>/<remote/abs/path>.
      Absent for local sessions. */
  target?: string;
  /** Remote session: the absolute working directory on the target (the placeholder path minus
      the target dir). Set exactly when `target` is. */
  remoteCwd?: string;
  /** Mounted-mode session: the cwd is inside a target's mount point (`<mount.local>`; created by
      POST /api/sessions {target, remoteCwd, mounted:true}), so its tools and any workers it spawns
      see the target's real files locally. `target`/`remoteCwd` are then derived from the mount
      mapping (the remote dir the local path stands for). Absent for local sessions and remote
      placeholder sessions. Derived from the cwd only — never a live mount check. */
  mounted?: true;
  /** Composer draft stored for this session: the draft's first non-empty line, ~80 chars. Present only on a session with no user message anywhere that has a stored draft — that is what keeps a never-sent new session in the list (sidebar). */
  draftPreview?: string;
}

/** A configured remote target (~/.pi/agent/targets.json, GET /api/targets). Credential-free. */
export interface TargetInfo {
  name: string;
  /** Display label; the name when the file sets none. */
  label: string;
  kind: "ssh" | "incus-cell" | "docker";
  /** Cached reachability probe (`uname -n` over the target, bounded): "ok" answered, "offline"
      connection failed or timed out, "error" connected but the command failed, "unknown" not
      probed yet. `error` carries the reason for offline/error. */
  status?: "ok" | "offline" | "error" | "unknown";
  error?: string;
  /** The target's default remote working directory, when configured. */
  cwd?: string;
  /** Human-readable host: user@host[:port] for ssh, the container/cell (+ via) otherwise. */
  host?: string;
  /** The target's sshfs mount is really on: a real check through the mount module
      (pi-config/extensions/remote/mount.ts — a mount-table read, never a stat on the fuse path,
      which would block the event loop). Deliberately uncached: the read is cheap and always
      honest, so an external unmount shows on the very next listing. Present only when the target
      declares a `mount` block in targets.json. */
  mounted?: boolean;
}

export type EntryKind =
  | "user"
  | "wake" // a fired wake-nudge (pi-config/extensions/wake-nudge.ts): a real role:"user" message
           // tagged "[wake_nudge n1] …"; counts as an input everywhere, but renders as a machine
           // row (WakeCard), never a "You" bubble. See `wake` and shared/wake.ts.
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
  /** kind "wake" only: the parsed wake-nudge (shared/wake.ts `parseWakeNudge`). `text` holds the
      whole fired message exactly as sent — the card's body shows it verbatim. */
  wake?: WakeInfo;
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
 * optional "Error: …", "Session: …" and "Model: …" lines, then the worker's final output), and
 * any other custom message longer than 200 characters or spanning lines. Parsed server-side;
 * `raw` is untouched.
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
  /** From the "Model: <model> · thinking: <level>[ · backend: <name>]" line, each part verbatim —
      including the sentinels "child default" / "default". Absent on messages from older
      subagents builds, which had no such line. */
  model?: string; // "ollama-cloud/kimi-k3", "claude-sonnet-4-6", "child default"
  effort?: string; // thinking level: "off" | "low" | "medium" | "high" | "default" | …
  backend?: string; // only for non-pi backends, e.g. "claude-code"
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

/** An image a transcript row names by path: user messages, assistant text, info rows (custom
    messages such as subagent reports) and tool results. The path is `/tmp/<name>` (a TUI
    clipboard paste, or a pi-web upload without ?draft=) or `<agent dir>/pi-web/attachments/<session
    id>/<name>` (a composer-draft upload, durable; shared/tmp-paths.ts matches it by that tail). */
export interface TmpAttachment {
  path: string; // absolute, as written in the message
  name: string; // basename
  mimeType: string; // from the extension
  /** Bytes on disk, when the file exists. */
  size?: number;
  /** Servable at parse time: a regular file directly in /tmp, or in a session folder directly under
      this server's attachments root, ≤ 20MB. false once the file is gone (/tmp cleaned, session
      cleaned up), for an attachments-shaped path outside this root, or when over the cap (then
      `size` is set). */
  available: boolean;
}

/** Client→server image attachment. Base64 payload WITHOUT the data: prefix. */
export interface OutboundImage {
  data: string; // base64
  mimeType: string; // e.g. image/png, image/jpeg
}

/** A web-uploaded image, stored like a TUI clipboard paste (POST /api/upload: raw bytes,
    Content-Type image/png|jpeg|webp|gif -> 201). The prompt text references `path`. Also the
    shape of a composer draft's `attachments` entry (GET/PUT /api/sessions/draft). */
export interface UploadResult {
  path: string; // /tmp/pi-web-<uuid>.<ext>, or <agent dir>/pi-web/attachments/<session id>/pi-web-<uuid>.<ext> with ?draft=
  name: string; // basename
  mimeType: string;
  size: number;
}

// ---------------------------------------------------------------------------
// REST (JSON)
//
// GET  /api/sessions            -> SessionSummary[]
// POST /api/sessions { cwd }    -> SessionSummary   (creates a NEW empty webapp-owned session)
// POST /api/sessions { target, remoteCwd } -> SessionSummary   (remote session: creates the local placeholder
//                                  ~/.pi/agent/pi-web/targets/<target>/<remoteCwd> and a session there; 400 bad body/
//                                  non-absolute remoteCwd, 404 unknown target)
// POST /api/sessions { target, remoteCwd, mounted: true } -> SessionSummary   (mounted session: the cwd is the
//                                  mount path <mount.local> + the remote path relative to <mount.remote>, created if
//                                  needed; 400 the target has no "mount" config or remoteCwd is outside the mounted
//                                  root, 409 the target is not actually mounted. Plain {target, remoteCwd} keeps
//                                  creating the placeholder cwd, unchanged)
// POST /api/sessions/connect {} -> SessionSummary   (the connection agent: a new session in a fresh
//                                  ~/.pi/agent/pi-web/connect/<ts>/ seeded with AGENTS.md from server/connect-agent-template.md)
// GET  /api/targets             -> TargetInfo[]   (~/.pi/agent/targets.json; missing file → []; status from a cached,
//                                  bounded probe)
// POST /api/targets/:name/mount { on: boolean } -> TargetInfo   (mount/unmount the target's configured sshfs mount
//                                  through the mount module, idempotent; 400 bad body or the target has no "mount"
//                                  config, 404 unknown target, 502 the sshfs/fusermount command failed with its stderr)
// GET  /api/targets/:name/folders?path=…&hidden=1 -> FolderListing   (subfolders on the target; paths are REMOTE;
//                                  no path = the target's cwd, else its $HOME. 400 not absolute, 404 unknown target,
//                                  502 unreachable / ssh failed / folder missing)
// GET  /api/session-groups    -> SessionGroup[]   (the sidebar's user-made groups, in creation order;
//                                  ~/.pi/agent/pi-web/session-groups.json; missing file → [])
// POST /api/session-groups { name: string } -> SessionGroup   (creates one. 400 name not 1–60 chars)
// PATCH /api/session-groups/:id { name?: string, order?: string[], labels?: {id: string, label: string | null}[] }
//                                  -> SessionGroup   (renames and/or reorders and/or (re)labels members; every
//                                  field is optional but at least one is required. `order` is session ids: the
//                                  listed ones come first, in that order, and any member it leaves out keeps its
//                                  relative order after them; ids that are not in the group are ignored (they race
//                                  with assign). `labels` sets one label per session id, `null` clears it; ids not
//                                  in the group are ignored. 400 no recognised field, bad name, order not an array
//                                  of strings, labels not an array of {id, label}, or a label longer than
//                                  GROUP_LABEL_MAX characters after trimming; 404 unknown group)
// DELETE /api/session-groups/:id -> { ok: true }   (deletes the group and its assignments; the
//                                  sessions themselves are untouched. 404 unknown)
// POST /api/session-groups/assign { path, groupId: string | null, label?: string | null, index?: number }
//                                  -> AssignGroupResult
//                                  (puts one session in a group, or takes it out with null. When this write
//                                  removes the LAST member of a group whose `autoDissolve` is set (one pi-web
//                                  both created AND named), that group is deleted in the same atomic write and
//                                  the response carries dissolved: true. `seed` decides nothing here: a group
//                                  the user named stands empty even after it adopts one. `label` sets the
//                                  session's label in the group it lands in, `null` clears it, and omitting it
//                                  keeps the label it already had — a session moved between groups keeps its
//                                  metadata. `index` is where it lands in the target group's member order:
//                                  0 first, at/past the end or omitted = the end, so Add Back restores label
//                                  AND place in one write that cannot half-succeed. `index` is ignored with
//                                  groupId null, and ignored when the session is already in that group —
//                                  assign never reorders in place; PATCH { order } is the reposition.
//                                  400 bad body/path, a label over GROUP_LABEL_MAX, or a negative/non-integer
//                                  index; 404 session file or group missing. Never writes the session file)
// POST /api/session-groups/:id/prompt { text: string, members?: string[] (session ids) } -> BatchPromptResult
//                                  (the shared follow-up: prompts every member of the group, in member order.
//                                  ALL-OR-NOTHING PRE-CHECK — every member is checked before any is prompted
//                                  (file exists, not TUI-live, not archived, no active config failure, not
//                                  mid-turn here, no foreign/recent writer), and if any one fails the whole
//                                  batch is refused with 409 { refused: BatchRefusal[] } having sent NOTHING.
//                                  Returns on ACCEPTANCE, not completion: as soon as every member's prompt
//                                  is queued, never waiting for the turns. A member that breaks between the
//                                  check and being queued is reported in `failed`, never rolled back; one
//                                  that fails after being accepted reports in its own pane. Nothing accepted
//                                  at all is a 409, not a "sent to 0 of n". `members` is the user's explicit subset
//                                  ("Send to the rest"), never inferred server-side: given, every id must be
//                                  in the group, and only those are checked and prompted. No attachments and
//                                  no slash commands — images belong to a pane composer (spec §14).
//                                  400 bad body, blank text, members not an array of strings, an id that is
//                                  not a member, or the group is empty; 404 unknown group; 409 refused)
// POST /api/session-groups/fanout FanoutRequest -> 201 FanoutResult
//                                  (N sessions from one starting point, as one group. FORK MODE ({source}):
//                                  every member is branched from source.leafId onto a FRESH SessionManager of
//                                  its own — never the manager pi-web holds for the source — and the group
//                                  gets a `seed`. FRESH MODE ({cwd, text}): N independent sessions, no shared
//                                  root, no seed, and `text` is sent through the batch-prompt path.
//                                  `groupId` lands the members in an EXISTING group (the response's `group`
//                                  is then that one): a target with no seed adopts this fanout's, a matching
//                                  seed appends, a DIFFERING seed is 400 { error, code: "seed-conflict" } with
//                                  nothing created, and an unknown id is 404 with nothing created.
//                                  `named` says whether `name` is pi-web's generated default: "generated" makes
//                                  the new group auto-dissolve when emptied; "user", absent or unrecognised marks
//                                  it user-named and explicitly NOT dissolving. Ignored with `groupId` (the target
//                                  keeps its own name and its own flag).
//                                  400 bad name, empty members, a count outside 1–9, an unknown ref, both or
//                                  neither of name/groupId, both or neither of source/cwd, text or cwd in fork
//                                  mode, blank text in fresh mode;
//                                  404 a source path that resolves to no session (the subject doesn't exist —
//                                  different from "exists but not right now"); 409 { refused: [BatchRefusal] }
//                                  with exactly ONE entry, the source: tui-live, mid-turn, busy, config,
//                                  old-format (opening it would migrate-rewrite the file) or stale-leaf (the
//                                  ACTIVE branch's last rendered entry is no longer the one the dialog showed —
//                                  not the file's last line, which after a rewind is the abandoned branch). A member that fails DURING creation
//                                  has its own half-written file removed and is reported in `failed`; a member
//                                  that already exists is never unmade)
// POST /api/sessions/archive { path, archived: boolean } -> SessionSummary   (sets/clears the archive mark; never
//                                  writes the session file. 400 bad body/path, 404 missing, 409 archiving a live
//                                  or non-web session)
// POST /api/sessions/cleanup { mode:"age", minAgeDays:7|30, dryRun? } | { mode:"husks", dryRun? }
//     | { mode:"paths", paths: string[] (1–100, each validated like the archive route's path), dryRun? }
//     -> { deletedCount, deletedIds: string[], skipped:{live,busy,recent,failed}, refused?:[{path,reason}] }
//     (permanently deletes transcript files; dryRun reports candidates in deletedIds with deletedCount
//     0; live, mid-turn and just-written sessions are skipped and counted. paths mode deletes named
//     session files, only ones carrying the archive mark — an unarchived session is refused with a
//     reason to archive it first, as is anything outside the sessions dir, gone, or unreadable; each
//     refusal is returned in refused with its reason. refused is paths-mode-only, additive)
// GET  /api/sessions/draft?path=… -> { text: string | null, attachments: UploadResult[], updatedAt: string | null }
//                                  (the stored composer draft, ~/.pi/agent/pi-web/drafts.json; nulls and [] when
//                                  none; attachments whose file is gone are left out. 400 bad path, 404 missing)
// PUT  /api/sessions/draft { path, text, attachments?: UploadResult[] } -> { ok: true }   (stores it; blank text
//                                  with no attachments deletes it. At most 8 attachments; an entry that isn't
//                                  an existing image in /tmp or the attachments folder is dropped, not an error;
//                                  name/mimeType/size are re-derived from the file. Never writes the session file.
//                                  400 bad body/path, attachments not an array, or "Draft too long" (> 1,000,000
//                                  chars), 404 missing)
// GET  /api/transcript?path=…   -> { items: TranscriptItem[]; context: ContextInfo | null }   (active branch only)
// GET  /api/cwds                -> string[]                          (distinct cwds, for the new-session picker)
// GET  /api/folders?path=…&hidden=1 -> FolderListing   (subfolders for the New Session folder picker; no path = $HOME;
//                                  400 not absolute, 403 unreadable, 404 missing or not a folder)
// GET  /api/models              -> ModelInfo[]                       (available models; favorite=true mirrors the TUI Ctrl+P palette)
// GET  /api/attachment?path=…   -> image bytes (TmpAttachment.path; only /tmp/<name> or <agent dir>/pi-web/attachments/
//                                  <session id>/<name>, .png|jpg|jpeg|webp|gif, ≤ 20MB; 400 bad shape, 403 resolves
//                                  outside /tmp / the attachments root or too large, 404 missing)
// DELETE /api/attachment?path=… -> { ok: true }   (removes one file under the attachments root, e.g. a composer
//                                  chip's remove; 403 anything else, /tmp included; 400 no path; 404 missing)
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

// GET /api/settings/subagents    -> SubagentModelPolicy (empty lists when nothing is disabled)
// PUT /api/settings/subagents    -> SubagentModelPolicy (replaces the whole policy; 400 bad body)
// ---------------------------------------------------------------------------
/** Which providers and models are blocked from being picked as subagents or team members
    (Settings dialog §12). Storage and enforcement live in the subagents extension
    (pi-config/extensions/subagents/policy.ts), which reads the same file per spawn — TUI
    sessions included. Providers are lowercase names ("anthropic", or a backend id like
    "claude-code"); models are "provider/modelId" refs. */
export interface SubagentModelPolicy {
  disabledProviders: string[];
  disabledModels: string[];
}


export interface ModelInfo {
  /** "provider/modelId" — the canonical ref used in set_model. */
  ref: string;
  provider: string;
  id: string;
  /** Mirrors the command-palette extension's favorites when its storage is readable. */
  favorite: boolean;
  /** Thinking levels this model supports, ladder order (off…max). Mirrors pi 0.86.0
      getSupportedThinkingLevels: thinkingLevelMap nulls are dropped, xhigh/max need an explicit
      map entry, and non-reasoning models support only "off". */
  thinkingLevels: string[];
  /** What the model accepts, verbatim from pi's Model.input. Absent = unknown (a custom
      models.json provider that omits it); treat unknown as text-only. Vision is
      `input?.includes("image")`, derived client-side — there is no separate flag. */
  input?: ("text" | "image")[];
  /** The model's context window in tokens: the SDK model registry first (custom models.json
      providers included), then models-store.json — the same cached resolver ContextInfo.window
      uses. Absent when neither source knows it, the same convention as ContextInfo.window, so a
      cost preview shows "unknown" rather than assuming a default. This is the MODEL's window,
      independent of any session, which is what lets the fanout dialog compare candidate rows;
      ContextInfo.window cannot, because it describes one session's current model. */
  contextWindow?: number;
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

/** The composer's @-mention file index for a cwd (spec/04h-file-mentions.md): the cwd's
    non-ignored files as relative paths, cut at the server's cap. BASELINE STUB on this branch:
    the client landed at 345a38f without the protocol type or the GET /api/files route, so until
    the real shape lands, the stub keeps typecheck green and the mention menu shows its error
    state (fetch 404s) exactly as any failed folder read would. */
export interface FileIndex {
  /** Non-ignored file paths relative to the cwd, "/"-separated. */
  files: string[];
  /** True when `files` was cut at the server's cap. */
  truncated?: boolean;
}

/** Longest group name, in characters, after trimming (SessionGroup.name; the server trims and
    refuses an empty or longer one with 400). The one place the limit is written down: the create
    input's maxlength and the server's rule read it from here. */
export const GROUP_NAME_MAX = 60;

/** Longest member label, in characters, after trimming (GroupMember.label; the server trims and
    refuses a longer one with 400, while an empty one clears the label). */
export const GROUP_LABEL_MAX = 40;

/** One session's presentation metadata inside a group (SessionGroup.members). Membership itself is
    the server's assignments map — this carries only the ORDER (array position) and an optional
    short LABEL, e.g. "sonnet ×2" on a fanout member. */
export interface GroupMember {
  /** Session id (`SessionSummary.id`), not a path. */
  id: string;
  /** Shown beside the row; absent when unset. Trimmed, 1–GROUP_LABEL_MAX characters. */
  label?: string;
}

/** Where a fanout group came from (SessionGroup.seed). Written only by POST
    /api/session-groups/fanout in fork mode; fresh mode has no fork point to align to. */
export interface GroupSeed {
  /** Canonical path of the source session — the same path each member's header carries as
      `parentSession`, and the same string that session's own `SessionSummary.path` has. */
  parentSessionPath: string;
  /** The entry every member was branched at: the ONLY source of a fork marker's position. */
  leafId: string;
}

/** One user-made group in the sidebar's Groups region (GET /api/session-groups). Groups hold
    sessions; they never replace a region, so a grouped session still shows in Live & web or the
    Archive. Stored in ~/.pi/agent/pi-web/session-groups.json, keyed by session id (like the archive). */
export interface SessionGroup {
  /** Stable uuid; what `SessionSummary.groupId` and every route below take. */
  id: string;
  /** Shown as-is (trimmed, 1–60 chars). Duplicates are allowed: nothing keys on the name. */
  name: string;
  createdAt: string; // ISO
  /** Set only on a group pi-web fanned out (fork mode): where its members came from. Lineage
      (`SessionSummary.parent`/`parentId`) says a session was forked from THAT file; only this
      says WHERE, so the fork marker and Align to Fork are seed-only and never infer a position
      from lineage. A hand-made group never grows one, which is what the auto-dissolve rule
      (AssignGroupResult.dissolved) stands on. */
  seed?: GroupSeed;
  /** Whether the group deletes itself when its last member leaves (AssignGroupResult.dissolved).
      Set ONLY by POST /api/session-groups/fanout when it CREATES the group with a generated name
      — pi-web made it and named it, so pi-web may remove it. NEVER set by that route's `groupId`
      path: a group the user named is theirs and keeps standing empty, even after it adopts a
      fanout's `seed`.
      THIS IS THE ONE TRUTH OF DISSOLUTION. It used to be inferred from `seed`, which is lineage
      and the fork marker's datum; that inference is what would have made an adopted hand-made
      group start deleting itself. Do not re-derive dissolution from another field, and do not
      use this one to mean anything but dissolution.
      A RENAME CLEARS IT (PATCH /api/session-groups/:id with a name that actually changes): the
      claim above is a conjunction — pi-web made it AND named it — and renaming falsifies the
      second half, so the group becomes the user's and stands when emptied. Renaming to the same
      string revokes nothing, and reordering or relabelling never touch it. The flag is set and
      cleared by the events that make it true or false, so no rule has to be remembered.
      Absent only on a group written before this field existed — then, and only then, `seed`
      implies it, since those are pi-web's own fanout groups. An explicit value always wins. */
  autoDissolve?: boolean;
  /** The group's sessions in display order, with their labels. The server always sends it — it is
      reconciled against the assignments on every read (ids no longer in the group drop out, ids
      missing from it are appended in id order) — and it is optional in the type only because an
      older server, or a hand-written store file, may not carry it. */
  members?: GroupMember[];
}

/** 200 body of POST /api/session-groups/assign. Additive: a client that only reads `ok` is
    unaffected. */
export interface AssignGroupResult {
  ok: true;
  /** The assign emptied a group whose `autoDissolve` is set, and the server deleted it in the SAME
      write (spec/14-workspaces.md §14 "Emptying a group"). `autoDissolve` is the whole rule and
      `seed` decides nothing: a hand-made group that ADOPTS a fanout's seed keeps standing when
      emptied, because a group whose name is the user's work stands empty — whether they typed it
      at creation or later over a generated one. Absent otherwise. The client toasts
      "Dissolved “{name}”", leaves the workspace route and refetches the list. Archive cleanup can
      also empty a group and deliberately does NOT dissolve one: no client is listening to that
      call, and a background listing pass must never delete a group. */
  dissolved?: true;
}

/** Why one member of a group batch prompt cannot be prompted right now
    (POST /api/session-groups/:id/prompt). A closed set: the client renders its own sentence per
    code and never parses `message`. "internal" is the escape hatch, so an unexpected failure
    still carries a valid code. */
export type BatchRefusalCode =
  | "mid-turn"
  | "tui-live"
  | "archived"
  | "config"
  | "busy"
  | "missing"
  /** Fanout only: the source's header version isn't current, so opening it would rewrite the
      file — which a runtime we hold for that session would see as a foreign write. The only
      refusal here the user can clear themselves ("open it for chat once, then fan out"). */
  | "old-format"
  /** Fanout only: `source.leafId` is not the source's current leaf — meaning the last entry its
      transcript RENDERS on its ACTIVE branch, which is what the server compares against
      (readActiveBranch + normalizeEntry, the transcript's own two rules). NOT the file's last
      line, and the difference is not academic: after a rewind the file's TAIL is the ABANDONED
      branch, and the entries there are ordinary visible messages. Comparing against the tail
      refuses sources nobody has touched, and rewound sessions are the likeliest thing to fork.
      The client sends the leaf it SHOWED the user, for the same reason: forking from a point
      they didn't approve would break the fork marker's only promise. */
  | "stale-leaf"
  | "internal";

/** One member the batch could not take, named four ways: `id` joins against `GroupMember.id` and
    the assignments map, `path` is what a pane routes and opens with, `code` is for logic, and
    `message` is the server's human sentence (a fallback, not the UI copy). */
export interface BatchRefusal {
  id: string; // session id
  path: string; // canonical session path ("" when the file is gone)
  code: BatchRefusalCode;
  message: string;
  /** FANOUT ONLY, and only in a 201's `failed`: the model ref (`ModelInfo.ref`) of a member that
      was never created, so the partial-creation banner can name it. Such a member has no session,
      so `id` and `path` are both "" and this is the only handle the client has on it.
      TWO DIFFERENT EMPTY IDS LIVE ON THIS ROUTE and they are not the same case: a 409 refusal
      names the SOURCE, which is a member of nothing and carries no `ref`; a `failed` entry names
      a member that never came into being and does carry one. Neither has an id, for different
      reasons, and nothing should build a lookup on either. Absent on the prompt route entirely —
      there the member always exists and `id` names it, so a `ref` would be a second way to say
      the same thing, and the two would drift. */
  ref?: string;
}

/** One row of the fanout dialog: a model, and how many copies of it to make. */
export interface FanoutMemberSpec {
  /** `ModelInfo.ref`, "provider/id". */
  ref: string;
  /** 1–9. The member appears this many times, consecutively, in pane order. */
  count: number;
}

/** POST /api/session-groups/fanout. Exactly one of `source` (fork mode) and `cwd` (fresh mode). */
export interface FanoutRequest {
  /** Name for a NEW group, 1–GROUP_NAME_MAX. Exactly one of `name` and `groupId` is required:
      with `name` the route creates the group (and pi-web owns it, so `autoDissolve` is set); with
      `groupId` it lands in an existing one, which keeps its own name. Sending both is a 400 —
      ignoring one of them silently would look like a rename that did nothing. */
  name?: string;
  members: FanoutMemberSpec[]; // array order IS pane order
  /** Fork mode: branch every member from this entry of this session. `leafId` is the leaf the
      dialog SHOWED the user, not a request for the server to find the current one. */
  source?: { path: string; leafId: string };
  /** Fresh mode: the folder every member is created in. */
  cwd?: string;
  /** Fresh mode only: the first message every member gets, sent through the batch path. */
  text?: string;
  /** Whether `name` is the default pi-web generated, or one the user typed over it. The client
      holds this fact and nothing else can: the server never generated the default, so it cannot
      distinguish an accepted one from an identical string typed by hand. Reported as a FACT; the
      policy stays server-side, and `autoDissolve` is derived from it, never sent by a client.
      "generated" ⇒ pi-web made AND named the group ⇒ `autoDissolve: true`.
      "user", ABSENT, or any unrecognised value ⇒ the user named it ⇒ the server writes
      `autoDissolve: false` EXPLICITLY — never leaves it absent, because absent-plus-`seed` is the
      on-disk signature of a pre-flag fanout group and the legacy rule dissolves those.
      IF THIS FIELD IS EVER REPLACED, THE REPLACEMENT MUST LAND ATOMICALLY — contract, server,
      client and tests in one change. An ADDITIVE migration fails silently and in the direction
      that looks healthy: a client still sending `named` while the server reads a new field sees
      absent, absent means "the user named it", so NO group is ever marked auto-dissolving, none
      is ever removed, and nothing errors anywhere. The safe-absence rule that exists to prevent
      lost names is exactly what would hide the feature being dead. Delete the old field in the
      same commit that adds the new one.
      CHECK IT POSITIVELY: `named === "generated"`. `named !== "user"` is the same sentence and
      the wrong one — an absent field is not a claim of user authorship, it is a client that
      cannot make the claim at all, and treating it as pi-web's deletes a name. Both spellings
      are equally SAFE with a boolean and equally available here, but a two-valued enum makes the
      negative form read naturally, so it is the likelier mistake and worth naming. Tests pin
      absent and unrecognised to a recorded false so the wrong spelling fails loudly.
      TWO ABSENCES, OPPOSITE DEFAULTS, BOTH CORRECT: this field's absence means the CLIENT predates
      it, and a user-named group is what is at risk, so it falls to "user"; `SessionGroup.autoDissolve`'s
      absence means the RECORD predates it, where no user-named group can exist, so there it falls
      to seed-implies-dissolution. Do not "align" them — and note that the SHAPES differ on purpose
      for the same reason: a boolean beside a boolean with opposite absence defaults invites exactly
      that alignment, while a boolean beside an enum cannot be mistaken for a matched pair. The
      difference in kind is what keeps the difference in meaning visible.
      THE SERVER MUST NOT VALIDATE THIS BY RE-DERIVING THE DEFAULT. Generating the name here to
      compare would be a second generator of one string, which is the ground the server-side
      alternative was rejected on: in fresh mode the default is rewritten on every keystroke, so a
      derivation at Create time disagrees with what the user was looking at. Same precedent as
      `source.leafId`, accepted as the leaf the DIALOG SHOWED rather than recomputed.
      DERIVE IT FROM THE EDIT EVENT, never by comparing strings. pi-web's client keeps
      `nameTouched`, set by the name field's own input handler and by nothing else, and sends
      "user" when it is set. "Typed over then reverted" is therefore "user": an empty group may
      be left behind, which is litter, recoverable in one gesture.
      THAT SIGNAL DOES TWO JOBS, and the second is invisible from the first: `nameTouched` also
      gates whether pi-web may keep REGENERATING the field from the prompt. One decides whether we
      may keep writing the name; the other decides whose the result is. So a change to when
      regeneration stops silently changes who owns the name, and no test in the file being edited
      will fail. Anyone altering either rule owns both.
      WHY NOT A COMPARISON (`name === the last string we wrote`): it is correct ONLY while
      regeneration stops at the first touch. That gate lives in another function; weaken it, add a
      second writer, and regeneration keeps firing after the user types — the field then holds our
      latest guess, the comparison equals it by construction, and a group the USER named is
      classified "generated" and deleted. The edit flag cannot fail that way: the signal is sticky
      and set by the user's own input. So the comparison is the fragile mechanism and it fails
      toward LOSS, while the edit flag's error is an empty group left standing.
      NOTE the tempting argument here is a retracted one (spec 9d6fe2b): that "typed over then
      reverted" and "typed our exact string by hand" are the same state deserving opposite
      answers, so no comparison can separate them. They do deserve the SAME answer — both end
      with our string on the group — and if that argument held it would indict the edit flag
      equally, since it also gives both rows one answer. Do not defend this rule with it; the
      fragility above is the live reason.
      POLARITY IS LOAD-BEARING FOR ANY OPTIONAL FLAG HERE, not just this one: the field must be
      the one whose FALSEHOOD, or absence, is the safe answer. `nameEdited` would have been the
      same information with the opposite failure — absent ⇒ not edited ⇒ generated ⇒ the group
      deletes itself — which is the unsafe default wearing an innocent name. */
  named?: "generated" | "user";
  /** Land the new members in an EXISTING group instead of creating one; the response's `group`
      is then that group. Omitted = create one named `name`. Seed rules, all checked BEFORE
      anything is created: an unknown id is 404; a target with NO seed ADOPTS this fanout's and
      appends; a target whose seed EQUALS this one appends; a target whose seed DIFFERS is
      refused with 400 { error, code: "seed-conflict" }. ONE GROUP CARRIES ONE SEED, because the
      fork marker and Align to Fork read it — a mixed-lineage group would make the marker assert
      a divergence point it cannot know, so the request is refused rather than the datum
      fabricated. Fresh mode has no seed: it never adopts and never conflicts, and leaves the
      target's seed alone. NOTE a hand-made group that adopts a seed becomes auto-dissolving
      (AssignGroupResult.dissolved), including the name the user chose. */
  groupId?: string;
}

/** 400 body of POST /api/session-groups/fanout when the request cannot be reconciled with the
    group it was asked to land in. `code` is a closed set of one today; the client renders its own
    sentence from it and `error` is the fallback. Every other 400 on this route is `{ error }`. */
export interface FanoutConflict {
  error: string;
  code: "seed-conflict";
}

/** 201 body of the fanout. `created` is never empty: if not one member could be made, nothing is
    created, the group is not written, and the call fails — a group with no members is debris,
    not a result. `failed` carries the members that couldn't start, in the batch's own refusal
    shape, and drives the partial-creation banner. Nothing already created is ever rolled back. */
export interface FanoutResult {
  group: SessionGroup;
  created: SessionSummary[];
  failed: BatchRefusal[];
}

/** 200 body of the batch prompt. `sent` MEANS ACCEPTED, NOT ANSWERED: the route returns as soon
    as every member's prompt is queued and never waits for the turns, because they are meant to
    run in parallel and waiting would serialize them. A member accepted and then failing reports
    in its OWN pane, over its own socket — this response never speaks for a turn it didn't wait
    for. `failed` is therefore about acceptance only: a member that broke between the pre-check
    and being queued. `sent` is never empty; nothing accepted is a refusal (409 { refused }). */
export interface BatchPromptResult {
  sent: string[]; // session ids, in the order they were accepted
  failed: BatchRefusal[];
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
  | { type: "ui_response"; id: string; value: unknown }
  /** Rewind to just before a user input on the active branch (the TUI's /tree on a user message):
      the tip moves to that message's parent and its text comes back for the composer. `id` is the
      client's request id, echoed in the `rewound`/`rewind_refused` reply; `entryId` is the user
      row's TranscriptItem.id. Refused while a turn streams or compacts (never auto-aborts). */
  | { type: "rewind"; id: string; entryId: string };

/** Why a rewind was refused: busy = a TUI owns the session; recent = an unknown process wrote it
    (reconnect with force); not_on_branch = the id is unknown, not a user message, or not on the
    active branch; cancelled = an extension cancelled the navigation; internal = anything else. */
export type RewindRefusal = "streaming" | "compacting" | "busy" | "recent" | "not_on_branch" | "cancelled" | "internal";

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
  /** Stop drained the SDK's still-queued steers and follow-ups (as queued, templates/skills
      expanded) before aborting, the TUI's Esc order: left queued, the next prompt would deliver
      them AFTER itself. The client drops their pending rows and puts the text back in the draft.
      Only sent when something was queued. */
  | { type: "queue_cleared"; steering: string[]; followUp: string[] }
  /** A rewind landed. Every client of the chat first got a fresh `hello` (the new branch) and a
      `mode` (re-resolved from it); only the requester then gets this, with the input's text for
      its composer (images are not handed back, as in pi's /tree). A rewind to the first input
      leaves an empty branch. */
  | { type: "rewound"; id: string; entryId: string; editorText: string }
  /** The rewind was refused and nothing changed; to the requester only, never as `error`.
      `message` is user-facing copy. */
  | { type: "rewind_refused"; id: string; entryId: string; reason: RewindRefusal; message: string }
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
// POST /api/upload                -> UploadResult 201  (raw image bytes; Content-Type: image/*; saved in /tmp)
// POST /api/upload?draft=<session path> -> UploadResult 201  (same, saved durably in that session's folder
//                                  <agent dir>/pi-web/attachments/<session id>/; 400 invalid session path, 404 no such session)
// GET /api/insights/session?path=  -> SessionInsight    (400/404 semantics like /api/transcript)

export interface UsageWindow { label: string; pct: number; resetsAt?: string; /** Raw counts when the provider exposes them (e.g. z.ai MCP calls: used/limit). */
  used?: number; limit?: number; /** Model-family scope when the window only covers a subset (e.g. Claude's "7d scoped" Fable window). */
  scope?: string; /** Provider-flagged binding constraint (currently active limit). */
  active?: boolean }
/** Prepaid credit balance, for a provider that reports money left instead of usage windows (DeepSeek). */
export interface UsageBalance { currency: string; total: number; granted: number; toppedUp: number; available: boolean }
export interface UsageProvider {
  id: "claude" | "openai" | "ollama" | "zai" | "deepseek";
  state: "ok" | "nologin" | "expired" | "nokey" | "badkey" | "na" | "error";
  windows: UsageWindow[];
  /** Present instead of `windows` for a credit provider (DeepSeek has no usage API, only a
      balance): no percentages and no reset times. `available: false` means the provider says
      calls are not fundable. */
  balance?: UsageBalance;
  error?: string;
}
export interface UsageInsight {
  available: boolean;
  reason?: "missing" | "corrupt";
  fetchedAt: number | null;
  nextFetchAt: number | null;
  stale: boolean; // now - fetchedAt > 10 min (no TUI pi refreshing the cache)
  providers: UsageProvider[]; // fixed order: claude, openai, ollama, zai, deepseek
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
  /** Who serves this worker's model, lower-case, leading the pane's meta line: the ref's own
      provider (`zai` for `zai/glm-5.3`), a bare id's provider from pi's cached catalogs, or
      `claude code` for a claude-code worker (its own sub/route). Derived server-side in
      server/insights.ts; absent when nothing can be derived — the pane then shows no provider
      rather than guessing. */
  provider?: string;
  /** This worker's thinking/effort level as it was spawned with (pi: explicit or the parent's
      level then; claude-code: its effort, or absent for the backend default). Absent when the
      writer didn't publish it (older pi-config). */
  effort?: string;
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
  /** The anchored message's own timestamp (ms), as the outline snapshot recorded it. This is the
      Timeline's chapter clock: `at` is when the summarizer last touched the topic, this is when the
      conversation did, and unlike the transcript row it survives the anchor being compacted off the
      branch. Absent from older servers, and on topics the live overlay invented (it has headings
      only), which is when the timeline falls back to the summary's own time and says so. */
  anchorAt?: number;
}
export interface SessionOutline {
  now: string; overall: string; lastHeading: string | null;
  state: "none" | "drafting" | "fresh" | "updating" | "stale" | "failed-keeping-last";
  generatedAt: number; // 0 = never
  topics: OutlineTopic[];
}
/** One past summary of the session: a `topic-outline` entry on the active branch, reduced to its
    two summary lines so the Timeline can draw each one at its time. `id`/`timestamp` are the
    entry's own (a stable row key, and a clock even when the payload's `generatedAt` is 0). */
export interface OutlineSnapshot {
  id: string; // the topic-outline entry's id
  timestamp: string; // its ISO stamp
  now: string; // the one-line "now" summary the timeline row shows
  overall: string; // the longer paragraph, for a tooltip
  generatedAt: number; // the payload's own clock (ms); 0 = unknown
}
export interface CompactionInfo {
  id: string; timestamp: string; tokensBefore: number | null; summary: string;
  readFiles: string[]; modifiedFiles: string[];
}
/** One rewind on the active branch: the invisible `pi-web-rewind` entry pi-web appends after
    navigating the tree (server/chat-manager.ts). Ids only — the turns it abandoned are, by
    definition, not on the branch a reader can walk — so a timeline marker can say a rewind
    happened and when, never what it took back. */
export interface RewindInfo {
  id: string; // the marker entry's own id
  timestamp: string; // its ISO stamp
  targetId: string; // the user entry the chat rewound to ("" if the write carried none)
  fromLeafId: string; // the leaf it was on before ("" when the session had none)
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
/** One skill the session's prompt OFFERED. pi records the offered set as a diffed prompt section,
    so a skill appears only in the system entries that introduced or changed it: `from` is the entry
    that offered it, `until` the one that stopped. Being offered is not the same as being used. */
export interface SessionSkillOffer {
  name: string;
  description?: string;
  /** Absolute path of the skill's SKILL.md, as the prompt named it. */
  location?: string;
  /** ISO: the prompt entry that first offered it. Empty when that entry had no timestamp. */
  from: string;
  /** ISO: the entry that stopped offering it. Absent while it is still offered. */
  until?: string;
}

/** A skill that was actually LOADED, and the evidence for it. `how`, in order of certainty:
    `invoked` — an explicit /skill:name or a Claude Code `Skill` call, exact;
    `read` — a read of a SKILL.md, which is pi's own rule for classifying a skill load, exact;
    `shell` — a bash command naming a SKILL.md, inferred (a command can name one for other reasons). */
export interface SessionSkillUse {
  name: string;
  /** ISO timestamp of the entry carrying the evidence. */
  at: string;
  /** The transcript row to jump to: `${entryId}:${blockIndex}` for a tool call, else the entry id. */
  entryId: string;
  how: "invoked" | "read" | "shell";
  /** An explicit invocation's own arguments, when it carried any. */
  args?: string;
  /** The skill path an explicit invocation named, when it named one. */
  location?: string;
}

/** Which skills were offered, and which were loaded. See server/skills.ts for the evidence. */
export interface SessionSkills {
  /** Offered along the active branch, oldest offer first. Empty when the prompt never listed one
      (an older pi, or a session whose prompt sections were never recorded). */
  offered: SessionSkillOffer[];
  /** Every load, oldest first: repeats are kept, because "when" is half the question. */
  used: SessionSkillUse[];
}

export interface SessionInsight {
  outline: SessionOutline | null; // null: no topic-outline entries on the active branch
  /** Every summary the branch recorded, oldest first: one per `topic-outline` entry, minus
      malformed ones, empty ones, and a repeat of the previous summary (the extension rewrites the
      same text on some updates). Capped to the newest 200. Disk only: a live session's `outline`
      can carry a broadcast newer than the last snapshot here, so the newest summary on screen may
      not appear in this list yet. Absent when there are none, or from an older server. */
  outlines?: OutlineSnapshot[];
  compactions: CompactionInfo[]; // active branch, oldest first
  /** The branch's rewinds, oldest first — the invisible markers pi-web leaves when the chat goes
      back before a message. Absent when the session has none, or from an older server. */
  rewinds?: RewindInfo[];
  teams: TeamInfo[]; // live-joined when the session is running, else history
  /** This session's own subagent workers, from its live record (empty when it isn't live, or
      absent from an older server). The nested subagents pane lists these. */
  workers?: WorkerInfo[];
  /** The same lifetime token Σ as LiveAgentSession.usageTotal, for the session on screen. */
  usageTotal?: TokenUsageTotal;

  /** Which skills the session's prompt offered, and which were actually loaded: see
      server/skills.ts for the four signals and their reliability. Absent when neither is known. */
  skills?: SessionSkills;

  /** What each live worker loaded, by worker id, read from that worker's own transcript (a pi
      worker's session file, or a Claude Code worker's project file). Same signals as `skills`,
      except that a Claude Code transcript records no offered set at all. Absent when no worker
      loaded anything, so the payload stays lean. */
  workerSkills?: Record<string, SessionSkills>;
  /** Token spend for the whole session: per model × origin rows plus the Σs (see SessionUsage).
      Absent when nothing has been spent yet, or from an older server. */
  usage?: SessionUsage;
  /** /explain artifacts parented to this session (store ∪ JSONL explain-doc entries, deduped by
      id, newest first). Absent from older servers. */
  explanations?: ExplanationInfo[];
}
