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
  /** First user message truncated to ~80 chars, or "Untitled" — replaced by the user's own title
      when they renamed the session (POST /api/sessions/title; Sova's own store, keyed by id in
      ~/.pi/agent/sova/session-titles.json). Renaming never writes into the session file. */
  title: string;
  /** The DERIVED title — the first user message — present only while `title` is a user-set
      override that differs from it. Absent otherwise, and from older servers. */
  originalTitle?: string;
  createdAt: string; // ISO, from header
  lastActiveAt: string; // ISO, file mtime
  /** Latest "provider/model": the model_change or assistant message closest to the end of the
      file (last 256KB), else the first one in the head, else null. */
  model: string | null;
  /** The topic-outline's rolling "now" line — the session's latest summary snapshot, from the
      last `topic-outline` entry in the file, overlaid by the live record's fresher broadcast.
      Absent when the session has none (topic-outline off, older sessions). */
  outlineNow?: string;
  /** The topic-outline's "overall" line — what the session is FOR, front-loaded, from the same
      snapshot (or broadcast) as `outlineNow`. This is what the session list shows; `outlineNow` is
      the latest process update, which reads as noise in a narrow row. Absent when the snapshot has
      none (older sessions, or a broadcast under `shareWithSessions: "now-only"`). */
  outlineGist?: string;
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
  /** This session IS a subagent's or team member's own session, never a thread the user started;
      the sidebar does not list it (src/lib/regions.ts `isMainThread`). True when the file itself
      carries the spawn marker pi-config's subagents extension writes into every pi worker
      (`subagents-worker-session`, server/worker-sessions.ts), when another session's file names it
      as a worker (that owner's `subagents-worker-registry` entries, or the `Session:` line of its
      inline `subagent-complete` message), or when a live record lists it as a running worker.
      NOT the same thing as `workers` above, which counts the subagents THIS session runs.
      Safe by absence: absent = a main thread, and an older server that never sends it hides
      nothing. */
  workerSession?: true;
  /** While the server holds this session's runtime AND it is mid-agent-turn (streaming): true.
      The sidebar shows a "Busy" marker. false when idle/closed or not held by this server.
      Never pulsing (design rule). */
  busy: boolean;
  /** "web" if spawned via this webapp's POST /api/sessions (tracked persistently by the server,
      survives restarts); "external" for anything else. Pane rule: top region shows
      live!=null || (origin==="web" && !archived); everything else goes to the bottom archive section. */
  origin: "web" | "external";
  /** The user archived this web-spawned session by hand (POST /api/sessions/archive; ids persist in
      ~/.pi/agent/sova/archived-sessions.json). Only moves it between regions; it opens as before,
      and a live one still shows on top. Absent from older servers: treat as false. */
  archived: boolean;
  /** The user's group for this session (`SessionGroup.id`, POST /api/session-groups/assign; ids
      persist in ~/.pi/agent/sova/session-groups.json). One group at most, and purely additive:
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
      Sova fanned out carries (`seed`), so a marker position must never be inferred from here —
      a marker in the wrong place is a false claim about which part of the transcript is shared
      (spec/14-workspaces.md "Data", spec/14b-fanout.md "The fork point in a transcript"). */
  parentId?: string;
  /** Remote session: the target name from ~/.pi/agent/targets.json. Derived from `cwd`, which for a
      remote session is the local placeholder ~/.pi/agent/sova/targets/<target>/<remote/abs/path>.
      Absent for local sessions. */
  target?: string;
  /** Remote session: the absolute working directory on the target (the placeholder path minus
      the target dir). Set exactly when `target` is. */
  remoteCwd?: string;
  /** Composer draft stored for this session: the draft's first non-empty line, ~80 chars. Present only on a session with no user message anywhere that has a stored draft — that is what keeps a never-sent new session in the list (sidebar). */
  draftPreview?: string;
  /** This session's file is in a session format older than the server's current
      (⇔ header `version` ≠ CURRENT_SESSION_FORMAT, server-computed — the client never compares
      numbers itself). The fanout source rules refuse such a file (`old-format`: forking reads
      the file, and reading an old format rewrites it wholesale under a runtime we hold), so the
      dialog pre-disables Create with §14b's sentence. SAFE BY ABSENCE: absent = current, OR the
      head could not be read, OR an older server that never sends the field — none of which ever
      blocks anything; only `true` disables a fork. Never affects opening, watching or chatting:
      an older-format session is only special to a route that would rewrite it. */
  legacyFormat?: true;
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
    clipboard paste, or a Sova upload without ?draft=) or `<agent dir>/sova/attachments/<session
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
  path: string; // /tmp/sova-<uuid>.<ext>, or <agent dir>/sova/attachments/<session id>/sova-<uuid>.<ext> with ?draft=
  // (legacy uploads kept the pi-web-<uuid> name; old paths keep serving from the moved root)
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
//                                  ~/.pi/agent/sova/targets/<target>/<remoteCwd> and a session there; 400 bad body/
//                                  non-absolute remoteCwd, 404 unknown target)
// POST /api/sessions/fork { path, entryId, position } -> ForkResult   (201; one new web-owned session
//                                  branched off `path` at `entryId`, the per-message Fork action. Nothing is
//                                  sent. 400 bad body, 404 unknown session, 409 { refused: ForkRefusal })
// POST /api/sessions/connect {} -> SessionSummary   (the connection agent: a new session in a fresh
//                                  ~/.pi/agent/sova/connect/<ts>/ seeded with AGENTS.md from server/connect-agent-template.md)
// GET  /api/targets             -> TargetInfo[]   (~/.pi/agent/targets.json; missing file → []; status from a cached,
//                                  bounded probe)
// GET  /api/targets/:name/folders?path=…&hidden=1 -> FolderListing   (subfolders on the target; paths are REMOTE;
//                                  no path = the target's cwd, else its $HOME. 400 not absolute, 404 unknown target,
//                                  502 unreachable / ssh failed / folder missing)
// GET  /api/session-groups    -> SessionGroup[]   (the sidebar's user-made groups, in creation order;
//                                  ~/.pi/agent/sova/session-groups.json; missing file → [])
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
//                                  removes the LAST member of a group whose `autoDissolve` is set (one Sova
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
//                                  REMOVAL BY ID: `{ id, groupId: null }` (session id, no path) is valid for
//                                  taking a session OUT only — a group member whose FILE is gone (the
//                                  workspace's "This session's file is gone" pane, spec 14) has no path to
//                                  send but its assignment is exactly what needs removing, and the store keys
//                                  on ids. `id` with a non-null groupId, `id` beside `path`, or `id` with
//                                  `label`/`index` is a 400: adding a member requires the file.
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
//                                  its own — never the manager Sova holds for the source — and the group
//                                  gets a `seed`. FRESH MODE ({cwd, text}): N independent sessions, no shared
//                                  root, no seed, and `text` is sent through the batch-prompt path.
//                                  `groupId` lands the members in an EXISTING group (the response's `group`
//                                  is then that one): a target with no seed adopts this fanout's, a matching
//                                  seed appends, a DIFFERING seed is 400 { error, code: "seed-conflict" } with
//                                  nothing created, and an unknown id is 404 with nothing created.
//                                  `named` says whether `name` is Sova's generated default: "generated" makes
//                                  the new group auto-dissolve when emptied; "user", absent or unrecognised marks
//                                  it user-named and explicitly NOT dissolving. Ignored with `groupId` (the target
//                                  keeps its own name and its own flag).
//                                  400 bad name, empty members, a count outside 1–9, an unknown ref, both or
//                                  neither of name/groupId, both or neither of source/cwd, text or cwd in fork
//                                  mode, blank text in fresh mode, or a cwd the New Session path itself would
//                                  refuse (not absolute, gone, not a directory, or a removed legacy mount cwd
//                                  — fresh mode IS that path N times, and answers with its sentences);
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
//                                  (the stored composer draft, ~/.pi/agent/sova/drafts.json; nulls and [] when
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
// GET  /api/models              -> ModelInfo[]                       (available models; favorite=true mirrors the TUI Ctrl+P palette.
//                                  EVERY model with credentials, disabled ones included: Settings → Models has to list what it
//                                  can turn back on. Pickers filter with the policy; the server refuses what the policy forbids)
// GET  /api/attachment?path=…   -> image bytes (TmpAttachment.path; only /tmp/<name> or <agent dir>/{sova,pi-web}/attachments/
//                                  <session id>/<name>, .png|jpg|jpeg|webp|gif, ≤ 20MB; 400 bad shape, 403 resolves
//                                  outside /tmp / the attachments root or too large, 404 missing)
// DELETE /api/attachment?path=… -> { ok: true }   (removes one file under the attachments root, e.g. a composer
//                                  chip's remove; 403 anything else, /tmp included; 400 no path; 404 missing)
// GET  /api/mode                -> ModeInfo   (the DEFAULT for new sessions: ~/.pi/agent/mode.json; missing file → defaults)
// POST /api/mode { mode?, minorModes? } -> ModeInfo   (writes that default only, merged into the fresh file with the
//                                  other fields kept. No open chat changes. 400 bad body or unknown name.
//                                  mode "claude-heavy" — Delegate's old name — is accepted and read as "delegate",
//                                  here and with ?path=; only "delegate" is ever written or returned)
// POST /api/mode?path=… { mode?, minorModes? } -> ChatModeResult   (switches THAT chat only, from its next message;
//                                  mode.json is not written. 400 bad body/unknown name/bad path,
//                                  404 that session isn't held open by this server)
// ---------------------------------------------------------------------------

/** Context-window fill of a session: last assistant entry's usage (input+cacheRead+cacheWrite)
    vs the model's contextWindow from models-store.json. null when no assistant message yet or
    window unknown. Live-updates via the assistant usage in passthrough events at turn end. */
export interface ContextInfo { tokens: number; window: number | null }

// GET /api/settings/delegate            -> DelegateSettingsInfo (~/.pi/agent/mode-delegate.json; missing → defaults)
// GET /api/settings/delegate/options    -> DelegateOptions (what each worker backend offers; runs `claude` initialize,
//                                          cached 60s. A backend that can't list its models has models:null + error)
// PUT /api/settings/delegate DelegateSettings -> DelegateSaveResult (replaces the whole routing. 400 bad shape, or a
//                                          CHANGED tuple its backend answered it can't run; unverifiable or
//                                          policy-denied tuples save with a warning. Delegate sessions — TUI and
//                                          web — pick it up at their next turn; normal mode never reads it)
// ---------------------------------------------------------------------------

// GET /api/settings/models      -> ModelPolicy (empty lists when nothing is disabled)
// PUT /api/settings/models      -> ModelPolicy (replaces the whole policy; 400 bad body)
// ---------------------------------------------------------------------------
/** Which providers and models may be used, and which of them subagents may be given (Settings →
    Models, spec/12-settings-dialog.md §12).

    Two dimensions over the same names. The bare lists are GLOBAL: those providers and models may
    not be used anywhere — not in a chat here (the socket refuses set_model, and a session already
    on one refuses to send), not in the TUI, not by a worker. The `subagent*` lists narrow what is
    still globally allowed down to what subagents and team members may pick, so a model can be
    yours to drive by hand and out of bounds for workers. Global therefore implies subagent, and
    the subagent entry is kept rather than folded in: turning a model back on restores the worker
    preference it had.

    Storage is `~/.pi/agent/model-policy.json` (server/model-policy.ts is the only writer);
    enforcement is shared with the pi extensions that read the same file per model change, per
    turn and per spawn — `pi-config/extensions/model-policy/` (the TUI, the command palette,
    topic-outline, vision-delegate) and `pi-config/extensions/subagents/policy.ts` (discovery and
    spawning), TUI sessions included. Providers are lowercase names ("anthropic", or a worker
    backend id like "claude-code", which is one provider with one switch over every Claude worker);
    models are "provider/modelId" refs. */
export interface ModelPolicy {
  /** Providers nothing may use. */
  disabledProviders: string[];
  /** "provider/modelId" refs nothing may use. */
  disabledModels: string[];
  /** Providers subagents may not use, on top of the global list. */
  subagentDisabledProviders: string[];
  /** Refs subagents may not use, on top of the global list. */
  subagentDisabledModels: string[];
}

// GET /api/themes                -> ThemeList (built-ins + the user's folder, rescanned per request;
//                                  never fails: an unreadable folder comes back as `error` with the
//                                  built-ins still listed)
// ---------------------------------------------------------------------------
/** A theme's resolved custom properties: theme key (`bg`, `ink-2`, `status-success`, `shadow-1`,
    `font-body`, `fs-body`, …) → the authored string, VERBATIM. shared/theme.ts CSS_PROPERTY maps
    each key to the custom property it lands on; `--focus-color` and `--focus-ring` are never in
    here (they track the accent through var(), spec/00-ground-rules.md §0). */
export type ThemeTokens = Record<string, string>;

/** One row of Settings → Themes (spec/12-settings-dialog.md §12). The server has already read,
    deref'd (`$name`) and validated the file, so every string here is safe to paint — which is
    what lets a row preview swatches and a font sample from a file nobody selected. */
export interface ThemeInfo {
  /** The file's basename without `.json`; the browser stores the choice under `sova:theme` (legacy
      `pi-web:theme` mirrored while the rename bridge is open). */
  id: string;
  /** The file's `name`. Empty on a broken row, where §12 shows the filename instead. */
  name: string;
  /** Where the file came from. A user file whose id matches a built-in replaces it. */
  source: "builtin" | "user";
  /** Absolute path of the file. §12 puts a user row's path in its `title`. */
  path: string;
  /** The base it extends: `data-theme` is set to this before its tokens are written. */
  base: "dark" | "light";
  /** The base's tokens overlaid by this theme's own — complete, so applying it needs no lookup.
      A broken row (`error` set) is never worn and gets no base fill: it carries only what it
      authored and we accepted, which is empty when the file never parsed. */
  tokens: ThemeTokens;
  /** Everything we declined to take from the file, in file order, each one a §12 reason line:
      a value we won't emit, an unknown key, a `$name` that didn't resolve. */
  warnings: string[];
  /** Set when the theme can't be worn: the file isn't JSON (the parser's own message), it has
      no name, or it holds a value we won't emit. §12 draws these as disabled rows. */
  error?: string;
  /** True on a user file that took a built-in's id — §12 says so in the row's meta line. */
  replacesBuiltin?: boolean;
}

/** GET /api/themes. Built-ins first (`dark`, `light`, then the rest by id), user themes after. */
export interface ThemeList {
  /** The folder a dropped-in theme goes in, absolute — §12 names it in the footer. */
  dir: string;
  themes: ThemeInfo[];
  /** Why the user folder couldn't be read, when it couldn't. The built-ins are listed anyway:
      the app's own themes don't depend on it (§12). A missing folder is not an error. */
  error?: string;
}

// GET /api/playbooks?cwd=…       -> PlaybookCatalog (server/playbooks.ts: the shipped playbooks/,
//                                  the user's ~/.pi/agent/sova/playbooks/, and the project's
//                                  <cwd>/.sova/marketing/playbooks/, rescanned per request. Never
//                                  fails: an unreadable user folder is `error`, and a cwd that can't
//                                  be listed — none given, remote, missing — is `project.state`)
// ---------------------------------------------------------------------------
/** One entry in the Sova playbook catalog. */
export interface PlaybookInfo {
  id: string;                 // directory name; validate against /^[a-z0-9][a-z0-9-]*$/ (no traversal)
  title: string;              // frontmatter title, else the id
  description: string;        // frontmatter description, else ""
  promptHint?: string;        // frontmatter promptHint: what the reader may want to specify for the first turn
  source: "sova" | "user" | "project";
  dir: string;                // ABSOLUTE directory holding the playbook (its PLAYBOOK.md, phases/, templates/)
  body: string;               // PLAYBOOK.md body, frontmatter stripped
  replacesSova?: boolean;     // a user playbook with the same id as a shipped one
}

/** GET /api/playbooks?cwd=<project cwd>  (cwd optional) */
export interface PlaybookCatalog {
  playbooks: PlaybookInfo[];
  /** Whether project-local playbooks (from <cwd>/.sova/marketing/playbooks/) could be listed at all. */
  project: { state: "ok" | "none" | "remote" | "missing"; message?: string };
  /** Set when the user playbook directory could not be read; the catalog still lists what it could. */
  error?: string;
}

// GET /api/settings              -> WebSettings
// PUT /api/settings              -> WebSettings (400 bad body; only the keys below are accepted)
// GET /api/settings/claude-status -> ClaudeCliStatus
// ---------------------------------------------------------------------------
/** Sova's own settings, stored in <agentDir>/sova/settings.json (server/web-settings.ts).
    Nothing outside Sova reads this file, so it is not a cross-process contract the way the
    subagent policy is. */
export interface WebSettings {
  experimental: {
    /** Offer the Claude Code CLI's models as first-class pi models. Default off. Drives the
        `claude-code-provider` extension flag, so it takes effect for sessions created after the
        change, not for ones already open. */
    claudeCodeProvider: boolean;
  };
}

/** Whether the Claude Code CLI is usable, for the Experimental tab's status line. `version` is
    what `claude --version` printed; `models` counts the claude-code-cli models currently
    registered with the runtime (0 while the toggle is off). `error` is set when the CLI could not
    be run at all — the two fields are then absent. */
export interface ClaudeCliStatus {
  version?: string;
  models?: number;
  error?: string;
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

// GET /api/files?cwd=…            -> FileIndex   (the composer's @-mention index, server/files.ts:
//                                  every non-ignored file under the cwd — gitignore-respecting in git
//                                  repos via git ls-files, the default ignore list elsewhere — cached
//                                  ~30s. 400 a relative cwd, 404 a missing folder, 501 an unmounted
//                                  remote session's placeholder cwd)
// ---------------------------------------------------------------------------
/** The @-mention file index for a session cwd: every non-ignored file under it as a "/"-separated
    path relative to the cwd, cut at the server's cap. The client (src/lib/files.ts, Composer's
    FileMenu) derives each completion level locally from this one list. */
export interface FileIndex {
  /** Non-ignored file paths relative to the cwd, "/"-separated. */
  files: string[];
  /** True when `files` was cut at the server's cap. */
  truncated: boolean;
}

// GET /api/sessions/git?path=<session file>&fresh=1 -> GitSummary   (server/git-summary.ts: the
//                                  whole repository containing the session's STORED cwd — locally
//                                  after the path map, or on its target through the argv builder.
//                                  Read-only, never fetches. 400 a bad path, 404 a missing session
//                                  file; everything else, a folder with no repository included, is a
//                                  200 whose `state` says so. Cached ~10s per folder; fresh=1 skips
//                                  the cache but still joins a read already running.)
// ---------------------------------------------------------------------------
/** What one side of a change did to a path: index vs HEAD (`staged`) or worktree vs index
    (`unstaged`), from git status's XY letters. */
export type GitChange = "modified" | "added" | "deleted" | "renamed" | "copied" | "type-changed";

/** One changed path. Paths are relative to the repository root, "/"-separated, as git wrote them;
    an untracked FOLDER (git collapses one it has never tracked) ends in "/". */
export interface GitFileChange {
  path: string;
  /** Rename or copy source, when git paired one. */
  from?: string;
  kind: "tracked" | "untracked" | "conflicted";
  staged?: GitChange;
  unstaged?: GitChange;
  /** A submodule's pointer or contents moved, not a file. */
  submodule?: true;
  /** Lines added/removed, worktree against HEAD (staged and unstaged together; against the empty
      tree in a repository with no commits). "binary" when git counts no lines. null when there is
      no count: always for untracked paths (git has nothing to diff them against), else see
      GitRepoSummary.lines for why. */
  lines: { added: number; removed: number } | "binary" | null;
}

/** Where the read ran: this machine, or the session's target. */
export type GitWhere = { kind: "local" } | { kind: "remote"; target: string };

export interface GitRepoSummary {
  state: "repo";
  where: GitWhere;
  /** The folder git ran in: the stored cwd, the moved folder when path-map.json rebased it
      (`moved`), or the remote cwd on a target. */
  cwd: string;
  /** The stored cwd no longer exists under that name and was read at its moved location. */
  moved?: true;
  /** The repository's top-level folder (absolute; a REMOTE path for a remote session). */
  root: string;
  head: { kind: "branch"; name: string } | { kind: "detached"; oid: string };
  /** No commit yet: `head` names the branch the first commit will create. */
  unborn: boolean;
  /** Divergence from the upstream as this repository last saw it (nothing fetches): `gone` when
      the branch tracks an upstream whose ref no longer exists locally. null: no upstream set. */
  upstream: { name: string; ahead: number; behind: number } | { name: string; gone: true } | null;
  /** Paths with staged changes, unstaged changes, untracked paths (a collapsed folder counts once)
      and unmerged paths. One path can count as both staged and unstaged. */
  counts: { staged: number; unstaged: number; untracked: number; conflicted: number };
  /** Nothing staged, unstaged, untracked or conflicted — and the status read was whole. */
  clean: boolean;
  /** The commit HEAD points at; null in an unborn repository or when git log failed. */
  lastCommit: { oid: string; subject: string; at: number } | null;
  /** Changed paths, conflicted first, then by path; cut at the server's cap (`filesTotal`). */
  files: GitFileChange[];
  /** Changed paths git reported, before the cap. */
  filesTotal: number;
  /** git status's output hit the server's byte cap or its time limit: `counts`, `files` and
      `filesTotal` are lower bounds, and `clean` is false. */
  statusPartial: boolean;
  /** Line counts: "ok" every tracked path was counted; "partial" the count output hit the byte cap;
      "timeout" counting took too long; "failed" git refused. Sums over counted paths only. */
  lines: "ok" | "partial" | "timeout" | "failed";
  /** Σ of `lines` over every counted path (not only the listed ones). */
  added: number;
  removed: number;
  /** When the server read it (ms epoch). A cached answer keeps its original time. */
  checkedAt: number;
}

export type GitSummary =
  | GitRepoSummary
  /** The folder is readable and no repository contains it. */
  | { state: "none"; where: GitWhere; cwd: string; moved?: true; checkedAt: number }
  /** Nothing could be read: `reason` is a sentence for the user (folder gone, target offline,
      git missing, took too long, a removed sshfs mount, git's own refusal). Never cached. */
  | { state: "unavailable"; where: GitWhere; cwd: string; reason: string; checkedAt: number };

// GET /api/sessions/context?path=<session file>&fresh=1 -> SessionSetup   (server/session-setup.ts:
//                                  what pi will LOAD for the session's STORED cwd — the context
//                                  files it writes into the prompt, and the skills it offers this
//                                  session, each with its size on disk. Read from the chat runtime
//                                  when this server holds it (the exact set that session prompts
//                                  with), else from pi's own loader WITHOUT extensions — a lower
//                                  bound, which `fromRuntime` says. Never remote: a target
//                                  session's cwd is a local placeholder, so its answer is
//                                  `state: "remote"` and the client shows the repository alone.
//                                  400 a bad path, 404 a missing session file; a folder that can't
//                                  be read is still a 200 whose `state` says so. Cached ~30s per
//                                  folder; fresh=1 skips the cache but joins a read already running.)
// ---------------------------------------------------------------------------
/** One file pi loads, with what it costs on disk. */
export interface SessionSetupFile {
  path: string;
  /** Bytes, as the file is on disk (never a decoded length). */
  bytes: number;
  /** Lines, counted the way `wc -l` counts them: newlines, plus one for a last line the file never
      terminated. An empty file has none. */
  lines: number;
}

/** One skill pi offers this session. `path` is its SKILL.md. */
export interface SessionSetupSkill extends SessionSetupFile {
  name: string;
  description?: string;
}

export type SessionSetup =
  | {
      state: "ok";
      where: { kind: "local" };
      /** The folder that was read: the stored cwd, or its moved location (then `moved`). */
      cwd: string;
      moved?: true;
      /** Context files, in the order pi layers them: global first, then ancestors, then the cwd. */
      context: SessionSetupFile[];
      /** Skills, in the order pi lists them to the model. A skill is OFFERED, not loaded: it loads
          when it is used. */
      skills: SessionSetupSkill[];
      /** A `.pi/SYSTEM.md` that replaces the default prompt, when one is loaded. */
      systemPrompt?: SessionSetupFile;
      /** APPEND_SYSTEM.md sources, in the order they are appended. */
      appendSystemPrompt?: SessionSetupFile[];
      /** True when the read came from the open chat runtime — the exact set this session prompts
          with. False: pi's loader without extensions, which cannot see a path an extension adds. */
      fromRuntime: boolean;
      checkedAt: number;
    }
  /** A target session: its cwd is a local placeholder, so its loadout can't be read here. */
  | { state: "remote"; where: { kind: "remote"; target: string }; cwd: string; checkedAt: number }
  /** Nothing could be read: `reason` is a sentence for the user. Never cached. */
  | { state: "unavailable"; where: GitWhere; cwd: string; reason: string; checkedAt: number };

/** Longest group name, in characters, after trimming (SessionGroup.name; the server trims and
    refuses an empty or longer one with 400). The one place the limit is written down: the create
    input's maxlength and the server's rule read it from here. */
export const GROUP_NAME_MAX = 60;

/** Longest session title the user can set, in characters, after trimming (POST /api/sessions/title;
    the same cap the derived title is cut to, so a renamed row is never taller than its neighbours).
    The one place the limit is written down: the rename field's maxlength and the server's rule
    both read it from here. */
export const SESSION_TITLE_MAX = 80;

/** Longest member label, in characters, after trimming (GroupMember.label; the server trims and
    refuses a longer one with 400, while an empty one clears the label). */
export const GROUP_LABEL_MAX = 40;

/** The session file format this server writes and considers current (the JSONL header's
    `version`). A file whose header carries a different version — or none, which reads as 1,
    pre-versioning — is `legacyFormat` in a summary and `old-format` as a fanout source refusal:
    reading one rewrites it wholesale. The SERVER owns this number and every comparison against
    it; a client that compared versions itself would drift on the next bump, which is exactly
    why SessionSummary.legacyFormat is a computed flag and not a raw version. */
export const CURRENT_SESSION_FORMAT = 3;

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
    Archive. Stored in ~/.pi/agent/sova/session-groups.json, keyed by session id (like the archive). */
export interface SessionGroup {
  /** Stable uuid; what `SessionSummary.groupId` and every route below take. */
  id: string;
  /** Shown as-is (trimmed, 1–60 chars). Duplicates are allowed: nothing keys on the name. */
  name: string;
  createdAt: string; // ISO
  /** Set only on a group Sova fanned out (fork mode): where its members came from. Lineage
      (`SessionSummary.parent`/`parentId`) says a session was forked from THAT file; only this
      says WHERE, so the fork marker and Align to Fork are seed-only and never infer a position
      from lineage. A hand-made group never grows one, which is what the auto-dissolve rule
      (AssignGroupResult.dissolved) stands on. */
  seed?: GroupSeed;
  /** Whether the group deletes itself when its last member leaves (AssignGroupResult.dissolved).
      Set ONLY by POST /api/session-groups/fanout when it CREATES the group with a generated name
      — Sova made it and named it, so Sova may remove it. NEVER set by that route's `groupId`
      path: a group the user named is theirs and keeps standing empty, even after it adopts a
      fanout's `seed`.
      THIS IS THE ONE TRUTH OF DISSOLUTION. It used to be inferred from `seed`, which is lineage
      and the fork marker's datum; that inference is what would have made an adopted hand-made
      group start deleting itself. Do not re-derive dissolution from another field, and do not
      use this one to mean anything but dissolution.
      A RENAME CLEARS IT (PATCH /api/session-groups/:id with a name that actually changes): the
      claim above is a conjunction — Sova made it AND named it — and renaming falsifies the
      second half, so the group becomes the user's and stands when emptied. Renaming to the same
      string revokes nothing, and reordering or relabelling never touch it. The flag is set and
      cleared by the events that make it true or false, so no rule has to be remembered.
      Absent only on a group written before this field existed — then, and only then, `seed`
      implies it, since those are Sova's own fanout groups. An explicit value always wins. */
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
  /** FANOUT ONLY, and only in a 201's `failed`: the model ref (`ModelInfo.ref`) of the member
      the entry names, so the partial-creation banner can compose "{model} couldn't start: …"
      without a lookup. TWO SHAPES OF ENTRY LIVE HERE, told apart by `id`:
      • EMPTY `id` (and empty `path`): a member that NEVER CAME INTO BEING — creation failed, so
        there is no session and `ref` is the ONLY handle on it.
      • `id` (and `path`) SET: a member that EXISTS — created and grouped — but was REFUSED ITS
        FIRST MESSAGE by the batch path (fresh mode's `text`). `id` names it and joins to the
        pane; `ref` is present too, so the banner can still name the model. A pre-existing
        member of a `groupId` target (not of this fanout) reports with `id` only — its model is
        not this fanout's to claim.
      A 409 refusal (the source) carries no `ref` on any route. As ever, `message` is the bare
      reason — never prefixed with the ref, which would render the model twice in the banner. */
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
      with `name` the route creates the group (and Sova owns it, so `autoDissolve` is set); with
      `groupId` it lands in an existing one, which keeps its own name. Sending both is a 400 —
      ignoring one of them silently would look like a rename that did nothing. */
  name?: string;
  members: FanoutMemberSpec[]; // array order IS pane order
  /** Fork mode: branch every member from this entry of this session. `leafId` is the leaf the
      dialog SHOWED the user, not a request for the server to find the current one. */
  source?: { path: string; leafId: string };
  /** Fresh mode: the folder every member is created in — checked by the New Session route's own
      rule (targets.ts validateNewSessionCwd: absolute, an existing directory, not a legacy
      mount cwd), so a folder that path refuses is a 400 with that path's own sentence
      BEFORE anything is made. */
  cwd?: string;
  /** Fresh mode only: the first message every member gets, sent through the batch path. Its
      outcome is PART OF THE 201: the batch's refusals are folded into `failed` (entries whose
      `id` names an existing member — see BatchRefusal.ref), so a fanout that created N members
      and started none says so instead of announcing a success that lands the user in N silent
      panes. The members are kept either way: real, empty, grouped sessions, retryable. */
  text?: string;
  /** Whether `name` is the default Sova generated, or one the user typed over it. The client
      holds this fact and nothing else can: the server never generated the default, so it cannot
      distinguish an accepted one from an identical string typed by hand. Reported as a FACT; the
      policy stays server-side, and `autoDissolve` is derived from it, never sent by a client.
      "generated" ⇒ Sova made AND named the group ⇒ `autoDissolve: true`.
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
      cannot make the claim at all, and treating it as Sova's deletes a name. Both spellings
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
      DERIVE IT FROM THE EDIT EVENT, never by comparing strings. Sova's client keeps
      `nameTouched`, set by the name field's own input handler and by nothing else, and sends
      "user" when it is set. "Typed over then reverted" is therefore "user": an empty group may
      be left behind, which is litter, recoverable in one gesture.
      THAT SIGNAL DOES TWO JOBS, and the second is invisible from the first: `nameTouched` also
      gates whether Sova may keep REGENERATING the field from the prompt. One decides whether we
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
      AND THE PROXY RUNS THE OTHER WAY from how it looks: under that gate, `name === lastWritten`
      is true exactly when the field was never touched — so the comparison is a DERIVED READING of
      the edit event, computed the long way and valid only while an invariant in another function
      holds. The edit flag is the direct measurement; the comparison is its correlate.
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
    not a result. `failed` carries the members that couldn't START, in two shapes told apart by
    `id` (see BatchRefusal.ref): an empty id names a member that never came into being (its own
    debris is unlinked; `ref` is the only handle); a set id names an EXISTING member that was
    created and grouped but refused its first message by the batch path — kept, retryable, `ref`
    beside the id so the banner can name the model. Nothing already created is ever rolled back.
    `group` is read back AFTER the members are assigned, so the one response the client navigates
    on carries the members this fanout just landed. */
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

/** POST /api/sessions/fork — one session branched off another at one entry, the per-message Fork
    action (spec 13's "Fork the session from here"). Unlike the fanout route this makes exactly one
    child, in no group, with no fanout member marker, and sends nothing.

    `entryId` is a `TranscriptItem.id`; an assistant BLOCK id (`<entryId>:<n>`, `<entryId>:stop` —
    server/transcript.ts gives one row per content block) is accepted and resolved to its entry, so
    the client can pass the row id it rendered without re-deriving the entry.

    `position` is pi's own pair (docs/sessions.md): "before" is `/fork` — branch through the
    entry's PARENT and hand the entry's own text back for the composer — and "at" is `/clone`,
    everything through the entry itself. */
export interface ForkRequest {
  path: string;
  entryId: string;
  position: "before" | "at";
}

/** What position "before" hands to the NEW session's composer: the original message, ready to
    edit and send again, and never sent for it. All three fields are the entry's own, so a fork of
    a message with images is a composer with those images — the approved difference from `rewound`,
    which hands back text only (pi's /tree parity).

    `text` is the DISPLAY text: pi-clipboard paths are stripped exactly as `TranscriptItem.text`
    strips them, because `attachments` stands in for them and the composer writes them back on
    send. Absent when the message was images only. */
export interface ForkEditor {
  /** Display text: pi's own clipboard paths are stripped exactly as `TranscriptItem.text` strips
      them, because `attachments` stands in for them and the composer writes them back on send.
      A path the USER TYPED is not stripped — that is their sentence, not a generated reference.
      Absent when the message was images only. */
  text?: string;
  /** Every image path the original text named, INCLUDING ones whose file is gone (`available:
      false`). The dead ones are kept on purpose: they are the only record that an image was part
      of this message, so the client can say "1 image couldn't come along" instead of dropping it
      silently. Stage the available ones; name the rest. */
  attachments?: TmpAttachment[];
  /** `data:<mime>;base64,<data>` for stored `ImageContent` blocks — the bytes the model saw — for
      images NOT already covered by an available entry in `attachments`. Re-upload these into the
      new session's draft.
      THE TWO CHANNELS NEVER OVERLAP, and it is settled by CONTENT rather than by assuming a
      message cannot carry both a path and its own bytes: the server hashes each still-readable
      attachment and drops any stored block with the same hash, because the FILE is the better
      carrier (it becomes a real draft attachment). So "in `attachments` and available" and "in
      `images`" partition the images that can travel, and `available:false` is the third case —
      neither, and the client must say so. Without that split a client cannot tell a re-upload from
      a duplicate, and the safe guess is to report images lost that were in fact sent. */
  images?: string[];
}

/** 201 body of POST /api/sessions/fork. The child is already web-owned (origin "web"), its header
    records `parentSession`, and its entries are the source's ACTIVE branch root→branch point with
    their ids preserved, so lineage ("Forked from") needs no extra call. */
export interface ForkResult {
  session: SessionSummary;
  /** Only for "before" on a user entry, and only when there is something to hand over. */
  editor?: ForkEditor;
}

/** Why a fork was refused (409 `{ refused }`). A CLOSED SET OF ITS OWN, deliberately not an
    extension of `BatchRefusalCode`: adding a member there would silently widen every exhaustive
    switch the fanout client already has. The codes that mean the same thing are spelled the same
    and carry the same server sentence, so one copy deck covers both routes.
    "not-on-branch" = the id is unknown or sits on an abandoned branch (after a rewind the file's
    TAIL is the abandoned one, so this is an ordinary state, not a corruption);
    "nothing-before" = "before" on the first entry, which has nothing in front of it to branch from. */
export type ForkRefusalCode =
  | "tui-live"
  | "mid-turn"
  | "busy"
  | "config"
  | "missing"
  | "old-format"
  | "not-on-branch"
  | "nothing-before"
  | "internal";

export interface ForkRefusal {
  path: string;
  code: ForkRefusalCode;
  message: string;
}

/** The mode extension's settings (pi-config/extensions/mode). One major mode, any set of minor
    modes. The mode itself is per session; `mode`/`minorModes`/`strict` here are the **default for
    new sessions** (~/.pi/agent/mode.json), never one chat's state. `strict` is shown, never
    changed here. `modes`/`minors` list what exists. */
export interface ModeInfo {
  mode: string; // "normal" | "delegate" (never the legacy "claude-heavy": the server reads that as "delegate")
  minorModes: string[]; // canonical order
  strict: boolean;
  modes: { id: string; description: string }[];
  minors: { id: string; description: string }[];
}

/** Delegate mode's four kinds of work, canonical order (pi-config/extensions/mode/delegate.ts). */
export type DelegateProfileId = "planning" | "investigation" | "routine" | "complex";
export type DelegateBackendId = "pi" | "claude-code";

/** One worker, exactly as agent_spawn receives it. pi models are "provider/modelId" and efforts
    are pi thinking levels; Claude Code models are the CLI's own ids. */
export interface WorkerChoice {
  backend: DelegateBackendId;
  model: string;
  effort: string;
}

/** The whole routing (the file's shape). `fallback: null` = none: an unavailable primary makes
    the orchestrator ask the user rather than pick a model itself. */
export interface DelegateSettings {
  version: 1;
  profiles: Record<DelegateProfileId, { primary: WorkerChoice; fallback: WorkerChoice | null }>;
}

/** GET /api/settings/delegate. `defaults` is what "Reset to defaults" fills in; `backends[].efforts`
    is every effort the backend accepts at all (a model may take fewer — see DelegateOptions). */
export interface DelegateSettingsInfo {
  settings: DelegateSettings;
  defaults: DelegateSettings;
  profiles: { id: DelegateProfileId; label: string; description: string }[];
  backends: { id: DelegateBackendId; label: string; efforts: string[] }[];
  /** Absolute path of the file, for the screen's footnote. */
  file: string;
}

/** A model a backend offers, with the efforts it takes. `denied`: the model policy keeps it from
    subagents (shown, still selectable — Delegate then uses the fallback or asks). */
export interface DelegateModelOption {
  id: string;
  name: string;
  efforts: string[];
  denied?: string;
}

/** `models: null` = discovery failed (`error` says why). That is not "offers nothing": saved
    values stay, unverified. */
export interface DelegateBackendOptions {
  id: DelegateBackendId;
  label: string;
  models: DelegateModelOption[] | null;
  error?: string;
  /** pi only: providers whose models exist per session, not globally (today the Claude Code
      provider, `claude-code-cli`, registered only in sessions started with it on). A model of one
      of these that `models` doesn't list is NOT VERIFIED, never "not offered". */
  sessionScopedProviders?: string[];
}

export interface DelegateOptions {
  backends: DelegateBackendOptions[];
}

/** PUT /api/settings/delegate: what is now stored, plus anything saved that could not be verified
    or that the policy refuses, one sentence each. */
export interface DelegateSaveResult extends DelegateSettingsInfo {
  warnings: string[];
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
  /** `clientId` is the SENDER'S OWN id for this send, chosen before the round trip. When the send
      is held in the outgoing queue it becomes that item's `QueueItem.id`, so the client can key
      its pending row by a value it already has instead of waiting to be told one. Omitted = the
      server allocates an id, and the row is only nameable from the next `queue` snapshot. */
  | { type: "prompt"; text: string; images?: OutboundImage[]; clientId?: string }
  | { type: "steer"; text: string; images?: OutboundImage[]; clientId?: string }
  | { type: "abort" }
  | { type: "set_model"; ref: string }   // calls session.setModel; server replies {type:"model"} or error
  | { type: "set_thinking"; level: string } // calls session.setThinkingLevel (clamped to the model); server replies {type:"thinking"}
  | { type: "ui_response"; id: string; value: unknown }
  /** Rewind to just before a user input on the active branch (the TUI's /tree on a user message):
      the tip moves to that message's parent and its text comes back for the composer. `id` is the
      client's request id, echoed in the `rewound`/`rewind_refused` reply; `entryId` is the user
      row's TranscriptItem.id. Refused while a turn streams or compacts (never auto-aborts). */
  | { type: "rewind"; id: string; entryId: string }
  /** Redo the turn an ASSISTANT entry belongs to: the server walks the active branch back from
      `entryId` to the nearest `role:"user"` message, rewinds to just before it (so the invisible
      rewind marker is written — legacy-spelled `pi-web-rewind` while the rename bridge is open —
      and the move survives a reload), and re-prompts that
      entry's STORED text and STORED images, unchanged, with the session's CURRENT model and
      thinking level — which is what makes switch-model-then-regenerate a comparison.
      `id` is the client's request id, echoed in `regenerated`/`regenerate_refused`; `entryId` is
      an assistant row's `TranscriptItem.id` (a block id `<entryId>:<n>` is accepted and resolved
      to its entry). A user entry is refused `not_on_branch` — Rewind is that gesture. Refused
      while a turn streams or compacts, and NEVER auto-aborts. The confirmation step is the
      client's; the server does not ask. */
  | { type: "regenerate"; id: string; entryId: string }
  /** Remove ONE still-unsent message from this chat's outgoing queue, by its `QueueItem.id` —
      any position, including the middle, duplicates of the same text, and image-only sends.
      `id` is the client's request id, echoed in the reply. */
  | { type: "queue_remove"; id: string; itemId: string };

/** Why a rewind was refused: busy = a TUI owns the session; recent = an unknown process wrote it
    (reconnect with force); not_on_branch = the id is unknown, not a user message, or not on the
    active branch; cancelled = an extension cancelled the navigation; internal = anything else.
    "queued" = messages are still waiting to go out. NOT the same condition as "streaming", and
    that is the whole reason it exists: `steer()` awaits the extension `input` handlers BEFORE
    queueing, so a steer carrying images on a non-vision model can still be in flight when the turn
    it meant to interrupt has already ended (CLAUDE.md documents that window). A rewind allowed
    then would move the leaf, and the queued message would be delivered into the NEW branch on the
    next run — the user's abandoned message resurrecting on the branch they rewound TO. Covers
    Sova's own queue and the SDK's, ours or an extension's, because any of them lands the same way.
    Reused verbatim by `regenerate_refused`: a regenerate IS a rewind plus a re-prompt, and a
    second near-identical union would be two names for one set of conditions. */
export type RewindRefusal = "streaming" | "compacting" | "busy" | "recent" | "not_on_branch" | "cancelled" | "queued" | "internal";

/** Why a regenerate was refused. Every RewindRefusal, plus one condition only a regenerate has.
    A SEPARATE union rather than a member added to RewindRefusal: widening that one would silently
    widen every exhaustive switch the existing rewind client already has.
    "wake" = the message that started the turn is a WAKE NUDGE — machine-generated text the
    scheduler wrote, not something the user said. Replaying it would put Sova's own nudge back on
    the branch as if the user had typed it, complete with its "[wake_nudge …] Scheduled wakeup
    fired" preamble and a stale elapsed time. There is no honest thing to re-send, so nothing is. */
export type RegenerateRefusal = RewindRefusal | "wake";

/** One message Sova is holding for this chat, not yet given to the model.
 *
 * `state` is the WHOLE removability contract, and the two values are not a cosmetic difference:
 * "queued" means Sova itself holds the item, so removing it is an array splice that can never
 * fail; "sending" means it has been handed to the pi SDK and may reach the model at any moment,
 * so a removal can come back refused. The UI must not offer the same promise for both.
 *
 * `text` is the RAW text as sent, never the skill/template expansion the SDK queues — the row has
 * to read as the user typed it. */
export interface QueueItem {
  /** Stable for the item's whole life; equals the sender's `clientId` when it gave one. */
  id: string;
  kind: "steer" | "followUp";
  state: "queued" | "sending";
  text: string;
  /** How many images ride with it. The bytes are never echoed back. */
  images?: number;
  /** "client" = a send from a Sova socket; "server" = Sova queued it itself (a group batch
      prompt, a remote status probe). Both are removable; the client decides what it shows. */
  origin: "client" | "server";
}

/** Why a `queue_remove` was refused, and nothing was removed.
    "consumed" = already delivered or drained (its `message_start` is on the way);
    "unknown" = no such id in this chat's queue;
    "shared_queue" = the item is in the SDK's hands AND the SDK queue also holds work Sova did
      not put there (extensions queue follow-ups: wake-nudge, btw, explain, subagents,
      command-palette). The only way to pull one item back out of the SDK is `clearQueue()`, which
      empties both its queues, so it is taken ONLY when Sova can prove our item is all that is in
      there. NOT TRANSIENT: once anything has been queued alongside ours, `hasQueuedMessages()` —
      the only public reader of the real queue in 0.86.1 — can never again attribute "something is
      queued" to our item, so the refusal holds for that message's whole life. Stop is the way out.
      Refusing is the point: dropping an extension's queued message to satisfy a removal would be
      exactly the silent loss this feature must not have;
    "busy" = a TUI owns the session, or a foreign writer was seen. */
export type QueueRemoveRefusal = "consumed" | "unknown" | "shared_queue" | "busy" | "internal";

/**
 * WHY an item left the queue. Every departure says so, to every client, because ABSENCE FROM A
 * SNAPSHOT IS NOT EVIDENCE OF DELIVERY: an item can vanish from `queue` because it was sent,
 * because someone else's tab removed it, because Stop cleared it, because the write guards refused
 * it at hand-off, or because an extension `input` handler swallowed it. Those demand opposite
 * things of the UI — one becomes a sent message, one disappears, two return text to a composer —
 * and a client that diffs snapshots cannot tell them apart. A reconnecting client that missed the
 * event is in exactly that position, which is why the snapshot is never the whole story and
 * `queue_item_gone` is broadcast rather than sent to whoever asked.
 *
 * "delivered" — handed to the model. A `message_start` for it is on its way (or already past).
 * "removed"   — a `queue_remove` took it; it will never be sent.
 * "cleared"   — Stop drained the queue; the text comes back in the same `queue_cleared`.
 * "failed"    — hand-off was refused (a TUI grabbed the file, a foreign writer, a model turned off
 *               in Settings). An `error` carries the reason and the text comes back to the draft.
 * "dropped"   — accepted, then nothing: an extension `input` handler returned `{action:"handled"}`,
 *               or the text was an extension command that ran instead of queueing. NO
 *               `message_start` will ever arrive for it, which is the case a client waiting for
 *               one would hang on forever.
 */
export type QueueGoneReason = "delivered" | "removed" | "cleared" | "failed" | "dropped";

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
      Only sent when something was queued. Now covers BOTH queues — the items Sova was holding
      (raw text) and the SDK's own (expanded) — in delivery order, SDK's first, and is followed by
      a `{ type: "queue", items: [] }`. */
  | { type: "queue_cleared"; steering: string[]; followUp: string[] }
  /** A rewind landed. Every client of the chat first got a fresh `hello` (the new branch) and a
      `mode` (re-resolved from it); only the requester then gets this, with the input's text for
      its composer (images are not handed back, as in pi's /tree). A rewind to the first input
      leaves an empty branch. */
  | { type: "rewound"; id: string; entryId: string; editorText: string }
  /** The rewind was refused and nothing changed; to the requester only, never as `error`.
      `message` is user-facing copy. */
  | { type: "rewind_refused"; id: string; entryId: string; reason: RewindRefusal; message: string }
  /** A regenerate landed. Every client of the chat first got a fresh `hello` (the new branch),
      `workers` and a `mode`, exactly as a rewind does; only the requester then gets this, and the
      re-prompted turn's own events follow it. `userEntryId` is the user message the server walked
      back to and replayed — the row the new turn hangs off. */
  | { type: "regenerated"; id: string; entryId: string; userEntryId: string }
  /** The regenerate was refused and NOTHING changed — no rewind, no prompt; to the requester only. */
  | { type: "regenerate_refused"; id: string; entryId: string; reason: RegenerateRefusal; message: string }
  /** Acceptance of one identified send, to its sender only, as soon as acceptance finishes.
      `queued: true` = a `QueueItem` with this id exists and a `queue` snapshot carries it;
      `queued: false` = the session was idle, so it went straight to the model and NO queue row
      will ever appear for it. Without this the client cannot tell "not queued" from "not yet
      acknowledged", and would offer a Remove button for something already on its way. */
  | { type: "send_ack"; clientId: string; queued: boolean }
  /** This chat's whole outgoing queue, in delivery order. Broadcast to EVERY client on every
      change (a send accepted, an item handed to the SDK, an item delivered, a removal, a Stop),
      and sent on attach right after `commands` — which is what lets a reconnecting client rebuild
      the pending rows its socket drop wiped, instead of showing an empty thread over a full queue.
      An empty queue still sends `{ items: [] }`: absence of a message is not evidence of an empty
      queue, and the client needs the difference to clear stale rows. */
  | { type: "queue"; items: QueueItem[] }
  /** One item left the queue, and WHY — broadcast to EVERY client, immediately before the `queue`
      snapshot that no longer contains it. This is the message a client acts on; the snapshot only
      says what is left. Two tabs on one chat therefore agree about a removal the other one made,
      and neither has to guess a reason from a diff (see QueueGoneReason).
      `text` is the raw text, present for every reason except "delivered".
      PRESENCE IS NOT PERMISSION TO RESTORE IT. The text is carried so a client CAN act, and the
      rule for whether it SHOULD is narrower than "it arrived" (operator ruling):
        • "dropped" and "failed" — restore, and only in the tab that sent it. These are the two
          departures with no other carrier and no `message_start` ever coming, so a client that
          ignores the text here loses the user's typing silently.
        • "removed" — NEVER restore, from this message or from the requester's `queue_removed` ack.
          Delete is a DISCARD: re-pasting a deleted message undoes the gesture the user just made.
          (`queue_removed.text` is therefore not load-bearing for a composer.)
        • "cleared" — never restore from here. Stop is the sole owner of that restore, through
          `queue_cleared`, because Stop means "take it back to edit and re-send".
      The second-tab hazard the body looks like it creates is answered by the ID, not by
      withholding it: `itemId` IS the sender's own `clientId`, so only the tab that typed a message
      can recognise it as its own. And nothing else re-sends this text — two carriers made the
      client restore the same message twice, which is why the synthetic `queue_cleared` that used
      to accompany a failed hand-off is gone. */
  | { type: "queue_item_gone"; itemId: string; reason: QueueGoneReason; text?: string }
  /** The requester's correlated ack for ITS `queue_remove` (`id` is that request's id): the
      removal is already public as `queue_item_gone` + `queue`, and this only closes the request
      that asked for it, so an in-flight request map can settle. */
  | { type: "queue_removed"; id: string; itemId: string; text: string }
  /** The removal was refused and the item is untouched; to the requester only. */
  | { type: "queue_remove_refused"; id: string; itemId: string; reason: QueueRemoveRefusal; message: string }
  // Codes: "busy" = a TUI owns the session (never retry with force); "recent" = file written by an
  // unknown process, at connect or mid-chat (client may reconnect with &force=1);
  // "reloaded" = runtime reloaded by another client, or message sent to a closed runtime (reconnect);
  // "config" = the session cannot be opened until something outside the server changes (its stored
  // cwd no longer exists). PERMANENT: show it once and stop reconnecting — retrying re-runs the
  // same failure and appends another banner. The socket closes 4422; "internal" closes 4500.
  // "internal" = server error, transient, safe to retry.
  /** `clientId` is set when the failure belongs to ONE identified send (its `clientId`), so the
      client restores that draft and no other. Absent on chat-wide errors, as before. */
  | { type: "error"; message: string; code?: "busy" | "recent" | "reloaded" | "config" | "internal"; clientId?: string };

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
// INSIGHTS (Sova insights team) — all GET, all read-only, never 500 on
// missing/corrupt sources: they return an honest empty/unavailable payload.
// ---------------------------------------------------------------------------
// GET /api/insights/usage          -> UsageInsight
// GET /api/insights/agents         -> AgentsInsight     (all live pi processes; poll ~5s)
// POST /api/upload                -> UploadResult 201  (raw image bytes; Content-Type: image/*; saved in /tmp)
// POST /api/upload?draft=<session path> -> UploadResult 201  (same, saved durably in that session's folder
//                                  <agent dir>/sova/attachments/<session id>/; 400 invalid session path, 404 no such session)
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
  /** A chat runtime embedded in this Sova server (own pid). Its mode is "rpc" like a headless
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
/** One rewind on the active branch: the invisible `pi-web-rewind` entry (bridge spelling; the
  * reader accepts `sova-rewind` too) Sova appends after
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
  /** The branch's rewinds, oldest first — the invisible markers Sova leaves when the chat goes
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
