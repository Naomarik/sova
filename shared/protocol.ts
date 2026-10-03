/**
 * Wire contract between server/ and src/. BOTH sides import these types.
 * Do not change a shape without telling the other side (team_msg).
 */

import type { WakeInfo } from "./wake";
import type { BatonMark, BatonSummaryField } from "./baton";
import type { LinkMessageInfo } from "./link-message";
import type { TopicBatchInfo } from "./topic-message";
import type { LinkedAgentInfo } from "./mesh-links";
import type { Permit } from "./overseer-grants";
import type { OverseerCard } from "./overseer-card";
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
  /** Who set the stored title (server/session-titles.ts, §app.session-list/auto-titles): "user"
      (the UI's rename, and every title stored before provenance existed), "overseer" (its
      sova_create_session / sova_set_session), or "auto" (Sova named it). Present whenever a title
      is stored for this session, even one equal to the derived title; absent when none is, and
      from older servers. "user" and "overseer" are explicit and never renamed automatically. */
  titleBy?: SessionTitleBy;
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
      was not branched, and from an older server. */
  parent?: string;
  /** The same parent as a session id (that session's `id`, read from its filename): what
      `GroupMember.id`, the group assignments and every group route key on. Set exactly when
      `parent` is. Use `parent` to link or open (routes take paths), `parentId` to match.
      LINEAGE ONLY: this pair says a session was forked from THAT file, never at WHICH entry, so
      no position in a transcript may be inferred from it. */
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
  /** This session has a stored composer draft: non-blank text or at least one image, the same
      test that lists a never-sent session. Set on ANY session, never-sent ones included (those
      also carry `draftPreview`, and their row says so on line 2 instead). The sidebar puts a
      pencil before the title from it, until this tab knows the draft itself — the tab's own copy
      wins, so a send or a cleared composer drops the pencil before the next list refresh.
      Absent: no draft, or an older server. */
  hasDraft?: true;
  /** This file is an Overseer file (current or historical): it carries the `sova-overseer` custom
      marker entry AND overseer-state.json names it (current or history); a marked fork of one is
      an ordinary session. Hidden from every sidebar region, search, Recent and cleanup count
      (src/lib/regions.ts `isMainThread`), like `workerSession`. Safe by absence. */
  overseer?: true;
  /** A baton session (§app/baton): its file lives in an attached organization's workspace repo and is
      registered there. Who holds the baton now, the state, and what the operator must do (Needs you:
      answer, or send a link). Safe by absence. */
  baton?: BatonSummaryField;
  /** Present on a project overseer's own session (§app/project-overseer): which project it
      oversees. Like `overseer`, it is never classified, tagged or listed for attention. */
  projectOverseer?: { projectId: string };
  /** A registered project's session (§app/projects): its overseer's conversations and the coding
      sessions it started, standalone or placed in an organization. */
  project?: SessionProject;
  /** An ORGANIZATIONAL session (§app.session-list/organizations): the org's own records make it one —
      every file in an attached org's workspace `sessions/` (baton sessions, offers, the project
      overseer's current and cleared conversations, any unregistered file there), and every coding
      session a project's build statecharts record (the overseer's `coding`, Start coding session's
      `operator-coding`), until its project retires it (r11). Never inferred from the folder: a session the operator opens by hand in a
      project root, a fork or copy of an org session, and anything on a host where the org is not
      attached are ordinary. The sidebar lists these only in its Organizations region. Safe by absence. */
  org?: SessionOrg;
  /** The session's profile (§chat.profiles/model), from the newest `sova-profile` entry before its
      first user message; absent for Default. */
  profile?: SessionProfileField;
  /** Activity from this session's live record (a TUI's, or this server's own runtime): the
      sessions extension's `presence.activity`. Absent when no live record reports one (closed
      sessions, older writers). `error` is set only for state "error", ≤200 chars. */
  activity?: { state: "working" | "idle" | "needs-input" | "error"; since?: number; error?: string };
  /** Hosted by this server and waiting on an extension dialog a browser can answer right now
      (live-pending, not a headless fallback): how many. Absent = none. */
  pendingDialogs?: number;
  /** When a Sova chat or watch socket last attached to or detached from this session (ms epoch),
      from `<stateRoot>/seen.json`. Absent = never seen by Sova. */
  seenAt?: number;
  /** Something happened in this session since `seenAt` (its last finished assistant reply is
      newer, and it is not mid-turn): the sidebar's unread dot. Any session with a stamp, whatever
      its origin; a session never stamped is never unread. Server-computed from the same seen
      store the Overseer digest uses. The tab showing the session hides its own dot. Safe by absence. */
  unread?: true;
  /** The file's last finished assistant reply stopped with pi's `stopReason: "error"`, the session
      is not mid-turn or on screen, and it has not been seen since that reply (a session never
      stamped shows it too). `message` = the reply's errorMessage, ≤300 chars. The sidebar's red
      mark in the unread dot's place, and the digest's act "error" item. Server-computed, needs no
      decisions feature; an aborted turn is not an error. Safe by absence. */
  turnError?: { message?: string; /** The failed turn's own model's provider, when known. */ provider?: string };
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
  | "link" // a link message from a linked session on another host (§mesh.links/transcript): a real
           // role:"user" message tagged "[link_msg lk_… lm_…] …" (shared/link-message.ts). Renders
           // NOTHING in the thread and is never counted among hidden rows; a turn start, never an
           // input (inputs count, Timeline, rewind targets). See `link`.
  | "topic" // a batch of notes pushed to a topic this session opened (§chat.topics/row): a real
            // role:"user" message tagged "[topic <name> tb_…, n notes] …" (shared/topic-message.ts).
            // Renders as a compact Queue card, never a "You" bubble; a turn start, never an input.
            // See `topic`.
  | "assistant-text"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "info" // session_info, model_change, compaction, labels, branch summaries etc.
  | "report" // subagent reports and other long extension messages (custom_message); see `report`
  | "worktree-merge" // a merge the session recorded (pi-config worktrees extension); see `worktreeMerge`
  | "align" // an `align` tool result that changed an alignment, or an exemption (pi-config mode extension); see `align`
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
  /** kind "link" only: the parsed tag (shared/link-message.ts `parseLinkMessage`). `text` holds the
      whole message exactly as delivered. */
  link?: LinkMessageInfo;
  /** kind "topic" only: the parsed batch (shared/topic-message.ts `parseTopicBatch`). `text` holds
      the whole message exactly as delivered. */
  topic?: TopicBatchInfo;
  /** "provider/model" that produced this row: the assistant message's own provider/model,
      else the nearest prior model_change on the branch. Set on assistant-text, thinking and
      tool-call rows; absent on other kinds and entries with neither (renderers fall back to
      the session's current model). */
  model?: string;
  /** Overseer markers, both invisible `custom` entries (never LLM context, ignored by the TUI):
      - `sent`: `customType:"sova-overseer-sent"`, data `OverseerSentMarkerData`. The row itself
        renders NOTHING; the client tags the user row whose id is `targetId` with an "Overseer" tag.
        Arrives in `hello`/`snapshot` and, when written during a live chat, in an `append`, so it
        may arrive before or after its target row: clients resolve by id, order-free.
      - `dialog-answer`: `customType:"sova-overseer-dialog-answer"`, data
        `OverseerDialogAnswerData`. Rendered as a machine row; `text` = "Overseer chose: <answer>".
      Present only on such rows (kind "info"). */
  overseerMark?:
    | { kind: "sent"; targetId: string }
    | { kind: "dialog-answer"; title: string; answer: string };
  /** Baton markers (§app.baton/attribution), invisible `custom` entries, present only on such rows
      (kind "info"). Person refs are ids ("operator" or a roster person's id); the client names them
      from GET /api/baton's `names`.
      - `sent` (`sova-baton-sent`): renders NOTHING itself; the client tags the user row `targetId`
        with its sender's name, resolving by id in either arrival order, like the Overseer's.
      - `handoff`, `decision`, `done`, `offer`, `lease`, `proposal`, `wrapup`: rendered as cards
        (`BatonMark` in shared/baton.ts is the full union). */
  batonMark?: BatonMark;
  /** A message another session sent (§chat.profiles/delivery): the invisible `sova-session-sent`
      entry. Renders nothing itself; the client draws the sender header above the user row
      `targetId` (resolving by id in either arrival order) and hides that row's header line. */
  sessionMark?: { kind: "sent"; targetId: string; from: { sessionId: string; title: string }; hop: number };
  /** The session's `sova-profile` entry (§chat.profiles/after-first-message): kind "info", drawn as
      the muted "Profile: {label}" row only once a user message is on the branch; null = Default. */
  profileMark?: { profile: SessionProfileField | null };
  /** kind "info" only: a subagents-team-event-v1 entry; `text` is `Team: ` + its sentence. */
  teamEvent?: TeamEvent;
  /** kind "worktree-merge" only: the `worktree-merge` extension message's details (§chat.worktrees/merge-card).
      `text` is the one line the model read ("Merged feat/x into master at abc1234, 5 commits, +120 −30"). */
  worktreeMerge?: WorktreeMergeInfo;
  /** kind "align" only: the `align` tool result's `details`, checked by the extension's own
      `normalizeAlignDetails` (pi-config/extensions/mode/align.ts, §chat.alignment/state): the
      touched document's snapshot after the call, or an exemption. `toolCallId` pairs it with its
      call, whose tool-call row renders nothing once this row is there. A failed call, a `get`, or
      details that don't check out stay an ordinary tool-result. */
  align?: AlignRowInfo;
  raw: unknown;
}

/** An alignment (§chat.alignment/document), as the `align` tool's snapshot carries it. The
    extension's AlignDocument (pi-config/extensions/mode/align.ts) is this shape. */
export interface AlignDocInfo {
  id: string; // "al_3"
  title: string;
  summary: string;
  findings: { id: string; text: string }[];
  approach: { id: string; text: string }[];
  rejected: { id: string; option: string; why: string }[];
  questions: AlignQuestionInfo[];
  /** The stored lifecycle; status is derived (alignStatus): implementing/done/dropped from here,
      else "aligning" while a question is open or there are none, else "confirmed". */
  phase: "open" | "implementing" | "done" | "dropped";
  droppedWhy?: string;
  next: { f: number; a: number; x: number; q: number };
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlignQuestionInfo {
  id: string; // "q3"
  topic: string;
  ask: string;
  context?: string;
  options?: { label: string; tradeoff: string }[];
  recommendation: { choice: string; why: string };
  decision?: { text: string; by: "user" | "accepted-recommendation"; at: string };
  dropped?: { why: string; at: string };
}

export type AlignChangeInfo =
  | { kind: "created"; fromFile?: true }
  | { kind: "added" | "edited" | "removed"; ids: string[] }
  | { kind: "decided" | "reopened" | "question-dropped"; q: string }
  | { kind: "accepted"; qs: string[] }
  | { kind: "status"; to: "implementing" | "done" | "open" }
  | { kind: "dropped" };

/** An `align` call's details: `doc` (the snapshot after a changing call) or `exempt`; `line` is the
    changes in words ("q3 decided · +q11"). */
export interface AlignRowInfo {
  v: 1;
  doc?: AlignDocInfo;
  changes: AlignChangeInfo[];
  line: string;
  exempt?: { why: string };
}

/** A merge the session recorded: by its `worktree merge` tool, or detected after one of its turns. */
export interface WorktreeMergeInfo {
  path: string;
  branch: string;
  target: string;
  /** The target's commit after the merge (full); for a detected merge, the commit that brought the branch in. */
  sha: string;
  /** Commits the merge brought into the target; for a detected merge, the branch's own, as are `added`/`removed`. */
  commits: number;
  added: number;
  removed: number;
  fastForward: boolean;
  how: "tool" | "detected";
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
  /** source "align-doc" only: an OLDER session's align document (custom entry, full snapshot per
      revision, from before the `align` tool; read-only; only the newest on the branch becomes a row). `body` is its markdown verbatim,
      open questions as "1. [ ] …" / "2. [x] … — decision" checklist items; `agent` is absent. */
  align?: AlignReportInfo;
  /** source "explain-doc" only: a forked /explain subagent finished and wrote its HTML page +
      meta to the explanations store. `preview` is the topic; `agent` is absent. */
  explain?: ExplanationInfo;
  /** customType "team-report" / "team-question" only, when the subagents extension's header parsed
      (server/reports.ts parseTeamMessage). `body` is then the message without its header and
      trailer lines; `agent` is absent, so the row is never a finished-worker marker. */
  team?: TeamMessageInfo;
}

/** A coordinated team's message to the operator, parsed from its header:
    `[Team report from coordinator <role> (<ag_NN>), <team_NN> — <team name>[ · milestone|concern]]` or
    `[Team question from <role>[, orchestrator] (<ag_NN>), <team_NN> — <team name>]`.
    Informational (report) or answered by the main thread (question); never an input of its own. */
export interface TeamMessageInfo {
  kind: "report" | "question";
  role: string; // "coordinator"
  workerId: string; // "ag_01"
  teamId: string; // "team_01"
  teamName: string;
  /** Question only: the asker is its team's orchestrator (a coordinator always is). */
  orchestrator?: boolean;
  /** Report only: the header's ` · <kind>` suffix, else a leading "Milestone:" / "Concern:" line
      (removed from `body`); absent when neither says. */
  label?: "milestone" | "concern";
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
  /** LIVE ONLY: the /explain run was spawned and has not settled, so there is no page yet and
      `summary` is "". Appears ONLY on a transcript row's `report.explain`, and only until the
      run's final entry (same `id`) replaces it; never in SessionInsight.explanations or
      GET /api/explanations, which carry openable pages only. A finished entry has no status at
      all — there is no "done" value.
      "interrupted": the run's parent stopped (a restart or /reload) before the run settled, and the
      extension settled it at the session's next prompt. Always with `note` (a complete page was on
      disk anyway: it links) or `error` (no page). Rows, and SessionInsight.explanations when it has
      a page. */
  status?: "running" | "interrupted";
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
  name: string; // basename
  mimeType: string;
  size: number;
}

/** GET /api/sessions/dir: the sessions folder this server lists (its agent dir's `sessions`), with its home folder so a page can show it as `~/…`. */
export interface SessionsDirInfo {
  sessionsDir: string;
  home: string;
}

// ---------------------------------------------------------------------------
// REST (JSON)
//
// GET  /api/sessions/dir        -> SessionsDirInfo
// GET  /api/sessions            -> SessionSummary[]
// POST /api/sessions { cwd }    -> SessionSummary   (creates a NEW empty webapp-owned session)
// POST /api/sessions { target, remoteCwd } -> SessionSummary   (remote session: creates the local placeholder
//                                  ~/.pi/agent/sova/targets/<target>/<remoteCwd> and a session there; 400 bad body/
//                                  non-absolute remoteCwd, 404 unknown target)
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
//                                  (puts one session in a group, or takes it out with null. It never deletes
//                                  a group: one whose last member leaves stands empty, an older build's
//                                  `autoDissolve` group included. `label` sets the
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
//                                  no slash commands — images belong to a pane composer.
//                                  400 bad body, blank text, members not an array of strings, an id that is
//                                  not a member, or the group is empty; 404 unknown group; 409 refused)
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
// PUT  /api/models/favorite { ref: "provider/id", favorite: boolean } -> ModelFavoriteResult   (stars or unstars one
//                                  model in the command-palette's ~/.pi/agent/model-favorites.json, through the palette's
//                                  own ModelFavorites: re-read under its lock, then an atomic replace, so the TUI's Ctrl+F
//                                  and this share one file and one writer. The ref splits at its first "/" and is not checked
//                                  against the available models. 400 bad body or ref; 409 "Favorites are locked; retry…"
//                                  (another writer mid-save); 500 anything else the store refused — a malformed file is
//                                  reported, never overwritten)
// GET  /api/attachment?path=…   -> image bytes (TmpAttachment.path; only /tmp/<name> or <agent dir>/sova/attachments/
//                                  <session id>/<name>, .png|jpg|jpeg|webp|gif, ≤ 20MB; 400 bad shape, 403 resolves
//                                  outside /tmp / the attachments root or too large, 404 missing)
// DELETE /api/attachment?path=… -> { ok: true }   (removes one file under the attachments root, e.g. a composer
//                                  chip's remove; 403 anything else, /tmp included; 400 no path; 404 missing)
// GET  /api/mode                -> ModeInfo   (the DEFAULT for new sessions: ~/.pi/agent/mode.json; missing file → defaults)
// POST /api/mode { mode?, minorModes? } -> ModeInfo   (writes that default only, merged into the fresh file with the
//                                  other fields kept. No open chat changes. 400 bad body or unknown name.)
// POST /api/mode?path=… { mode?, minorModes? } -> ChatModeResult   (switches THAT chat only, from its next message;
//                                  mode.json is not written — a switch changes nothing but this chat, new or not.
//                                  400 bad body/unknown name/bad path,
//                                  404 that session isn't held open by this server)
// POST /api/mode?path=… { saveDefault: true } -> ModeInfo  (makes that chat's OWN mode and minor modes the
//                                  default new sessions start from — the file GET /api/mode reads. Switches nothing.
//                                  saveDefault stands alone: a body naming a mode as well is a 400, because the save
//                                  takes the chat's state, never the body's fields. 400 without ?path=, no body,
//                                  or saveDefault that isn't true; 404 that session isn't held open by this server)
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
// GET /api/settings/spec                -> SpecSettingsInfo (~/.pi/agent/mode-spec.json; missing → writer null)
// GET /api/settings/spec/options        -> DelegateOptions (the same discovery as delegate/options)
// PUT /api/settings/spec SpecSettings   -> SpecSaveResult (replaces the writer; writer null = none, the session
//                                          writes the spec itself. 400 bad shape, or a CHANGED tuple its backend
//                                          answered it can't run; unverifiable or policy-denied tuples save with a
//                                          warning. Sessions with spec on, in either major mode, pick it up at
//                                          their next turn)
// GET/PUT /api/settings/team(/options): Settings → Teams, in shared/team-defaults.ts
// ---------------------------------------------------------------------------

// GET /api/settings/summarizer  -> SummarizerSettingsInfo (~/.pi/agent/topic-outline.json's `summarizers`; missing
//                                   or none usable → the extension's defaults, as it reads them)
// PUT /api/settings/summarizer SummarizerSettings -> SummarizerSettingsInfo (replaces the chain with primary +
//                                   optional fallback; every other key of the file, and a kept entry's own
//                                   timeout/budget, is written back unchanged. 400 bad body, 409 the file
//                                   exists but isn't a JSON object. Read by the TUI and every runtime at
//                                   session start, so it applies to sessions started afterwards)
// ---------------------------------------------------------------------------
/** The topic-outline extension's summarizer backends: the Claude Code CLI (a bare alias or id,
    e.g. "haiku") or a pi model ("provider/model"). */
export type SummarizerBackend = "claude-code" | "pi";
export interface SummarizerChoice {
  backend: SummarizerBackend;
  model: string;
}
/** The chain the summary line is written by: the primary, then the fallback when the primary
    fails or the model policy turns it off. */
export interface SummarizerSettings {
  primary: SummarizerChoice;
  fallback: SummarizerChoice | null;
}
export interface SummarizerSettingsInfo {
  settings: SummarizerSettings;
  /** The extension's built-in chain (pi-config/extensions/topic-outline/config.ts). */
  defaults: SummarizerSettings;
  /** The file is missing or names no usable summarizer, so `settings` are the defaults. */
  usingDefaults: boolean;
  /** Usable summarizers the file lists after the second. They run, this screen can't show them,
      and a save here drops them. */
  beyond: number;
  /** Set when the file exists but can't be read as a JSON object: the extension runs the
      defaults, and a save is refused rather than overwrite it. */
  unreadable?: string;
  /** Absolute path of the file, for the screen's footnote. */
  file: string;
}

// GET /api/settings/models      -> ModelPolicy (empty lists when nothing is disabled)
// PUT /api/settings/models      -> ModelPolicy (replaces the whole policy; 400 bad body)
// ---------------------------------------------------------------------------
/** Which providers and models may be used, and which of them subagents may be given (Settings →
    Models).

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
    here (they track the accent through var()). */
export type ThemeTokens = Record<string, string>;

/** One row of Settings → Themes. The server has already read,
    deref'd (`$name`) and validated the file, so every string here is safe to paint — which is
    what lets a row preview swatches and a font sample from a file nobody selected. */
export interface ThemeInfo {
  /** The file's basename without `.json`; the browser stores the choice under `sova:theme`. */
  id: string;
  /** The file's `name`. Empty on a broken row, where the settings dialog spec shows the filename instead. */
  name: string;
  /** Where the file came from. A user file whose id matches a built-in replaces it. */
  source: "builtin" | "user";
  /** Absolute path of the file. The settings dialog spec puts a user row's path in its `title`. */
  path: string;
  /** The base it extends: `data-theme` is set to this before its tokens are written. */
  base: "dark" | "light";
  /** The base's tokens overlaid by this theme's own — complete, so applying it needs no lookup.
      A broken row (`error` set) is never worn and gets no base fill: it carries only what it
      authored and we accepted, which is empty when the file never parsed. */
  tokens: ThemeTokens;
  /** Everything we declined to take from the file, in file order, each one a settings-dialog reason line:
      a value we won't emit, an unknown key, a `$name` that didn't resolve. */
  warnings: string[];
  /** Set when the theme can't be worn: the file isn't JSON (the parser's own message), it has
      no name, or it holds a value we won't emit. The settings dialog spec draws these as disabled rows. */
  error?: string;
  /** True on a user file that took a built-in's id — the settings dialog spec says so in the row's meta line. */
  replacesBuiltin?: boolean;
}

/** GET /api/themes. Built-ins first (`dark`, `light`, then the rest by id), user themes after. */
export interface ThemeList {
  /** The folder a dropped-in theme goes in, absolute — the settings dialog spec names it in the footer. */
  dir: string;
  themes: ThemeInfo[];
  /** Why the user folder couldn't be read, when it couldn't. The built-ins are listed anyway:
      the app's own themes don't depend on it. A missing folder is not an error. */
  error?: string;
}

// GET /api/playbooks?cwd=…       -> PlaybookCatalog (server/playbooks.ts: the shipped playbooks/,
//                                  the user's ~/.pi/agent/sova/playbooks/, and the project's
//                                  <cwd>/.sova/marketing/playbooks/, rescanned per request. Never
//                                  fails: an unreadable user folder is `error`, and a cwd that can't
//                                  be listed — none given, remote, missing — is `project.state`)
// ---------------------------------------------------------------------------
/** The file a playbook folder is read from, in the order it is looked for (§chat.playbooks/where-playbooks-come-from). */
export const PLAYBOOK_ENTRIES = ["PLAYBOOK.md", "SKILL.md"] as const;
export type PlaybookEntry = (typeof PLAYBOOK_ENTRIES)[number];

/** One entry in the Sova playbook catalog. */
export interface PlaybookInfo {
  id: string;                 // directory name; validate against /^[a-z0-9][a-z0-9-]*$/ (no traversal)
  title: string;              // frontmatter title, else name, else the id
  description: string;        // frontmatter description, else ""
  promptHint?: string;        // frontmatter promptHint: what the reader may want to specify for the first turn
  source: "sova" | "user" | "project";
  dir: string;                // ABSOLUTE directory holding the playbook: its entry file, scripts/, references/…; every relative path in it resolves here
  entry: PlaybookEntry;       // the file read as the playbook: PLAYBOOK.md when the folder has one, else SKILL.md
  body: string;               // the entry file's body, frontmatter stripped
  replacesSova?: boolean;     // a user playbook with the same id as a shipped one
  /** Its schedule (§chat/schedules), when its frontmatter has `when:`. */
  schedule?: PlaybookSchedule;
}

/** A schedule's state as the Playbooks dialog and the permits panel read it (§chat.schedules/where-shown). */
export type ScheduleState = "needs-approval" | "active" | "paused" | "invalid" | "not-project";

/** A playbook's schedule in its catalog row. */
export interface PlaybookSchedule {
  /** The `when:` line as written. */
  when: string;
  /** The schedule in words ("Every 30 min · When a Claude limit resets"); absent when invalid. */
  text?: string;
  profile?: string;
  profileLabel?: string;
  tz?: string;
  state: ScheduleState;
  /** `sN`, once Sova knows the schedule. */
  id?: string;
  /** Why it is invalid or paused, or where schedules run. */
  reason?: string;
  /** What an approval would cover (§chat.schedules/approval): sent back with the approve. */
  pin?: string;
  /** The next time fire, ISO (active only). */
  next?: string;
}

/** One fire of a schedule, as the permits panel lists it. */
export interface ScheduleFire {
  at: string;
  trigger: string;
  kind: "new" | "wake" | "reset";
  sessionId?: string;
}

/** A schedule Sova knows of (GET /api/schedules, OverseerAutonomy.schedules). */
export interface ScheduleInfo extends PlaybookSchedule {
  id: string;
  /** The project root the playbook is in, and its name. */
  root: string;
  projectName: string;
  playbook: string;
  title: string;
  fires: ScheduleFire[];
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

// ---- Claude logins (Settings → Accounts, §app.claude-logins) ------------------------------------
// The registry is the claude-code extension's (pi-config/extensions/claude-code/accounts.ts); these
// are its wire shapes. Nothing here ever carries a token, a code or a credential.

/** Who a login is, from Claude Code's own `.claude.json`. */
export interface ClaudeLoginIdentity {
  accountUuid?: string;
  email?: string;
  orgUuid?: string;
  orgName?: string;
  plan?: string;
  rateLimitTier?: string;
  /** The plan as people say it ("Max 20x", "Pro"), from the tier or the plan; absent when neither names one. */
  planLabel?: string;
}
/** A login's standing on this host: usable, out until a limit resets, or out until signed in again. */
export type ClaudeLoginStanding =
  | { state: "ready" }
  | { state: "limited"; until: number; window?: string }
  | { state: "auth"; message?: string };
export interface ClaudeLoginRow {
  /** `default` (Claude Code's own directory) or `l-` and 8 hex digits. */
  id: string;
  label?: string;
  identity: ClaudeLoginIdentity | null;
  /** false: never chosen automatically. */
  enabled: boolean;
  standing: ClaudeLoginStanding;
  /** Its directory holds `.credentials.json`. */
  signedIn: boolean;
  addedAt?: number;
}
/** The add-login flow (`claude auth login` for a new directory); one at a time per host. */
export type ClaudeLoginFlowState =
  | { state: "starting" }
  /** The URL to open in any browser; `error` after a code the CLI refused (it keeps waiting). */
  | { state: "waiting"; url: string; error?: string }
  | { state: "finishing" }
  | { state: "done"; login: ClaudeLoginRow; sharedAccount: boolean }
  | { state: "failed"; error: string };
/** GET /api/claude/accounts, and the answer of every change. */
export interface ClaudeAccountsInfo {
  /** This host as a device: its mesh id and name, else `local` / "This device". */
  device: { id: string; label: string };
  /** This device's logins, in its order, `default` included. */
  logins: ClaudeLoginRow[];
  /** Logins assigned to another device (listed, never used here). */
  elsewhere: { id: string; device: string | null; label?: string; identity: ClaudeLoginIdentity | null }[];
  /** The registry could not be read: only `default` is used, and nothing is written. */
  error?: string;
  flow: ClaudeLoginFlowState | null;
  /** The pool of logins across the mesh (§app.claude-logins/pool); absent while the mesh is off. */
  pool?: ClaudePoolInfo;
}
/** A device of the mesh, as the pool shows it. */
export interface ClaudePoolDevice {
  id: string;
  label: string;
  self: boolean;
  /** Reachable now (this device always is). */
  up: boolean;
  /** Logins it holds and uses (not the free ones it keeps). */
  logins: string[];
}
/** Where a login is. `stuck`: held by a device that is offline (nobody reclaims it). */
export interface ClaudePoolHolder {
  device: string;
  label: string;
  free: boolean;
  stuck: boolean;
  /** When it got there (the holder's clock). */
  since: number;
}
export interface ClaudePoolLogin {
  id: string;
  label?: string;
  identity: ClaudeLoginIdentity | null;
  addedAt: number;
  enabled: boolean;
  holder: ClaudePoolHolder;
  /** "Always give this login to" that device. */
  pin: string | null;
  /** As the login's last holder reported it. */
  standing: ClaudeLoginStanding;
  usage?: { fiveHour?: number; fiveHourResetsAt?: number; sevenDay?: number; sevenDayResetsAt?: number; at: number };
  /** A move this device has under way for it (its own journal). */
  moving?: { op: "lend" | "borrow" | "leave"; state: string; reason?: string; peer?: string };
  /** Return was asked and the holder has not returned it yet. */
  returnAsked?: boolean;
}
export interface ClaudePoolInfo {
  self: string;
  keeper: { id: string | null; label: string; up: boolean };
  devices: ClaudePoolDevice[];
  /** Every login of the pool, in the pool's order. */
  logins: ClaudePoolLogin[];
  /** This device never holds a subscription login (it syncs API keys only). */
  apiKeysOnly?: boolean;
}
/** PUT /api/claude/pool/keeper */
export interface ClaudePoolKeeperRequest { device: string }
/** PATCH /api/claude/pool/:id */
export interface ClaudePoolLoginPatch { pin?: string | null }
/** The chat's Claude login, as the composer foot shows it. */
export interface ChatClaudeLogin {
  id: string;
  /** Its label, else its email, else "default" / its id. */
  name: string;
  email?: string;
  planLabel?: string;
  /** true: from the session's own `claude-login` entry; false: not recorded yet, so the login this
      host would choose for the session's next start. */
  recorded: boolean;
  /** This host lists more than one login: only then is the choice worth showing. */
  several: boolean;
  /** A pick waiting for the running reply to end, or being applied (a borrow in flight)
      (§app.claude-logins/switch-queue). */
  pending?: { id: string; name: string };
}
/** How every refusal of `set_claude_login` begins, so the chat shows it as that switch's banner. */
export const LOGIN_UNCHANGED = "Claude login unchanged:";
/** PUT /api/claude/accounts/order */
export interface ClaudeLoginOrderRequest { order: string[] }
/** PATCH /api/claude/accounts/:id */
export interface ClaudeLoginPatchRequest { enabled?: boolean; label?: string | null }
/** POST /api/claude/accounts/flow/code */
export interface ClaudeLoginCodeRequest { code: string }


/** PUT /api/models/favorite's body. */
export interface ModelFavoriteRequest {
  /** "provider/id", as in ModelInfo.ref. */
  ref: string;
  favorite: boolean;
}

/** PUT /api/models/favorite's answer: the state now on disk for that ref (the request's, echoed). */
export interface ModelFavoriteResult {
  ref: string;
  favorite: boolean;
}

export interface ModelInfo {
  /** "provider/modelId" — the canonical ref used in set_model. */
  ref: string;
  provider: string;
  id: string;
  /** Mirrors the command-palette extension's favorites when its storage is readable (a malformed
      file lists none). Toggled with PUT /api/models/favorite. */
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
      independent of any session, so two models can be compared by it;
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

/** One commit, as `git log` writes it: the raw oid, the subject as recorded, and when it was made.
    Subjects are never relabelled or folded — the repository's own words are the record. */
export interface GitCommit {
  oid: string;
  subject: string;
  at: number;
}

/** Where the read ran: this machine, or the session's target. */
export type GitWhere = { kind: "local" } | { kind: "remote"; target: string };

export interface GitRepoSummary {
  state: "repo";
  where: GitWhere;
  /** The folder git ran in: the stored cwd, or the remote cwd on a target. */
  cwd: string;
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
  /** The commit HEAD points at; null in an unborn repository or when git log failed. The newest
      of `commits`, sent on its own because a reader that only ever needs the last one (the session
      pane's Session tab, its Repository section) shouldn't have to take a list apart; a test pins
      the two to the same commit. */
  lastCommit: GitCommit | null;
  /** The repository's recent commits, newest first, at most `RECENT_COMMITS` of them
      (server/git-summary.ts) — the new-session card's log. This server always sends it. Absent
      only in the wire's older shape: a client rebuilt against a server that hasn't been restarted
      yet reads `lastCommit` instead and shows the one commit it has. A transitional read, not a
      permanent contract. */
  commits?: GitCommit[];
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
  | { state: "none"; where: GitWhere; cwd: string; checkedAt: number }
  /** Nothing could be read: `reason` is a sentence for the user (folder gone, target offline,
      git missing, took too long, git's own refusal). Never cached. */
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
/** One file pi loads, with what it costs on disk and what it would cost to send. */
export interface SessionSetupFile {
  path: string;
  /** Bytes, as the file is on disk (never a decoded length). */
  bytes: number;
  /** Lines, counted the way `wc -l` counts them: newlines, plus one for a last line the file never
      terminated. An empty file has none. */
  lines: number;
  /** What this file's text costs a model, estimated the way pi estimates a prompt before sending
      it — CHARS_PER_TOKEN, pi-ai's estimateTextTokens, never a tokenizer. The character count is
      the decoded text's JS string length (UTF-16 code units), the same count pi makes. A real count
      is the model's, so the card says ≈. This server always sends it for a file it lists. Absent
      only in the wire's older shape (a client rebuilt against a server not yet restarted): the
      reader shows bytes and lines rather than a 0 it would be inventing. A transitional read, not
      a permanent contract. */
  tokens?: number;
  /** This session keeps this context file or skill out (§chat.transcript/setup-card-toggles): the
      row is still listed, and no total counts it. Never set on SYSTEM.md / APPEND_SYSTEM.md rows. */
  off?: true;
}

/** pi's own estimate of what text costs a model (pi-ai `estimateTextTokens`): the text's length in
    characters — JS string length, UTF-16 code units — divided by this, rounded up. Sova never tokenizes — a real count belongs to the model, and this
    is the rule pi budgets a prompt with. Shared so the server's estimate and the card's words
    about it are the same number. */
export const CHARS_PER_TOKEN = 4;

/** One skill pi offers this session. `path` is its SKILL.md. */
export interface SessionSetupSkill extends SessionSetupFile {
  name: string;
  description?: string;
}

export type SessionSetup =
  | {
      state: "ok";
      where: { kind: "local" };
      /** The folder that was read: the stored cwd. */
      cwd: string;
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
      /** The context and skill rows can be switched now (§chat.transcript/setup-card-toggles): this
          server holds the chat, it is local, ordinary, not TUI-live and before its first message.
          Worked out per session on every read, never cached with the folder's lists. */
      toggleable?: boolean;
      checkedAt: number;
    }
  /** A target session: its cwd is a local placeholder, so its loadout can't be read here. */
  | { state: "remote"; where: { kind: "remote"; target: string }; cwd: string; checkedAt: number }
  /** Nothing could be read: `reason` is a sentence for the user. Never cached. */
  | { state: "unavailable"; where: GitWhere; cwd: string; reason: string; checkedAt: number };

// POST /api/sessions/loadout {path, offContext, offSkills} -> SessionSetup
//                                  (§chat.transcript/setup-card-toggles: the session's whole off set
//                                  — context files by absolute path, skills by name — written as its
//                                  hidden `sova-loadout` entry; the runtime is rebuilt, open tabs get
//                                  `reloaded`, and the answer is the card's fresh read. 400 a bad
//                                  body, 404 a missing session, 409 refused: a message on the branch,
//                                  mid-turn, TUI-live, a foreign writer or a special session.)
export interface SessionLoadoutRequest {
  path: string;
  offContext: string[];
  offSkills: string[];
}

/** Longest group name, in characters, after trimming (SessionGroup.name; the server trims and
    refuses an empty or longer one with 400). The one place the limit is written down: the create
    input's maxlength and the server's rule read it from here. */
export const GROUP_NAME_MAX = 60;

/** Longest session title the user can set, in characters, after trimming (POST /api/sessions/title;
    the same cap the derived title is cut to, so a renamed row is never taller than its neighbours).
    The one place the limit is written down: the rename field's maxlength and the server's rule
    both read it from here. */
export const SESSION_TITLE_MAX = 80;

/** Who set a stored session title (SessionSummary.titleBy). */
export type SessionTitleBy = "user" | "overseer" | "auto";
/** What POST /api/sessions/title takes as its optional `source` (absent = "user"). Only Sova's own
    namer writes "auto", never through that route. */
export type SessionTitleSource = "user" | "overseer";

// POST /api/sessions/auto-title AutoTitleRequest -> AutoTitleResponse (§app.session-list/auto-titles).
// Names each path's session with the title model from Settings → Summaries → Session titles,
// never over an explicit title. 400 bad body (at most AUTO_TITLE_MAX_PATHS paths).
export const AUTO_TITLE_MAX_PATHS = 200;
export interface AutoTitleRequest {
  paths: string[];
  /** Say what would happen, call no model and write nothing. */
  dryRun?: boolean;
}
export type AutoTitleSkip =
  /** It has a title a user or the Overseer set (or one stored before provenance existed). */
  | "explicit"
  | "not-found"
  /** Not a listed main thread: an empty husk, a subagent's session, an Overseer file. */
  | "not-listed"
  /** No user message to name it from. */
  | "no-input"
  /** Neither title model can run (policy, registry, auth, CLI). */
  | "no-model"
  /** The models failed, or answered with no usable title. */
  | "failed";
export type AutoTitleOutcome =
  | { path: string; outcome: "named"; title: string }
  | { path: string; outcome: "would-name" }
  | { path: string; outcome: "skipped"; reason: AutoTitleSkip; detail?: string };
export interface AutoTitleResponse {
  /** One per requested path, in request order. */
  results: AutoTitleOutcome[];
}

// GET /api/settings/session-titles -> SessionTitleSettingsInfo (<state root>/session-titles-settings.json;
//                                    missing or broken fields read as their defaults)
// PUT /api/settings/session-titles SessionTitleSettings -> SessionTitleSettingsInfo (strict; 400 bad body)
/** Settings → Summaries → Session titles: the automatic namer's switch, timing and models. */
export interface SessionTitleSettings {
  version: 1;
  /** The background sweep (default off). The section heads' button works either way. */
  enabled: boolean;
  /** Minutes between sweep runs, 1–1440. */
  intervalMinutes: number;
  /** Minutes a session's file must have been untouched before the sweep names it, 0–1440. */
  quietMinutes: number;
  primary: WorkerChoice;
  fallback: WorkerChoice | null;
}
export interface SessionTitleSettingsInfo {
  settings: SessionTitleSettings;
  defaults: SessionTitleSettings;
  /** Every effort each backend accepts, for the rows (as DelegateSettingsInfo.backends). */
  backends: { id: DelegateBackendId; label: string; efforts: string[] }[];
  /** Why each configured model can't run right now, by slot; a slot that can run is absent. */
  unusable?: { primary?: string; fallback?: string };
  /** Absolute path of the file, for the footnote. */
  file: string;
}

/** Longest member label, in characters, after trimming (GroupMember.label; the server trims and
    refuses a longer one with 400, while an empty one clears the label). */
export const GROUP_LABEL_MAX = 40;

/** One session's presentation metadata inside a group (SessionGroup.members). Membership itself is
    the server's assignments map — this carries only the ORDER (array position) and an optional
    short LABEL, e.g. "control" or "the cheap one". */
export interface GroupMember {
  /** Session id (`SessionSummary.id`), not a path. */
  id: string;
  /** Shown beside the row; absent when unset. Trimmed, 1–GROUP_LABEL_MAX characters. */
  label?: string;
}

/** SessionGroup.seed: a note an older build wrote on a group it created by forking one session
    into several. This build never writes one and nothing reads it; the store keeps it through
    every write (§workspace.groups/legacy-groups). */
export interface GroupSeed {
  /** Canonical path of the source session — the same path each member's header carries as
      `parentSession`, and the same string that session's own `SessionSummary.path` has. */
  parentSessionPath: string;
  /** The entry every member was branched at. */
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
  /** An older build's note (GroupSeed). Kept, never written, never read by the UI. */
  seed?: GroupSeed;
  /** An older build's mark on a group it both created and named, which once deleted the group
      when its last member left. It decides nothing now: this build never sets it, never reads
      it past parsing, and keeps it through every write, a rename included. */
  autoDissolve?: boolean;
  /** The group's sessions in display order, with their labels. The server always sends it — it is
      reconciled against the assignments on every read (ids no longer in the group drop out, ids
      missing from it are appended in id order) — and it is optional in the type only because an
      older server, or a hand-written store file, may not carry it. */
  members?: GroupMember[];
}

/** 200 body of POST /api/session-groups/assign. An older server could add `dissolved: true`;
    this one never does, because an assign never deletes a group. */
export interface AssignGroupResult {
  ok: true;
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
  | "internal";

/** One member the batch could not take, named four ways: `id` joins against `GroupMember.id` and
    the assignments map, `path` is what a pane routes and opens with, `code` is for logic, and
    `message` is the server's human sentence (a fallback, not the UI copy). */
export interface BatchRefusal {
  id: string; // session id
  path: string; // canonical session path ("" when the file is gone)
  code: BatchRefusalCode;
  message: string;
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
  mode: string; // "normal" | "delegate"
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

/** The spec minor mode's writer (pi-config/extensions/mode/spec.ts, ~/.pi/agent/mode-spec.json): the
    worker that writes draft claims and evidence while spec is on, under either major mode.
    `writer: null` = none: the session writes the spec itself. `fallback: null` = none: an
    unavailable primary makes the session ask the user rather than pick a model. */
export interface SpecSettings {
  version: 1;
  writer: { primary: WorkerChoice; fallback: WorkerChoice | null } | null;
}

/** GET /api/settings/spec. `backends[].efforts` is every effort the backend accepts at all, as in
    DelegateSettingsInfo. */
export interface SpecSettingsInfo {
  settings: SpecSettings;
  writer: { label: string; description: string };
  backends: { id: DelegateBackendId; label: string; efforts: string[] }[];
  /** Absolute path of the file, for the screen's footnote. */
  file: string;
}

/** PUT /api/settings/spec: what is now stored, plus anything saved that could not be verified or
    that the policy refuses, one sentence each. */
export interface SpecSaveResult extends SpecSettingsInfo {
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

/** This chat's sandbox (pi-config/extensions/sandbox, §chat/sandbox), from the extension's newest
    `sandbox` entry on the branch. `status` is the extension's own line ("Sandbox on ·
    workspace-write · full enforcement"); `enforcement` is "none" while off. */
export interface SandboxInfo {
  on: boolean;
  enforcement: "full" | "partial" | "unavailable" | "none";
  status: string;
}

/** POST /api/sandbox?path=…: "command" = the extension's /sandbox handler ran (its answer in
    `sandbox`, also sent as a "sandbox" message); "unsupported" = no sandbox extension in this
    runtime, nothing happened; "skip" = a TUI or foreign writer owns the file, nothing written. */
export interface SandboxApplyResult {
  outcome: "command" | "unsupported" | "skip";
  sandbox?: SandboxInfo;
}

/** WS /ws/chat?path= — full-duplex chat for webapp-owned sessions. `&tail=1` asks for the transcript
    newest rows first (`hello.older`, then `history`); `&tail=rest` for the newest rows alone, the
    older ones fetched over REST when wanted (`hello.older` and `olderSummary`, no `history`; see
    TranscriptRows). Without either, every message is as it always was. */
export type ChatClientMessage =
  /** `clientId` is the SENDER'S OWN id for this send, chosen before the round trip. When the send
      is held in the outgoing queue it becomes that item's `QueueItem.id`, so the client can key
      its pending row by a value it already has instead of waiting to be told one. Omitted = the
      server allocates an id, and the row is only nameable from the next `queue` snapshot. */
  | { type: "prompt"; text: string; images?: OutboundImage[]; clientId?: string;
      /** The Overseer only: this message is a click on the `sova_card` card with this id (`c_N`,
          shared/overseer-card.ts; never a typed answer). The turn it opens may run the acts that
          card listed, while the card is open and the text is exactly what the click composes
          (§app.overseer/org-people-facing). A tool call id (a card from before card ids) approves
          nothing. Ignored anywhere else. */
      confirm?: string }
  | { type: "steer"; text: string; images?: OutboundImage[]; clientId?: string }
  | { type: "abort" }
  | { type: "set_model"; ref: string }   // calls session.setModel; server replies {type:"model"} or error
  | { type: "set_thinking"; level: string } // calls session.setThinkingLevel (clamped to the model); server replies {type:"thinking"}
  // Move the chat to a Claude login (§app.claude-logins/switch-login): a login id, or null to cancel
  // a pick waiting for the reply to end. The server answers with {type:"claude_login"} (its
  // `pending` while a pick waits) or an error whose message starts with LOGIN_UNCHANGED.
  | { type: "set_claude_login"; login: string | null }
  | { type: "ui_response"; id: string; value: unknown }
  /** Rewind to just before a user input on the active branch (the TUI's /tree on a user message):
      the tip moves to that message's parent and its text comes back for the composer. `id` is the
      client's request id, echoed in the `rewound`/`rewind_refused` reply; `entryId` is the user
      row's TranscriptItem.id. Refused while a turn streams or compacts (never auto-aborts). */
  | { type: "rewind"; id: string; entryId: string }
  /** Redo the turn an ASSISTANT entry belongs to: the server walks the active branch back from
      `entryId` to the nearest `role:"user"` message, rewinds to just before it (so the invisible
      rewind marker is written and the move survives a reload), and re-prompts that
      entry's STORED text and STORED images, unchanged, with the session's CURRENT model and
      thinking level — which is what makes switch-model-then-regenerate a comparison.
      `id` is the client's request id, echoed in `regenerated`/`regenerate_refused`; `entryId` is
      an assistant row's `TranscriptItem.id` (a block id `<entryId>:<n>` is accepted and resolved
      to its entry). A user entry is refused `not_on_branch` — Rewind is that gesture. Refused
      while a turn streams or compacts, and NEVER auto-aborts. The confirmation step is the
      client's; the server does not ask. */
  | { type: "regenerate"; id: string; entryId: string }
  /** Compact this chat's context now: pi's own `AgentSession.compact(instructions)`, the TUI's
      /compact. `id` is the client's request id, echoed in `compacted`/`compact_refused`;
      `instructions` (optional) steer what the summary keeps. Refused while a turn streams, while a
      compaction runs and while a message is still on its way out — NEVER auto-aborts a turn
      (pi's compact() would). A `prompt`/`steer` whose whole text is `/compact [instructions]`
      and carries no image takes this same path, answered by the send's `clientId`. */
  | { type: "compact"; id: string; instructions?: string }
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

/** Why a regenerate was refused. Every RewindRefusal, plus the conditions only a regenerate has.
    A SEPARATE union rather than a member added to RewindRefusal: widening that one would silently
    widen every exhaustive switch the existing rewind client already has.
    "wake" = the message that started the turn is a WAKE NUDGE — machine-generated text the
    scheduler wrote, not something the user said. Replaying it would put Sova's own nudge back on
    the branch as if the user had typed it, complete with its "[wake_nudge …] Scheduled wakeup
    fired" preamble and a stale elapsed time. There is no honest thing to re-send, so nothing is.
    "link" = the message that started the turn is a LINK MESSAGE (§mesh.links/transcript): a
    partner's words delivered by its host, not the user's; the same reasoning refuses it.
    "topic" = the message that started the turn is a TOPIC BATCH (§chat.topics/row): notes other
    sessions pushed, delivered by the server; the same reasoning refuses it. */
export type RegenerateRefusal = RewindRefusal | "wake" | "link" | "topic";

/** Why a compaction was refused or did not happen; nothing was written in any of these.
    streaming / compacting / queued / busy / recent are RewindRefusal's conditions, for the same
    reasons (a compaction while a message is still on its way out would summarize a branch that
    message then lands after). "already" = the branch ends in a compaction; "nothing" = too little
    to summarize (pi's own two refusals); "cancelled" = Stop, or an extension's
    session_before_compact cancelled it; "internal" = anything else, the summarizer's failure and a
    model turned off in Settings → Models included, with the reason in `message`.
    A SEPARATE union, like RegenerateRefusal: widening RewindRefusal would widen every exhaustive
    switch the rewind client has. */
export type CompactRefusal = "streaming" | "compacting" | "queued" | "busy" | "recent" | "already" | "nothing" | "cancelled" | "internal";

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
  /** The Overseer sent it (`sova_send` into a running session); the row reads "Overseer". */
  overseer?: true;
  /** Another session sent it (`session_send`, §chat.profiles/delivery); the row reads "From {title}". */
  fromSession?: { sessionId: string; title: string };
}

/** `SessionSummary.profile`. */
export interface SessionProfileField {
  id: string;
  label: string;
  icon: string;
  singleton?: true;
  /** Where it came from (§chat.profiles/projects); absent for a custom pick. */
  source?: import("./profiles").ProfileSource;
  /** A project profile's project root and name. */
  project?: string;
  projectName?: string;
  custom?: true;
  /** Picked by the Overseer or a start sheet, not on the empty screen. */
  by?: "overseer" | "start";
}

/** The chat socket's `profile` message (§chat.profiles/applying): sent after `hello` and on every open. */
export interface ChatProfileInfo {
  /** The branch's whole snapshot; null = Default. */
  profile: import("./profiles").ProfileEntryData["profile"];
  by?: "overseer" | "start";
  /** A user message is on the branch: fixed. */
  locked: boolean;
  /** The picker applies to this session at all (not special, not TUI-live). */
  pickable: boolean;
  /** The runtime's active tool names now. */
  tools: string[];
  /** Tools the removals took from this runtime. */
  removed: string[];
  /** The session tools the grants added. */
  granted: string[];
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
  /** "builtin" = Sova runs it itself on this runtime (today only `compact`), never an extension's. */
  source: "extension" | "prompt" | "skill" | "builtin";
  /** Where it comes from: extension path, or template/skill location (project, user, …) + path. */
  location?: string;
  path?: string;
}

export type ChatServerMessage =
  /** First message after connect: current transcript + live state + context fill.
      thinking = the session's active thinking level (one of off…max), clamped to its model. */
  /** `isCompacting` = a compaction (manual or pi's automatic one) is running as this is sent, so a
      client that connects mid-compaction shows it; absent from servers that predate it. */
  /** `older` (only to a client that asked with `?tail=1` or `?tail=rest`): `items` is the branch's
      newest whole entries, and this many rows come before them. With `?tail=1` they follow as
      `history` messages right after the messages that follow every hello (below), before anything
      else; with `?tail=rest` nothing follows, and `olderSummary` sums them up (`prefetch`: fetch
      them all now; see OlderSummary and TranscriptRows). Absent or 0: `items` is the whole branch,
      as for every client that didn't ask. */
  | { type: "hello"; items: TranscriptItem[]; isStreaming: boolean; isCompacting?: boolean; model: string | null; thinking: string; context: ContextInfo | null; older?: number; olderSummary?: OlderSummary; prefetch?: boolean }
  /** The older rows of a `hello` with `older` (see HistoryMessage). After attach they come after
      `links`; after a rewind, regenerate or compaction, after the requester's `rewound`,
      `regenerated` or `compacted` (and a compaction's `queue`). */
  | HistoryMessage
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
  /** THIS chat's sandbox, sent after hello and on every change, ONLY when its runtime has the
      sandbox extension's /sandbox command. Absent = no extension: no row, no shield. */
  | ({ type: "sandbox" } & SandboxInfo)
  | ({ type: "profile" } & ChatProfileInfo)
  /** THIS chat's Claude login (§app.claude-logins/active-login): the newest `claude-login` entry on
      its branch, else the login this host would start it on now. Sent after hello only when this
      host has more than one login (a hello clears the last one), and whenever a `claude-login`
      entry is appended. `null`: this host has no Claude login it could name. */
  | { type: "claude_login"; login: ChatClaudeLogin | null }
  /** Slash commands available in this session (sent right after hello, and again after a runtime
      reload). Same enumeration as pi rpc get_commands: extension commands, prompt templates, skills,
      after Sova's own builtin `compact` (first; an extension command of the same name is left out,
      since Sova intercepts that text before pi sees it). Other TUI built-ins (/tree, /model, …) are
      not included. Send one as a normal prompt "/name args". */
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "ui_request"; id: string; request: unknown }
  /** The dialog `id` was answered elsewhere (another tab, or the Overseer): drop it, no response. */
  | { type: "ui_resolved"; id: string }
  /** This chat's subagent workers, from the runtime's own live record (presence.workers/workerCounts).
      Sent after hello when the record has workers, then whenever the snapshot changes (polled ~3s),
      so it keeps coming after the parent turn settles. working 0 = none running. */
  /** `usageTotal` is the session-lifetime token Σ across every worker this runtime ever spawned
      (live ones plus the ones its retention cap dropped), so it is NOT the sum of `workers[].usage`.
      Absent when the live record predates it. */
  | { type: "workers"; working: number; total: number; workers: WorkerInfo[]; usageTotal?: TokenUsageTotal }
  /** This session's linked members on other hosts (§mesh.links/agents-pane; for the Overseer, every
      member of every link this host knows). Sent after hello when there are any, and again whenever
      a link message lands or a link is made or ended. Links not ended only; [] = none left. */
  | { type: "links"; links: LinkedAgentInfo[] }
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
  /** A compaction landed. Every client of the chat first got a fresh `hello` (whose items end in
      the compaction row, and whose context is null until the next reply), then `workers` and
      `mode`, exactly as after a rewind; only the requester then gets this. `entryId` is the new
      `compaction` entry, `tokensBefore` pi's count of the context it summarized. Progress in
      between is pi's own `compaction_start`/`compaction_end` events, relayed as `event`. */
  | { type: "compacted"; id: string; entryId: string; tokensBefore: number }
  /** The compaction was refused or failed, and nothing was written; to the requester only.
      `message` is user-facing copy. */
  | { type: "compact_refused"; id: string; reason: CompactRefusal; message: string }
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
  | {
      type: "error";
      message: string;
      code?: "busy" | "recent" | "reloaded" | "config" | "refused" | "internal";
      clientId?: string;
      /** A One at a time profile's first message was refused: the session that holds it (§chat.profiles/singleton). */
      profileRunning?: { id: string; path: string; title: string };
      /** The provider of the model whose turn failed, when the error IS the turn's failure (never a worker's or a guessed one); absent otherwise. */
      provider?: string;
    };

/** WS /ws/watch?path= — read-only live view. Safe for sessions a TUI currently owns. Never writes.
    `&tail=1` cuts the snapshot as `/ws/chat` cuts its hello (`older`, then `history`); `&tail=rest`
    likewise with no `history` (`older`, `olderSummary`, `prefetch`; see TranscriptRows).
    Also accepts `?claude=<uuid>` instead of `?path=`: a claude-code worker's own Claude Code
    session (WorkerInfo.sessionId), found under ~/.claude/projects and normalized into the same
    rows. Same `snapshot`/`append`/`error` messages; an unknown id closes with 4404 like a bad path.

    Both `snapshot` and `append` may carry `usage`: the tokens the whole transcript has used so
    far (always cumulative, never a delta), so an open header can tick while the file grows. It is
    absent while the transcript reports no usage at all, and carries no cost for a Claude session. */
/** The open transcript's context fill as of its last reply, on every snapshot/append: a fill,
    "compacted" (a compaction came after that reply), or null (no reply reports one yet). `window`
    is known for pi files (the reply's own model); a Claude Code file doesn't name its variant, so
    it is null there and the client takes WorkerInfo.contextWindow. Absent from older servers. */
export type WatchContext = ContextInfo | "compacted" | null;
/** Rows that come before a tail-first `hello` or `snapshot` (`older` > 0), newest chunk first,
    each chunk about 256 KB of JSON: prepend each to the list. `left` = rows still to come after
    this one; 0 = the list is whole. Sent only to a client that asked with `?tail=1`, in one step
    with its hello or snapshot, so nothing else comes between the chunks. */
/**
 * What the complete-list readers (the inputs count, Undo last turn)
 * need of the rows before a list's first row, which the client doesn't hold: sent with a
 * `?tail=rest` hello or snapshot, and with every TranscriptRows response, always about the rows
 * before that message's first row. Counted by the client's own rules (shared/row-counts.ts), so the
 * client's count of the rows it holds plus these is the whole branch's.
 */
export interface OlderSummary {
  /** Row ids of the user's inputs (user rows and wake nudges), oldest first. */
  inputs: string[];
  /** Messages (distinct entries of user, wake, link and reply rows). */
  messages: number;
  /** Whether any is a reply's row (assistant text or a tool call). */
  replies: boolean;
  /** The alignments open among them (§chat.alignment/chip): each document's newest revision there
      and its row, only those not done or dropped, the last touched last. Absent when none (and
      from older servers). A newer revision in the rows after them takes its place. */
  aligns?: { doc: AlignDocInfo; rowId: string }[];
  /** The Overseer's cards open among them (§app.overseer/confirm, the composer chip): each card's
      newest snapshot there and the row that shows it (its sova_card call's row), only those still
      open, the last touched last. Absent when none (and from older servers). A newer snapshot in
      the rows after them takes its place, as for aligns. */
  cards?: { card: OverseerCard; rowId: string }[];
}

/**
 * GET /api/transcript?path=&… — the rows of a session's active branch, read from its file (never a
 * runtime, never a write), normalized exactly as the `hello` and the snapshot are, so rows from here
 * and rows from the socket put together are the same list. Without the parameters below, the whole
 * branch as `{ items, context }`, as it always was. With them, a TranscriptRows:
 * - `tail=1`: the newest rows, cut as a `?tail=1` hello is (and `context`, as without it);
 * - `before=<row id>`: about 256 KB of whole entries just before that row (`chars=` another size);
 * - `before=<row id>&from=<entry or row id>` (or `&explain=<explanation id>`): every row from that
 *   entry's row (or the explanation's report row) up to that row, for a jump; the range starts
 *   earlier when that row is a tool result (its call comes with it) or inside a baton wrap-up;
 * - `from=…` alone: from that row to the end (a view refreshing the rows it holds).
 * `view=light` instead: the whole branch as `{ items, context }`, each row without what only the
 * thread draws (a reply's text, a tool's output, image bytes, a report's body, the raw entry's
 * content), for the session pane: every row stays, in order, with its kind, time and counts.
 * `leaf=<entry id>` is the last entry the client's list renders: an id the file holds that is no
 * longer on the active branch (a rewind) answers 409 `{ code: "moved" }`, as does a `before` row
 * that isn't in the list; the client then starts again from a fresh tail. A `from`/`explain`
 * target not on the branch answers 404 `{ code: "missing" }`.
 */
export interface TranscriptRows {
  items: TranscriptItem[];
  /** Rows before `items[0]` on the branch (0: `items` reaches the top). */
  older: number;
  /** About those rows (OlderSummary). */
  olderSummary: OlderSummary;
  /** `tail=1` and `from` alone (the answers that reach the end): the context fill, as the
      whole-branch response carries it. */
  context?: ContextInfo | null;
}

export interface HistoryMessage {
  type: "history";
  items: TranscriptItem[];
  left: number;
}
/** `snapshot.older`: as `hello.older` — only with `?tail=1`; the rows follow as `history`, before
    any `append`. A snapshot sent again (the file was rewritten) is cut the same way. */
export type WatchServerMessage =
  | { type: "snapshot"; items: TranscriptItem[]; usage?: TokenUsage; context?: WatchContext; older?: number; olderSummary?: OlderSummary; prefetch?: boolean }
  | HistoryMessage
  | { type: "append"; items: TranscriptItem[]; usage?: TokenUsage; context?: WatchContext } // new JSONL rows since snapshot, as they appear
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
// POST /api/workers/resume?path=<session>&id=<ag_NN> -> WorkerResumeResult  (resumes one `restored`
//                                  worker of a session THIS server hosts, idle: nothing is sent to it.
//                                  400 bad path/id, 404 session not hosted here, 409 not resumable
//                                  (with the reason), 500 the backend failed to start it.)

// GET /api/insights/worktrees?paths=<session path>,<session path>… -> WorktreesInsight
//                                  (only the listed sessions: the board asks for its visible rows.
//                                  Unknown paths come back with trees: []. 400 when paths is missing.)

/** One git worktree a session touches, compared with its repository's base branch. */
export interface WorktreeStatus {
  /** Absolute path of the worktree's top level. */
  path: string;
  /** Where the tree came from: the session's own cwd, or a worker's cwd (stopgap source). */
  source: "session" | "worker";
  /** The directory still exists and is a git worktree. When false every other field is absent. */
  exists: boolean;
  /** Checked-out branch short name; absent on a detached HEAD. */
  branch?: string;
  /** The base the counts are against (`master`, else `main`, else origin/HEAD). Absent: no base found. */
  base?: string;
  /** "ancestor": the tip is in the base. "content": not an ancestor, but merging would change
      nothing (squash or rebase merge). "no": unmerged. Absent when there is no base. */
  merged?: "ancestor" | "content" | "no";
  /** Commits on the branch not in the base, and in the base not on the branch. */
  ahead?: number;
  behind?: number;
  /** Lines added/removed by the branch since its merge-base with the base (`base...HEAD`). */
  added?: number;
  removed?: number;
  /** Uncommitted changes (tracked or untracked) in the worktree. */
  dirty?: boolean;
  /** How many paths `git status --porcelain` lists, and the first few (repo-relative). */
  dirtyCount?: number;
  dirtyFiles?: string[];
  /** merged "no" only: files the trial merge into the base conflicts on. */
  conflicts?: number;
  /** Why a reading is missing, when git failed. */
  error?: string;
}
export interface SessionWorktrees { sessionPath: string; trees: WorktreeStatus[] }
export interface WorktreesInsight { sessions: SessionWorktrees[]; generatedAt: number }

/** GET /api/worktrees/summary?path=<session> (§chat.worktrees/cleanup): every linked worktree in
    git's list for the repository the session's folder is in. "none": a remote session, a folder
    that isn't in a repository with a main checkout, or one that is gone. */
export type WorktreesSummary =
  | { state: "none" }
  | {
      state: "ok";
      /** The main checkout's folder. */
      repo: string;
      /** master, else main; absent when the repository has neither (every tree then unmerged). */
      mainBranch?: string;
      total: number;
      merged: number;
      /** Empty leftovers: a branch with no commit of its own. */
      empty: number;
      unmerged: number;
    };
/** POST /api/worktrees/cleanup's body: `dryRun` previews; `expect` removes exactly those paths
    that are still removable (never both). */
export interface WorktreeCleanupRequest {
  path: string;
  dryRun?: boolean;
  expect?: string[];
}
/** A worktree that goes (dry run) or went: how it is merged, and whether its branch is deleted. */
export interface WorktreeCleanupRemoved {
  path: string;
  branch?: string;
  kind: "ancestor" | "content" | "empty";
  branchDeleted: boolean;
}
/** A worktree that stays, and the one reason why. */
export interface WorktreeCleanupKept {
  path: string;
  branch?: string;
  reason: string;
}
/** The dry run's answer. */
export interface WorktreeCleanupPlan {
  repo: string;
  mainBranch?: string;
  /** The server's home folder, so the dialog shows paths with `~`. */
  home?: string;
  remove: WorktreeCleanupRemoved[];
  keep: WorktreeCleanupKept[];
}
/** A removal's answer, per expected path (other trees are never touched). */
export interface WorktreeCleanupResult {
  removed: WorktreeCleanupRemoved[];
  kept: WorktreeCleanupKept[];
}

/** POST /api/workers/resume's answer: the worker as the runtime now lists it. */
export interface WorkerResumeResult { worker: WorkerInfo | null }

export interface UsageWindow { label: string; pct: number; resetsAt?: string; /** Raw counts when the provider exposes them (e.g. z.ai MCP calls: used/limit). */
  used?: number; limit?: number; /** Model-family scope when the window only covers a subset (e.g. Claude's "7d scoped" Fable window). */
  scope?: string; /** Provider-flagged binding constraint (currently active limit). */
  active?: boolean; /** When the window began, when its own data says (OpenAI: resetsAt minus its length; Ollama: the
      user's reset day). Absent: its length is its label's, if the label states one (§app.insights/pace-tick). */
  startsAt?: string; /** The reset is the user's declared day (usage-windows.json), not the provider's answer. */
  declared?: true }
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
  /** OpenAI's plan name as the source sends it (e.g. "plus"). Absent when not reported. */
  plan?: string;
  /** OpenAI says the account hit its usage limit (`limit_reached`, or `allowed: false`). */
  limitReached?: boolean;
  /** Z.ai's coding-plan level as the source sends it (e.g. "pro"). Absent when not reported. */
  level?: string;
  /** Claude's pay-as-you-go spend past the plan. `pct`: share of the extra-usage spend cap used,
      absent when the source reports the switch without a reading. */
  extraUsage?: { enabled: boolean; pct?: number };
  /** The cache no longer carries this provider (an older pi rewrote it), so this is the reading
      the server last stored for it (at most 24h old); `error` says why. */
  lastKnown?: boolean;
  /** What the provider's sign-in says (server/auth-status.ts). Absent when its credentials say nothing. */
  auth?: UsageAuth;
}
/** A provider's sign-in, read from its credential files. Numbers, enums and booleans only: no
    string from a credential file is ever sent. Times are ms epochs; the booleans use the server's clock. */
export interface UsageAuth {
  kind: "oauth" | "apiKey";
  /** Whose credentials: Claude Code's, pi's own auth.json, or the Codex CLI's. Absent for API keys. */
  source?: "claude-cli" | "pi" | "codex-cli";
  /** The access token's expiry. */
  expiresAt?: number;
  /** The refresh token's expiry (Claude only today). */
  refreshExpiresAt?: number;
  /** When the sign-in was last renewed, when that is known for sure. */
  refreshedAt?: number;
  /** `expiresAt` has passed. */
  expired?: boolean;
  /** `refreshExpiresAt` has passed: only a new sign-in helps. */
  refreshExpired?: boolean;
}
export interface UsageInsight {
  available: boolean;
  reason?: "missing" | "corrupt";
  fetchedAt: number | null;
  nextFetchAt: number | null;
  stale: boolean; // now - fetchedAt > 10 min (nothing refreshed the cache: neither this server's poller nor a TUI)
  providers: UsageProvider[]; // fixed order: claude, openai, ollama, zai, deepseek
  /** Every Claude login on this host, in its order, `default` (whose usage is `providers`' claude)
      included; with the pool on, the pool's logins first, in its order, each with its `holder`
      (§app.insights/usage-cards). Absent from an older server; the page then shows the
      one Claude card from `providers`. */
  claudeLogins?: UsageClaudeLogin[];
  /** Ollama Cloud's declared reset day (usage-windows.json, §app.insights/usage-reset-day): 1..31,
      or null while none is set. Absent from an older server. */
  ollamaResetDay?: number | null;
}
/** `PUT /api/insights/usage/reset-day`: set (1..31) or clear (null) a provider's declared reset
    day; answers with the whole UsageInsight. */
export interface UsageResetDayRequest { provider: "ollama"; day: number | null }
/** One Claude login's card on the Usage page. Identity and standing only: never a token. */
export interface UsageClaudeLogin {
  /** `default` (Claude Code's own directory) or `l-` and 8 hex digits. */
  id: string;
  label?: string;
  email?: string;
  /** Logins with the same account share its usage limits; the page groups them. */
  accountUuid?: string;
  orgName?: string;
  /** "Max 20x", "Pro", … (ClaudeLoginIdentity.planLabel). */
  planLabel?: string;
  /** When it was added (absent for `default`): names a login that has no label. */
  addedAt?: number;
  /** false: never chosen automatically (Settings → Accounts, Use). */
  enabled: boolean;
  /** Its directory holds `.credentials.json`. */
  signedIn: boolean;
  standing: ClaudeLoginStanding;
  /** The login this host's next new chat runs on: the first usable one in its order. */
  inUse: boolean;
  /** Its reading: `id` "claude", like the provider card. A login marked as needing sign-in is not
      fetched, so it keeps the last reading it had (or none: state "error"). */
  usage: UsageProvider;
  /** When `usage` was fetched (added logins; `default`'s is the file's `fetchedAt`; a pool login
      held elsewhere: when its holder published it). */
  fetchedAt?: number;
  /** While the pool is on, where the login is (not for `default`). A login held by another device
      (or kept free) reads its holder's published figures (5-hour and 7-day), or none. */
  holder?: { label: string; self: boolean; free: boolean; stuck: boolean };
}

/** `restored`: a worker a server restart took down, rebuilt from its durable record and transcript.
    No process runs for it; it is idle until the user resumes it (never automatically). */
export type WorkerStatus = "starting" | "running" | "waiting" | "stopping" | "done" | "error" | "killed" | "restored";
/** Cumulative token counts. Non-negative integers; `cost` is USD and only present when the
    backend reports one. */
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }
/** A token Σ plus the number of workers it covers — a session-lifetime count that can exceed the
    workers currently listed, because evicted ones keep counting. */
export interface TokenUsageTotal extends TokenUsage {
  workers: number;
  /** ms: some of it is a restored worker's last snapshot (Claude cost), true as of then. */
  asOf?: number;
  /** How many of `workers` were restored after a server restart (their spend rebuilt from their
      records). Absent or 0 when none were. */
  restored?: number;
}
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
  /** The mode extension's minor modes this worker was given at its start (today only `spec`
      reaches workers; §chat.mode-menu/workers), a resumed worker's being the ones its resume gave.
      Absent when it was given none, and from records of an older pi-config — show nothing then. */
  modes?: string[];
  /** ms: its first spawn — kept across resumes and restarts (a restored worker: its transcript's
      start, else its first durable record's time). */
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
  /** Model replies this worker has had so far, across resumes (the TUI's '{n} turns'): the live
      record's `workers[].turns`, or for a restored worker its transcript's or last snapshot's
      count. Absent when unknown (an older writer, a record that never counted) — never 0 for
      unknown. */
  turns?: number;
  /** Where `usage` comes from. `transcript`: recomputed from its own transcript (exact tokens;
      cost only when the backend records one). `snapshot`: the last number the worker reported
      before the restart, true as of `usageAsOf`. `unavailable`: its transcript couldn't be read
      and nothing was reported, so `usage` is absent — never read that as 0. Absent on a running
      worker's live number and from older writers. */
  usageSource?: "transcript" | "snapshot" | "unavailable";
  /** ms: part of `usage` is the worker's last report before the restart and was true then — all
      of it for `snapshot`, only the cost for a `transcript` Claude worker (its transcript records
      tokens, never cost). */
  usageAsOf?: number;
  /** ms: a restored worker died mid-turn at about this time; the turn's answer never arrived. */
  interruptedAt?: number;
  /** A restored worker can be resumed from here: the session is hosted by this server and the
      backend resumes natively. Absent otherwise (a TUI session, a backend without resume). */
  resumable?: boolean;
  /** This worker's context fill as of its last reply — the session head's rule (input + cacheRead
      + cacheWrite of that one reply) — or "compacted" when a compaction came after it. Live
      workers: read off the tail of their own transcript, so it lags a turn in flight; restored
      ones: from the transcript summary. Absent when unknown: no reply reports one yet, or the
      transcript isn't a local file this server can read. Never 0 for unknown. */
  context?: ContextInfo | "compacted";
  /** The worker's context window, from the model it was spawned with (claude-code: 1M for a
      `[1m]` variant or a natively 1M model, else 200k; pi: the model's catalog window). Absent
      when unknown. */
  contextWindow?: number;
}
export interface TeamMember {
  workerId: string; role: string; orchestrator: boolean; backend: string; model?: string;
  ownedPaths: string[]; addedAt: number;
  /** When the member released its team seat (team_eject, or the extension on its own). It keeps
      its role, id and transcript. Absent from older servers and never-ejected members. */
  ejectedAt?: number;
  worker: WorkerInfo | null; // null: not in the live record (history team / trimmed worker)
  lastReport?: { status: string; outcome?: string; at: string };
  /** The member's standing duty in a coordinated team (subagents-team-v1 `duty`). */
  duty?: TeamDuty;
  /** The worker id this member took over from: the record's `successorOf`, else (older files) the
      handover event that named this member as the successor. */
  successorOf?: string;
  /** The newest `retire` event for this member. `reason`: the successor confirmed, or the handover
      timed out; absent when the event's detail says neither. */
  retired?: { at: string; reason?: "confirmed" | "timeout" };
}
export type TeamDuty = "coordinator" | "monitor";
export type TeamEventKind = "handover" | "retire" | "pause" | "resume" | "wrap-up";
/** One subagents-team-event-v1 entry on the parent's active branch. `workerId`/`role`: the member
    the event is about (handover/retire: the old member; pause/resume: the monitor; wrap-up: the
    member told to wrap up). `text`: the one-sentence form the UI shows (server/reports.ts
    teamEventText), without the team; `detail` verbatim (≤ 500 chars) for a title. */
export interface TeamEvent {
  id: string;
  teamId: string;
  kind: TeamEventKind;
  workerId: string;
  role: string;
  at: string; // ISO 8601
  detail?: string;
  text: string;
}
export interface TeamInfo {
  id: string; name: string; objective: string; createdAt: number;
  parentPath: string; // session key → #/s/<path>
  live: boolean; // parent session currently running
  members: TeamMember[];
  working: number;
  /** A member has the coordinator duty. */
  coordinated?: true;
  /** Oldest first; absent when the team has none. */
  events?: TeamEvent[];
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
  /** When the topic's own section of the conversation ends (ms): the last message of the range its
      latest update claimed. Topics updated in one summarizer run share `at` but not this. The strip
      and the Overseer show and sort by it (`topicTime`, shared/outline-order.ts), falling back to
      `at` when absent: snapshots from before ranges, and topics the live overlay invented. */
  sectionAt?: number;
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
/** One rewind on the active branch: the invisible `sova-rewind` entry Sova appends after
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
export interface ModelSpend extends TokenUsage {
  model: string; origin: SpendOrigin;
  /** ms: part of this row is a restored worker's last reported snapshot, true as of then. */
  asOf?: number;
}
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
  /** Ids of listed workers whose usage couldn't be read (no transcript, nothing reported): they
      are in no row and in no Σ, so every total above is a lower bound while this is non-empty. */
  unavailable?: string[];
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
  /** How many workers the live record counts (its `workerCounts.total`), which can exceed
      `workers`: the record lists at most 40. The pane offers the rest through
      `GET /api/insights/session/workers` (SessionHiddenWorkers). Absent when the session isn't
      live, when `workers` is already every worker, or from an older server. */
  workerTotal?: number;
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
  /** The session's tracked git worktrees (pi-config worktrees extension: the newest `worktrees`
      entry on the active branch), in recorded order, dropped and merged ones included.
      Absent when the branch never tracked one, or from an older server. §chat.worktrees/pane */
  worktrees?: SessionWorktreeInfo[];
  /** The Agents tab's "Remotely linked agents" rows (§mesh.links/agents-pane), as the `links` chat
      frame carries them. Absent when the session is in no live link, or from an older server. */
  links?: LinkedAgentInfo[];
}

/** `GET /api/insights/session/workers?path=`: the workers recorded on the session's active branch
    that its live record doesn't list, newest first, read from the session file only when asked
    (§app.subagents-pane/hidden-workers). Each is built from its durable records alone: its usage
    is the snapshot saved there (`usageSource: "snapshot"`, or "unavailable"), never its
    transcript's. Nothing is hidden when the session has no live record: the insight then lists
    every worker already. */
export interface SessionHiddenWorkers {
  workers: WorkerInfo[];
  /** Rows the live record lists. */
  listed: number;
  /** listed + workers.length. */
  total: number;
}

/** One tracked worktree as the Session tab shows it. */
export interface SessionWorktreeInfo {
  /** Canonical top level. */
  path: string;
  branch: string;
  status: "active" | "dropped" | "merged";
  /** status "merged": the merge this session recorded. */
  merge?: { target: string; sha: string; how: "tool" | "detected"; at: number };
  /** status "active" only: the server found its branch already merged into `target` (a merge this
      session did not record: another session's, or one outside its turns). Checked with git,
      cached briefly; absent when not merged or not checkable. */
  mergedInto?: { target: string; sha: string };
  how: "created" | "attached";
  /** The session it was inherited from (a fork copied the entry); absent when it is this
      session's own. */
  sharedWith?: string;
  /** The directory still exists. */
  exists: boolean;
  /** It holds a `.agent` directory (workers may run on it with useWorktreeConfig). */
  hasAgentDir: boolean;
  /** This session's workers with a live process (starting, running, waiting, stopping) whose cwd is
      inside it. */
  runningWorkers: number;
  /** Its merge readiness (§chat.worktrees/readiness), once the background read has one. */
  readiness?: WorktreeReadiness;
  /** Tracked active with its folder gone: what its work came to, the same answer readiness gives
      (§chat.worktrees/pane). "unknown": its branch is gone too and nothing records a merge. */
  gone?: "merged" | "unmerged" | "empty" | "unknown";
}

// ---------------------------------------------------------------------------
// OVERSEER — the one special Sova session that watches and acts on every other
// session (.overseer-design/DECISIONS.md). Sova-owned state under <stateRoot>:
//   overseer/ (its cwd) · overseer.json (OverseerSettings) · overseer-state.json
//   (OverseerState) · overseer-notes.md · overseer-actions.jsonl (OverseerAction lines)
//   · seen.json ({[sessionId]: ms})
//   · ideas/manifest.json (IdeasManifest) + ideas/<ns>/<name>.md and ideas/<ns>/<parent>/<name>.md
//     (each idea's prose; see IDEA_ID_RE). The Overseer (sova_idea) and PATCH are the only writers.
//   · todos.json (TodosFile; the Overseer's sova_todo and the todo routes write it)
// Routes:
// GET  /api/overseer                -> OverseerInfo   (ensures the current file exists)
// POST /api/overseer/clear          -> OverseerInfo   (stops a running turn, disposes, rotates; never refuses)
// GET  /api/overseer/attention      -> AttentionDigest (no LLM; memoised ~3 s)
// GET  /api/settings/overseer       -> OverseerSettingsInfo
// PUT  /api/settings/overseer       body OverseerSettings -> OverseerSaveResult (400 invalid;
//                                   model/thinking apply at once when the Overseer is idle, else at turn end)
// GET  /api/overseer/notes          -> { text: string }
// GET  /api/overseer/ideas          -> OverseerIdeasInfo (ToC + every record + link edges; no prose)
// GET  /api/overseer/idea?id=<§id>  -> OverseerIdeaDetail, 404 {error} unknown id, 400 bad id; a
//                                   renamed idea's former id answers with the idea under its new id
// PATCH /api/overseer/idea?id=<§id> body IdeaPatch -> OverseerIdeaDetail; 409 IdeaConflict when
//                                   `base` is not the record's current updatedAt; 400 invalid (bad
//                                   status/link/tag, a link to itself or to an unknown idea; a
//                                   `newId` that is malformed, live, another idea's former id, or a
//                                   main entry with sub-entries made a sub-entry)
// GET  /api/overseer/todos          -> OverseerTodosInfo (todos.json: the user's checklist, list order)
// POST /api/overseer/todos          body { text, ideaId?, sessionId? } -> 201 OverseerTodosInfo; 400 invalid
// PATCH /api/overseer/todo?id=<td_> body TodoPatch -> OverseerTodosInfo; 404 unknown; 409 TodoConflict
//                                   when `base` is sent and stale; 400 invalid
// DELETE /api/overseer/todo?id=<td_> -> OverseerTodosInfo; 404 unknown
// PUT  /api/overseer/todos/order    body { ids } -> OverseerTodosInfo; 400 unless a permutation of the ids
// DELETE /api/overseer/todos/done   -> OverseerTodosInfo (every done todo deleted)
// PUT  /api/overseer/notes          body { text: string } -> { text: string }
// GET  /api/sessions/summary?id=<session id> -> SessionSummary (any session file with that id,
//                                   listed or not, e.g. an empty web session), 404 {error} when none
// GET  /api/sessions/by-id/:id      -> the same answer from the same handler, at a path-shaped URL,
//                                   `Cache-Control: no-store` (§mesh.links/by-id; peer-reachable)
// POST /api/sessions/configure      body SessionConfigure -> SessionConfigureResult (model, thinking,
//                                   mode, minor modes of that session only, never a saved default;
//                                   peer-reachable; §mesh.links/configure; types in shared/mesh-links.ts)
// Linked sessions (§mesh/links): the local acts /api/mesh/links/* (never peer-reachable or
// proxied), the page reads /api/links/:id/thread and /seen, and the peer routes
// /api/peer/links/*; every route and body is in shared/mesh-links.ts, outside this file's hash.
// POST /api/sessions/prompt         body { path, text, delivery?: "followUp" | "steer" }
//                                   -> { ok: true, queued: boolean, kind: "prompt" | "followUp" | "steer",
//                                   compacting?: true }
//                                   (hosted-or-openable sessions, as the composer sends: idle, even
//                                   with subagents working, it starts a turn (kind "prompt"); mid-turn
//                                   or compacting it is queued in Sova's queue as `delivery`, default
//                                   followUp; 409 TUI-live/foreign writer/Overseer's own; 400 blank
//                                   text or a bad delivery; used by sova_send; tagged as the
//                                   Overseer's only on its own in-process calls)
// ---------------------------------------------------------------------------

/** `customType` of the marker entry an Overseer file carries (with overseer-state.json naming it:
    the marker alone is copied by a fork). data: `{ v: 1 }`. */
export const OVERSEER_ENTRY = "sova-overseer";
/** `customType` of the invisible marker beside a prompt the Overseer sent to another session. */
export const OVERSEER_SENT_ENTRY = "sova-overseer-sent";
/** `customType` of the invisible marker for an extension-dialog answer the Overseer gave. */
export const OVERSEER_DIALOG_ANSWER_ENTRY = "sova-overseer-dialog-answer";

export interface OverseerSentMarkerData {
  v: 1;
  /** Entry id of the user message the Overseer sent (the row that gets the "Overseer" tag). */
  targetId: string;
  /** The Overseer session id that sent it, for the audit trail. */
  overseerId?: string;
}
export interface OverseerDialogAnswerData {
  v: 1;
  /** The dialog's title/question as shown to the user. */
  title: string;
  /** The answer, as display text (the chosen option, "Yes"/"No", or the typed input). */
  answer: string;
  overseerId?: string;
}

export type OverseerProactivity = "off" | "badge" | "brief";

export interface OverseerQuickAction {
  id: string;
  /** Title Case, short: "What Needs Me". */
  label: string;
  /** One line shown under the label in the flyout. */
  description: string;
  /** Sent verbatim as the user's message when picked. */
  prompt: string;
}

/** Per user turn, except `concurrentSessions` (at once, across turns). Over a cap the tool refuses
    and tells the model to stop and use sova_card / explain. */
export interface OverseerCaps {
  createPerTurn: number;      // default 5
  promptsPerTurn: number;     // default 10
  archivesPerTurn: number;    // default 50
  concurrentSessions: number; // default 10 (5 before): Overseer-started sessions running at once
  explorePerTurn: number;     // default 2: explorer subagents launched (sova_idea explore); absent on read → default
  linksPerTurn: number;       // default 3: links made (sova_link, §app.overseer/links-tools); absent on read → default
  orgWritesPerTurn: number;   // default 20: organization writes (§app.overseer/org-tools); absent on read → default
  gatherPerTurn: number;      // default 3: gathering sessions or offers started (sova_gather start/offer); absent on read → default
}

/** `<stateRoot>/overseer.json`. Tolerant on read, strict on PUT. */
export interface OverseerSettings {
  version: 1;
  /** "provider/model"; null = pi's default. Never becomes the default for new sessions. */
  model: string | null;
  /** off…max, clamped to the model; null = the model's default. */
  thinking: string | null;
  /** Appended after the Overseer's own prompt (which is appended after the user's APPEND_SYSTEM.md). */
  extraSystemPrompt: string;
  proactivity: OverseerProactivity; // default "badge"
  quickActions: OverseerQuickAction[];
  caps: OverseerCaps;
  /** The exploratory agent: the subagent sova_idea `explore` launches per idea. Default
      `{backend:"claude-code", model:"opus[1m]", effort:"medium"}` (Claude Opus 5.5). Absent or
      invalid on read → the default. */
  explorer: WorkerChoice;
  /** Resume the runs a server restart cut off (§app.overseer/auto-resume). Absent = on. */
  autoResume?: boolean;
}

export interface OverseerSettingsInfo {
  settings: OverseerSettings;
  /** The shipped defaults, for "Reset to Defaults". */
  defaults: { quickActions: OverseerQuickAction[]; caps: OverseerCaps; explorer: WorkerChoice };
  /** Absolute path of overseer.json, for the screen's footnote. */
  file: string;
}
export interface OverseerSaveResult extends OverseerSettingsInfo {
  /** Anything saved that could not be verified or that the policy refuses, one sentence each. */
  warnings: string[];
}

/** `<stateRoot>/overseer-state.json` (server-only). */
export interface OverseerState {
  version: 1;
  current: string; // session id
  history: string[]; // older Overseer session ids, newest first, ≤20
}

/** GET /api/overseer and POST /api/overseer/clear. */
export interface OverseerInfo {
  /** The current Overseer file: mount the normal chat on it (keyed on path). */
  path: string;
  id: string;
  /** Up to 20 previous Overseer files, newest first; openable read-only (watch, no chat). */
  history: { id: string; path: string; title: string; lastActiveAt: string }[];
  /** Attention counts for the entry button (from the digest). act = needs you; decide = finished/look. */
  badge: { act: number; decide: number };
  /** Overseer assistant messages newer than the Overseer's own seenAt: the chat-unread badge on the
      entry button, separate from `badge`. */
  unread: number;
  proactivity: OverseerProactivity;
  /** The Overseer is mid-turn. */
  busy: boolean;
}

export type AttentionTier = "act" | "decide" | "fyi";
export type AttentionKind =
  | "needs-input"     // extension dialog open (activity needs-input, or hosted pending dialog)
  | "error"           // the last turn stopped with an error (SessionSummary.turnError, or live activity error)
  | "worker-error"    // a subagent worker errored / was killed
  | "finished"        // replied since last seen, now idle
  | "draft"           // idle with an unsent composer draft
  | "queued"          // idle with queued input
  | "context-full"    // context ≥85%
  | "working"         // running now
  | "stale"           // idle web session >3 days, not archived, no draft
  | "open-questions"  // an idle session's alignments have open questions (SessionSummary.align, §chat.alignment/session-mark)
  | "looping"         // decisions: the session or a worker is repeating itself
  | "baton-needs-you" // a baton session: the baton is with the operator, or a person needs their link
  | "roster-proposal"  // a baton session proposed a new roster person (referral): approve or decline
  | "project-stakeholder" // an org project's main stakeholder left: pick a new one (no session: `path` "", `href` the project page)
  | "held-act"            // act tier, never pushed: a statechart act waits in a hold before it reaches a person or the code; Cancel stops it (no session: `path` "", `href` the project page, `held` set)
  | "outreach-not-sent"   // act tier, never pushed: a project overseer's WhatsApp send was refused or failed (no session: `path` "", `href` the person's page)
  | "conflict-to-operator" // decide tier, never pushed: an open conflict routed to the operator (or unrouted) with no settle session (no session: `path` "", `href` the project page)
  | "asks-you"        // decide tier: decisions' guess that the last reply of a turn with no open alignment question asks the user something
  | "ready-to-merge"  // decide tier: a worktree is ready, or ready and waiting for the go-ahead (SessionSummary.readiness)
  | "merged-open-work" // a merge whose reply names significant open work (§app.decisions/merge-followup)
  | "restart-pending" // merges changed the server since it started (one item, no session: `path` "")
  | "team-stalled";   // decide tier, counted in code: the session waits on subagents that have all been quiet 15 min (§app.decisions/team-stall)

export interface AttentionItem {
  /** Session id. */
  id: string;
  path: string;
  title: string;
  /** cwd (or target:remoteCwd), home-shortened. */
  where: string;
  tier: AttentionTier;
  kind: AttentionKind;
  /** ms epoch the condition began (or best proxy); 0 unknown. */
  since: number;
  /** ≤200 chars. */
  detail?: string;
  /** `#/s/<path>`. */
  href: string;
  /** The session's name summary-first (§app.overseer/session-names): its alias, a title someone
      set, its one-line summary, else `title`. Briefs, sova_attention and push use it. */
  name?: string;
  /** The session is open in a TUI: read-only for the Overseer. */
  tuiLive?: true;
  /** An organizational session's item (its `SessionSummary.org`, names only): the sidebar lists it
      in the Organizations region's own Needs you, never in the global one. The Overseer's badge,
      briefs and sova_attention still count it. */
  org?: SessionOrgRef;
  /** r12: an offer's invitees not reached yet (their working hours haven't come), by display name; `until`: their
      next window (ISO), null when none is found. Only on a gathering session's item whose offer is open. */
  waiting?: { name: string; until: string | null }[];
  /** kind `held-act` only: the hold's id (for `POST /api/orgs/:id/held/:holdId/cancel`), when it goes
      ahead (ms epoch), and its noun phrase, so the row recounts "{what} starts in {n} min unless you
      cancel it." as the minutes pass. */
  held?: {
    id: string;
    goesAt: number;
    what: string;
    /** "hours": it waits for a person's working hours (r7), `goesAt` is when their window opens; absent: the hold (r2). */
    wait?: "hold" | "hours";
    /** An hours wait's person, by display name. */
    person?: string;
    /** ms epoch: the hold ended and it waits for the overseer to approve it (r8: an act on the project's confirm list); the row's stall clock runs from here. */
    reviewSince?: number;
  };
}

/** Which org (and project) an organizational session belongs to; names as they read now. `projectId`
    is absent for a workspace file no project claims (an unregistered file); `projectName` is absent
    when the project is no longer in projects.json. */
export interface SessionOrgRef {
  orgId: string;
  orgName: string;
  projectId?: string;
  projectName?: string;
  /** The project is archived (§app.organizations/archive): the Organizations region leaves it out,
      except in its own Needs you. Safe by absence. */
  projectArchived?: true;
}

/** Which project a session belongs to, and as what; names as they read now. */
export interface SessionProject {
  projectId: string;
  projectName: string;
  /** `overseer`: one of its overseer's conversations; `coding`: a coding session the project started. */
  kind: "overseer" | "coding";
  /** A cleared (not the current) overseer conversation, or a build git says is merged. */
  finished?: true;
  /** The project is archived. */
  archived?: true;
}

export interface SessionOrg extends SessionOrgRef {
  /** `gathering`/`offer`: a baton session (an offer = started for several people); `overseer`: a
      project overseer's conversation; `coding`: a coding session the project started (by its
      overseer or Start coding session); `other`: an unregistered file in the workspace. */
  kind: "gathering" | "offer" | "overseer" | "coding" | "other";
  /** A baton `done`/`closed`, or a cleared (not the current) overseer conversation. The operator's
      own archive mark is `archived`, not this. */
  finished?: true;
}

/** GET /api/overseer/attention and the sova_attention tool. Sorted tier, then age; ≤30 items. */
export interface AttentionDigest {
  generatedAt: number;
  counts: { act: number; decide: number; fyi: number };
  items: AttentionItem[];
}

/** One line of `<stateRoot>/overseer-actions.jsonl`. */
export interface OverseerAction {
  at: string; // ISO
  overseerId: string;
  toolCallId: string;
  tool: string;
  args: unknown;
  /** partial: it did some of what was asked (a promotion with refusals); `error` says what was not done. */
  outcome: "ok" | "partial" | "refused" | "error";
  error?: string;
  /** A done act's one-line result worth showing (a project overseer's promotion commit, a coding session's branch). */
  note?: string;
  /** The approval for later or standing rule (`g_N` / `r_N`) an unattended act ran under (§app.overseer/approvals). */
  under?: string;
}

/** GET /api/overseer/autonomy (§app.overseer/approvals, §app.overseer/caps): the running count
    beside its cap, and every approval for later and standing rule of the current conversation
    (the shape is shared/overseer-grants.ts `Permit`). */
export interface OverseerAutonomy {
  running: number;
  cap: number;
  permits: Permit[];
  /** Every playbook schedule Sova knows of (§chat.schedules/where-shown). */
  schedules?: ScheduleInfo[];
}

// --- Tool results the Overseer ChatView renders specially (tool_execution_end `result.details`
// and the persisted tool-result row's raw `details`). ---

/** `sova_navigate` details. `href` is `#/…` or `settings:<tab>[/<section>]`. Applied ONLY by the tab
    that started the running turn (its own send_ack queued:false, or queue_item_gone delivered with
    its own clientId); never by other tabs, reloads or proactive turns. The card always shows "Go". */
export interface SovaNavigateDetails {
  href: string;
  label: string;
}

/** `sova_confirm` details: the card tool before `sova_card` (shared/overseer-card.ts `CardDetails`),
    kept to render older conversations read-only (§app.overseer/confirm). The item rows below are
    also the `sova_card` card's item snapshot. As it was: non-blocking, the model ended its turn.
    The card shows `options` as buttons; a click sends the option's `reply` (or its label) as the
    next user message. Answered/disabled once any later user message exists in the transcript
    (`answer` = that message's text when it matches an option). `items`: what the question is
    about, resolved by the server when the card was raised and snapshotted here (absent on cards
    raised without any, and on every card from before the field existed). */
export interface SovaConfirmDetails {
  title: string;
  detail?: string;
  options: { label: string; reply?: string; tone?: "default" | "danger" }[];
  items?: SovaConfirmItem[];
  /** The global Overseer's card listing a person, a project or a gathering session: it may gate an
      act that reaches people or ends something, which only a click on it approves, never typed text
      (§app.overseer/org-people-facing). The card drops its "Or type your answer." hint. Safe by absence. */
  clickOnly?: true;
}

/** One thing a confirm card is about. A session row: its folder's short name (`project`), last
    activity (ISO), a one-line summary when it has one, and how many subagents were working.
    `note`: the Overseer's own words on what the item is and why the card acts on it (≤ 2 short
    sentences, `CONFIRM_NOTE_MAX` characters). */
export type SovaConfirmItem =
  | { kind: "session"; id: string; title: string; project?: string; lastActiveAt?: string; summary?: string; workers?: number; note?: string }
  | { kind: "idea"; id: string; title: string; note?: string }
  | { kind: "todo"; id: string; text: string; note?: string }
  /** A project registered on this host: its name, and the org's when one places it (§app.overseer/org-tools). */
  | { kind: "project"; id: string; orgId?: string; name: string; orgName?: string; note?: string }
  /** A roster person: name, status and org. Never a contact or a link. */
  | { kind: "person"; id: string; orgId: string; name: string; orgName: string; status: "active" | "proposed" | "left"; note?: string };

/** The longest note one confirm item may carry. */
export const CONFIRM_NOTE_MAX = 220;

// --- The Overseer's ideas backlog: spec-shaped (manifest + one .md per idea, § ids), its own
// small reader and link graph. Nothing is deleted; `dropped` is terminal. ---

/** `open` filed · `exploring` an explorer subagent is linked · `started` a session is linked ·
    `done` / `dropped` only when the user says so (dropped is terminal: no further status change). */
export type IdeaStatus = "open" | "exploring" | "started" | "done" | "dropped";
export const IDEA_STATUSES: IdeaStatus[] = ["open", "exploring", "started", "done", "dropped"];

/** An idea id. Main entry `§<ns>/<name>` (file `ideas/<ns>/<name>.md`); sub-entry
    `§<ns>.<parent>/<name>` (file `ideas/<ns>/<parent>/<name>.md`), whose parent `§<ns>/<parent>`
    must exist. ns = the project; each segment is lowercase `[a-z0-9][a-z0-9-]*`, ns ≤ 32 chars,
    parent and name ≤ 64. The `§` is canonical; inputs may omit it. Groups: 1 ns, 2 parent?, 3 name. */
export const IDEA_ID_RE = /^§?([a-z0-9][a-z0-9-]{0,31})(?:\.([a-z0-9][a-z0-9-]{0,63}))?\/([a-z0-9][a-z0-9-]{0,63})$/;

/** One record of ideas/manifest.json (the id is its key there). */
export interface IdeaMeta {
  /** One line, ≤ 120 chars: what the ToC shows. */
  title: string;
  status: IdeaStatus;
  /** Themes: lowercase `[a-z0-9-]`, ≤ 8, each ≤ 32. */
  tags: string[];
  /** Other ideas this one relates to (any namespace), canonical § ids; directed edges this → link. */
  links: string[];
  /** The session started from it (sova_create_session's id). Linking one sets `started`. */
  sessionId?: string;
  /** Its exploratory subagent's worker id (`ag_NN`). Linking one sets `exploring`. */
  explorerId?: string;
  /** The Overseer conversation (session id) that owns that explorer: workers die with it (/clear,
      restart), so `tell` refuses when this is not the current conversation. */
  explorerOverseerId?: string;
  /** Its former ids, oldest first, at most 8 (a rename adds one). Reads, links and todo links
      through one reach this record; no other idea may take one. */
  renamedFrom?: string[];
  createdAt: string; // ISO
  updatedAt: string; // ISO; also the PATCH `base`
}

/** `<stateRoot>/ideas/manifest.json`. Tolerant read: bad records are dropped, never thrown. */
export interface IdeasManifest {
  formatVersion: 1;
  ideas: Record<string, IdeaMeta>;
}

export interface IdeaRecord extends IdeaMeta {
  id: string; // canonical, with §
  ns: string;
  /** For a sub-entry, its main entry's id. */
  parent?: string;
}

/** The ToC: namespaces sorted by name; within one, main entries by id, each followed by its
    sub-entries. `counts` has every status (0 included). */
export interface IdeasToc {
  total: number;
  namespaces: {
    ns: string;
    counts: Record<IdeaStatus, number>;
    entries: { id: string; title: string; status: IdeaStatus; parent?: string }[];
  }[];
}

/** GET /api/overseer/ideas. `edges` = every link (from → to), for the graph view. */
export interface OverseerIdeasInfo {
  toc: IdeasToc;
  ideas: IdeaRecord[];
  edges: { from: string; to: string }[];
  /** Absolute path of the ideas dir, for the footnote. */
  dir: string;
}

/** GET/PATCH /api/overseer/idea. `text` = the prose .md ("" when missing). `scope` = every idea it
    reaches through links, transitively (itself excluded; sub-entries of it included); `linkedBy` =
    the ideas that link to it directly (its impact). */
export interface OverseerIdeaDetail {
  idea: IdeaRecord;
  text: string;
  scope: string[];
  linkedBy: string[];
}

/** PATCH body. Absent fields are unchanged. `base` = the updatedAt the editor started from; when it
    no longer matches → 409. Setting a status on a dropped idea is 400. `newId` renames the idea
    (after the other fields are applied); the answer is the detail under the new id. */
export interface IdeaPatch {
  base?: string;
  title?: string;
  status?: IdeaStatus;
  tags?: string[];
  links?: string[];
  text?: string;
  newId?: string;
}
export interface IdeaConflict {
  error: string;
  current: OverseerIdeaDetail;
}

/** `sova_idea` details (every op): the idea it touched, so a card or the panel can link it. */
export interface SovaIdeaDetails {
  id: string;
  op: "add" | "update" | "append" | "link" | "rename" | "explore" | "tell";
  status: IdeaStatus;
  explorerId?: string;
  /** rename: the id it had before. */
  from?: string;
}

// ---- Overseer todos: the user's short checklist (server/overseer-todos.ts), <stateRoot>/todos.json.
// A flat list in the user's order; a todo may point at an idea or a session. The Overseer
// (sova_todo, attended turns only) and the panel's routes are its writers.

export const TODO_ID_RE = /^td_[a-z0-9]{8}$/;
export const TODO_TEXT_MAX = 200;
export const TODOS_MAX = 200;

export interface TodoRecord {
  /** "td_" + 8 lowercase letters or digits; opaque, so an edit never changes identity. */
  id: string;
  /** One line, whitespace collapsed, 1..TODO_TEXT_MAX characters. */
  text: string;
  done: boolean;
  createdAt: string;
  /** Strictly increasing per record: the PATCH `base`. */
  updatedAt: string;
  /** Set on check, cleared on uncheck. */
  doneAt?: string;
  /** A canonical idea § id that existed when it was linked; an idea's rename rewrites it. */
  ideaId?: string;
  /** The id of the session the task is about (a pointer, never an act on it). */
  sessionId?: string;
}

/** todos.json. Array order is list order. */
export interface TodosFile {
  formatVersion: 1;
  todos: TodoRecord[];
}

/** GET /api/overseer/todos, and every todo write's result. `file` = the absolute path, for the footnote. */
export interface OverseerTodosInfo {
  todos: TodoRecord[];
  open: number;
  done: number;
  file: string;
}

/** PATCH body. Absent fields are unchanged; `null` unlinks. `base` = the updatedAt the edit started
    from: when sent and no longer current → 409 TodoConflict. */
export interface TodoPatch {
  base?: string;
  text?: string;
  done?: boolean;
  ideaId?: string | null;
  sessionId?: string | null;
}
export interface TodoConflict {
  error: string;
  current: OverseerTodosInfo;
}

/** `sova_todo` details (every op). `removed` = how many clear_done deleted. */
export interface SovaTodoDetails {
  id: string;
  op: "add" | "check" | "uncheck" | "edit" | "remove" | "clear_done";
  done?: boolean;
  removed?: number;
}

/** Marks an Overseer turn was started by proactivity (server-sent "Brief me"). The prompt text of
    such a turn starts with this prefix, so the transcript renders it as a machine row, not "You". */
export const OVERSEER_BRIEF_PREFIX = "[overseer-brief]";

// ---------------------------------------------------------------------------
// Web Push: phone notifications for blockers (server/push*.ts, server/web-push.ts). Not the
// sessions feed's "push" of marks (/ws/watch?feed=sessions). Every response is no-store, and no
// response ever carries a device's endpoint or keys back out.
//
// GET    /api/push             -> PushInfo
// PUT    /api/push/settings    body PushSettings -> PushSettingsInfo (400 invalid, the reason as a sentence)
// POST   /api/push/subscribe   body PushSubscribeRequest -> PushDevice (400 invalid subscription;
//                              410 a re-sync of a device that was removed: the browser drops it)
// DELETE /api/push/subscribe   body { endpoint } | { id } -> { removed: boolean }
// POST   /api/push/test        body { id? } -> PushTestResult (409 no contact address saved;
//                              404 no device)

/** The act-tier kinds a phone notification can be about (server/attention.ts). */
/** "looping" (Subagent stuck) is retired: a stuck subagent is a decide item, never a blocker. */
export type PushKind = "needs-input" | "open-questions" | "error" | "baton-needs-you" | "worker-error";
export const PUSH_KINDS: readonly PushKind[] = ["needs-input", "open-questions", "error", "baton-needs-you", "worker-error"];

/** `<stateRoot>/push.json`. */
export interface PushSettings {
  version: 1;
  /** Off: nothing is sent to any device (Send Test still works). */
  enabled: boolean;
  /** The VAPID `sub`: `mailto:…` or `https://…`. Required before anything is sent; no default. */
  contact: string | null;
  kinds: Record<PushKind, boolean>;
  /** Server-local time, "HH:MM" 24-hour; the range may cross midnight; start ≠ end. */
  quietHours: { enabled: boolean; start: string; end: string };
}

export interface PushSettingsInfo {
  settings: PushSettings;
  defaults: PushSettings;
  file: string;
}

/** One subscribed device, as the wire shows it: never its endpoint or keys. */
export interface PushDevice {
  /** A hash of the endpoint (hex): what Remove and Send Test name. The browser computes the same
      from its own subscription to find "this device". */
  id: string;
  label: string;
  /** The push service's host (fcm.googleapis.com, web.push.apple.com, …). */
  service: string;
  createdAt: number;
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface PushInfo extends PushSettingsInfo {
  /** The server's VAPID public key (base64url, 65-byte point): the browser's applicationServerKey. */
  publicKey: string;
  devices: PushDevice[];
}

export interface PushSubscribeRequest {
  /** PushSubscription.toJSON(). */
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  label?: string;
  /** The app's load-time re-sync, not an Enable: refused (410) for a device that was removed. */
  resync?: boolean;
  /** The endpoint this one renews (the service worker's pushsubscriptionchange): its label and age carry over. */
  replaces?: string;
}

export interface PushTestResult {
  results: { id: string; label: string; ok: boolean; removed?: boolean; error?: string }[];
}

/** What the service worker receives (JSON in the encrypted payload). */
export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag: `sova:<sessionId>`, `sova:several`, `sova:test`. */
  tag: string;
  /** Where a tap goes: `#/sid/<id>` or `#/overseer`. */
  hash: string;
  /** Sessions that need you now, for the app badge; absent (Send Test) leaves the badge alone. */
  count?: number;
  ts: number;
}
/** GET /api/extensions: one entry per valid manifest record (`<state root>/extensions.json`, or
    SOVA_EXTENSIONS_FILE), in manifest order. `status` is a 1.5 s GET `<api>/api/health` (2xx =
    "ok"), cached 10 s per extension; `error` says why a "down" one is down. ext-contract-v1.2. */
export interface ExtensionInfo {
  id: string; // [A-Za-z0-9._-]+; the UI is at /ext/<id>/, the app route is #/ext/<id>
  title: string;
  description?: string;
  icon?: string; // a Sova icon name (public/icons/<name>.svg)
  status: "ok" | "down";
  error?: string;
}

// ---------------------------------------------------------------------------
// Mesh: other Sova hosts on the tailnet (server/mesh/). The allowlist is `<state root>/peers.json`;
// the mesh is ON exactly when it lists at least one peer. OFF, none of these routes calls Tailscale
// or any peer, and no other route or type changes: a SessionSummary never names a host.
//
// Main listener (the browser's):
// GET  /api/mesh                -> MeshInfo   (OFF: from local files only)
// PUT  /api/mesh/peers MeshPeersUpdate -> MeshInfo   (replaces the peer list; an entry without
//                                  nodeId is resolved by `name` through LocalAPI status. 400 bad body or
//                                  a name not on the tailnet, 409 peers.json exists but is malformed)
// GET  /api/mesh/candidates     -> MeshCandidate[]   (LocalAPI status + a hello probe of each online
//                                  node; only on an explicit user request, also while OFF. 502 tailscaled
//                                  unreachable)
// GET  /api/mesh/sessions       -> MeshSessions   (each peer's GET /api/sessions, grouped by peer; local
//                                  sessions are not included: they stay at GET /api/sessions)
// GET  /api/mesh/settings       -> MeshSettings
// PUT  /api/mesh/settings Partial<MeshSettings> -> MeshSettings   (stored in peers.json; with no peers
//                                  the mesh stays OFF. 400 bad body, 409 malformed peers.json)
// GET  /api/mesh/front-door     -> FrontDoorConfig   (generated from peers.json + settings; OFF too)
// GET  /api/mesh/logins        -> MeshLogins   (this host's view of each synced login; no secret,
//                                  no fingerprint. 404 while OFF)
// POST /api/mesh/logins/claim MeshLoginClaim -> {ok:true}   (keep THIS host's login for that key on
//                                  every host: it becomes a login made now. Settles a pre-sync
//                                  conflict; to keep a peer's login, claim on that peer's page. An
//                                  "expired" one can be claimed: it spreads once refreshed. 400 bad
//                                  body or unknown key, 409 nothing here to claim (logged out or dead)
//                                  or the logins switch is off, 404 while OFF)
// GET  /api/mesh/hello          -> MeshHello   (this host's own, for the SPA's stale-tab check: id,
//                                  version, protocol, build. Cheap (a stat), and answered with the
//                                  mesh off too, no Tailscale call; nodeId only while on)
// ANY  /peer/<id>/api/...       -> the peer's /api/... verbatim (query included, bytes untouched).
//                                  404 {error:"Unknown peer"}, 502 {error:"peer down", id},
//                                  504 {error:"peer timeout", id} (took the connection, sent no response
//                                  headers within 30 s; a body streaming after them is never cut),
//                                  403 {error:"peer refused", id} (its allowlist does not list this host)
// WS   /peer/<id>/ws/chat|watch -> the peer's socket; frames and close codes pass through exactly. A
//                                  peer that is down or refuses is an HTTP 502/403 before any upgrade
//                                  (the browser sees 1006 and retries), never a 4422.
//
// Peer listener (tailnet IPs, SOVA_PEER_PORT, default 4801; only while ON): every request and upgrade
// is from a node whose Tailscale StableID is in peers.json (LocalAPI whois), else 403
// {error:"not a peer"}. It serves /api/* except /api/mesh/*, /ws/chat and /ws/watch, and
// GET /api/peer/hello -> MeshHello. /api/peer/* exists only here (404 on the main listener).
// ---------------------------------------------------------------------------

/** GET /api/mesh/hello, and /api/peer/hello between peers. */
export interface MeshHello {
  /** The hello format version. */
  mesh: 1;
  id: string;
  label: string;
  hostname: string;
  /** Sova's package version. */
  version: string;
  /** First 16 hex of sha256(shared/protocol.ts): equal ⇔ the same wire contract. */
  protocol: string;
  /** The pinned pi package version. */
  pi: string;
  /** First 16 hex of sha256 of the served dist/index.html (it names every hashed asset, so it
      changes with every frontend build); absent when no build is served. A tab whose own build
      differs is running an older (or newer) app than this host serves. */
  build?: string;
  /** This node's Tailscale StableID, when the mesh is on and tailscaled answered. */
  nodeId?: string;
  /** ms epoch, for a clock-skew check. */
  now: number;
}

/** up: hello answered with the same protocol; skewed: another protocol; refused: its allowlist
    doesn't list this host (403 "not a peer"); down: anything else (no answer, timeout, error). */
export type PeerState = "up" | "down" | "skewed" | "refused";

export interface PeerStatus {
  id: string; // [a-z0-9][a-z0-9-]{0,31}; the <id> in /peer/<id>/
  label: string;
  /** Tailscale StableID: what this host's peer listener authenticates the peer by. */
  nodeId: string;
  /** MagicDNS name (or tailnet IP). */
  name: string;
  /** Where this host dials it (its peer listener). */
  url: string;
  /** Front-door order hint, when the user set one. */
  priority?: number;
  state: PeerState;
  error?: string;
  hello?: MeshHello;
  /** Last successful hello (ms epoch) since this server started; null when never. */
  lastSeen: number | null;
}

export type SyncCategory = "settings" | "themes" | "extensions" | "logins";

export interface SyncStatus {
  category: SyncCategory;
  enabled: boolean;
  state: "ok" | "pending" | "error" | "off";
  lastAt: number | null;
  error?: string;
}

export interface MeshInfo {
  enabled: boolean;
  self: {
    id: string;
    label: string;
    hostname: string;
    /** From LocalAPI, ON only. */
    nodeId?: string;
    dnsName?: string;
    /** The peer listener, ON only; `error` while it can't bind (e.g. tailscaled not up yet). */
    listen?: { addresses: string[]; port: number; error?: string };
  };
  peers: PeerStatus[];
  /** Empty while OFF. */
  sync: SyncStatus[];
  frontDoor: string | null;
  /** peers.json exists but can't be used (the mesh is OFF because of it). */
  error?: string;
}

export interface MeshPeerEntry {
  id: string;
  label?: string;
  /** Tailscale StableID; omitted → resolved from `name` through LocalAPI status. */
  nodeId?: string;
  /** MagicDNS name, short host name or tailnet IP. */
  name: string;
  /** http(s)://host:port when not http://<name>:4801. */
  url?: string;
  priority?: number;
  /** Its browser-facing address, the front door's upstream, when not https://<name>:8443. */
  serveUrl?: string;
}

export interface MeshPeersUpdate {
  peers: MeshPeerEntry[];
}

export interface MeshCandidate {
  nodeId: string;
  /** MagicDNS name. */
  name: string;
  hostName: string;
  os: string;
  online: boolean;
  tags: string[];
  /** The owner's login; "tagged-devices" for a tagged node. */
  login: string;
  addresses: string[];
  /** Already in peers.json under this id. */
  peerId?: string;
  /** From the probe of http://<name>:4801/api/peer/hello: "yes" answered, "refused" runs Sova but
      doesn't list this host, "no" nothing answered (or offline, not probed). */
  sova: "yes" | "refused" | "no";
  hello?: MeshHello;
}

export interface MeshSessions {
  peers: Array<{
    id: string;
    label: string;
    state: PeerState;
    error?: string;
    /** That peer's GET /api/sessions as it sent it. */
    sessions?: SessionSummary[];
    /** `sessions` is the last good list of a peer that is not answering now. */
    stale?: boolean;
  }>;
}

export interface MeshSettings {
  hostLabel: string;
  /** Per category; true unless the user turned it off. */
  sync: Record<SyncCategory, boolean>;
  /** The front door's URL, when the user set one. */
  frontDoor: string | null;
  /** The front door's upstream order: host ids, this host included. Hosts it leaves out follow in
      peers.json order (this host first); ids that are no longer hosts are skipped. Absent = that
      default order. */
  frontDoorOrder?: string[];
  /** This host's browser-facing address (its front-door upstream), when not
      https://<its MagicDNS name>:8443. null clears it. */
  serveUrl?: string | null;
  /** Which logins this host syncs. "api-keys": API keys only; OAuth (subscription) logins are
      neither sent to it nor taken by it, and its own stay on it. Absent = "all". In a PUT, null
      = "all". A host started with SOVA_SYNC_LOGIN_KINDS pins it (a PUT of another value is 409). */
  loginKinds?: "all" | "api-keys" | null;
  /** GET only: `loginKinds` is pinned by SOVA_SYNC_LOGIN_KINDS on this host (the UI can't change it). */
  loginKindsPinned?: true;
}

/** One row of GET /api/mesh/logins: how a login stands on this host. Never a secret. */
export interface MeshLoginEntry {
  /** "<store>:<provider>", e.g. "pi:zai", "claude:claudeAiOauth". */
  key: string;
  /** pi = pi's auth.json, claude = Claude Code's credentials. */
  store: "pi" | "claude";
  provider: string;
  kind?: "oauth" | "api_key";
  state: "live" | "expired" | "dead" | "logged-out";
  /** OAuth expiry, ms epoch. */
  expires?: number;
  /** When logged in (ms epoch); 0 = found on disk before sync started. A refresh keeps it. */
  loginAt?: number;
  /** When this exact token was issued (a refresh changes it). */
  issuedAt?: number;
  /** The host id that logged in or last refreshed it. */
  origin?: string;
  /** Peers holding a different login from before sync: this key is not synced until one is claimed. */
  conflictWith?: string[];
}

export interface MeshLogins {
  entries: MeshLoginEntry[];
}

export interface MeshLoginClaim {
  key: string;
}

/** GET /api/mesh/front-door: a Caddy front door for these hosts, generated only; Sova never runs
    or writes Caddy. Also answered with the mesh off (this host alone, no Tailscale call). */
export interface FrontDoorConfig {
  /** Upstreams in failover order: the first healthy one serves. */
  order: Array<{ id: string; label: string; upstream: string }>;
  /** A complete Caddyfile (lb_policy first, active health checks), with setup notes as comments. */
  caddyfile: string;
}

// ---------------------------------------------------------------------------
// DECISIONS (opt-in): one provider-neutral decision seam (server/decide*.ts), used by two
// features: attention signals ("needs you" marks) and session tags. Providers are Jev
// (TypeSafe, api.typesafe.ai) and a configured pi / Claude Code model; the chain picks.
// Everything here is SAFE BY ABSENCE: an older server sends none of these fields.
//
// GET  /api/settings/decisions            -> DecisionSettingsInfo (<stateRoot>/decisions.json; missing → defaults:
//                                            both features off, fallback null, Jev enabled)
// GET  /api/settings/decisions/options    -> DelegateOptions (the same discovery as delegate/options)
// PUT  /api/settings/decisions DecisionSettings -> DecisionSaveResult (replaces the whole file; 400 bad shape;
//                                            an unverifiable or policy-denied fallback saves with a warning)
// PUT  /api/settings/decisions/key {key: string} -> DecisionKeyInfo (checks the key against Jev's
//                                            GET /v1/models first; 400 empty/malformed; a rejected key is NOT
//                                            stored and answers 422 with status "rejected". The key itself is
//                                            never sent back, only `last4`)
// DELETE /api/settings/decisions/key     -> DecisionKeyInfo (present: false)
// POST /api/settings/decisions/probe      -> DecisionProbeResult (one canned decision through the chain — the
//                                            "Test" button; never 5xx for a provider failure: ok false + failure)
// POST /api/sessions/tags {id, user: string[] | null} -> { tags: SessionTags | null }   (manual tags; null clears)
// POST /api/sessions/tags/backfill {scope: TagsBackfillScope} -> TagsBackfillProgress  (starts, or returns the
//                                            running job; 409 while the tags feature is off or the chain is
//                                            unavailable)
// GET  /api/sessions/tags/backfill       -> TagsBackfillProgress ({running:false, done:0, total:0, failed:0} before any run)
// POST /api/sessions/tags/backfill/cancel -> TagsBackfillProgress (stops the running job; what it classified stays)
// Errors on every route above are {error: "one sentence"} (409 on backfill included), except the
// rejected-key 422, whose body is a DecisionKeyInfo with status "rejected".
//
// Push: WS /ws/watch?feed=sessions — the existing read-only socket, in a session-less mode (no
// ?path=). Sends SessionFeedMessage: a full `marks` snapshot on connect, then one `marks` message
// per change (a signal, tag or turn error written, cleared, or pruned) and `tags_backfill` progress while a
// backfill runs. The client overlays these onto its SessionSummary list by id without waiting for
// the list poll; the list itself still carries the same fields (the poll stays the source of truth
// after a reconnect). Never writes; the socket ignores anything the client sends.
// ---------------------------------------------------------------------------

/** Why a decision could not be made (server/decide.ts DecisionError.failure). */
export type DecisionFailure =
  | "unavailable"      // no key / Jev off / no model configured / policy denies the model / CLI missing / breaker open
  | "auth"             // 401/403 from Jev, no auth configured for the model
  | "quota"            // credits/billing exhausted
  | "rate-limit"       // 429
  | "overloaded"       // 529 / 503
  | "timeout"          // our own deadline
  | "network"          // fetch threw, spawn failed
  | "too-large"        // state over the provider's limit
  | "bad-request"      // OUR bug: a malformed question. Never falls through to the next provider.
  | "malformed-answer" // the provider answered outside the contract
  | "server";          // other 5xx / unknown

export type DecisionProviderId = "jev" | "pi" | "claude-code";

/** <stateRoot>/decisions.json. Nothing leaves the machine unless a feature is on. */
export interface DecisionSettings {
  version: 1;
  /** Jev's own switch, independent of the key. Off → the fallback model is the only provider. */
  jev: { enabled: boolean };
  /** The model used when Jev is off, has no working key, or fails. null = none (the default):
      nothing is ever picked for the user. */
  fallback: WorkerChoice | null;
  /** `reconcile`: compare a project's recorded decisions (§app.requirements/reconciler); absent =
      RECONCILE_DEFAULT (shared/decisions.ts). */
  features: { attention: boolean; tags: boolean; reconcile?: boolean };
  /** Absolute cwd prefixes (a leading `~/` is allowed) whose sessions are never sent. */
  exclusions: string[];
  /** Never send terminal sessions: open in a TUI now, or started outside Sova (origin "external")
      and not hosted by this server (server/decide-settings.ts terminalSession). */
  neverSendTui: boolean;
}

export type DecisionKeyStatus =
  | "absent"      // no key file and no SOVA_JEV_KEY
  | "unverified"  // stored, not checked since the server started
  | "ok"          // the last check or call succeeded
  | "rejected"    // Jev answered 401/403
  | "error";      // the last check failed for another reason (network, 5xx) — the key may be fine

/** The Jev key as the wire sees it. The key itself NEVER crosses the wire. */
export interface DecisionKeyInfo {
  present: boolean;
  /** Last 4 characters, for recognition. */
  last4?: string;
  /** "env" = SOVA_JEV_KEY overrides the file (the screen can't change or delete it). */
  source?: "file" | "env";
  status: DecisionKeyStatus;
  /** ms epoch of the last check/call that set `status`. */
  checkedAt?: number;
  /** One sentence when status is rejected/error. */
  message?: string;
}

export interface DecisionProviderStatus {
  id: DecisionProviderId;
  /** "Jev", "pi · ollama-cloud/deepseek-v4.1-flash", "Claude Code · haiku". */
  label: string;
  /** "ok" = will be tried; "skipped" = its breaker is open until `until`. */
  state: "ok" | "skipped";
  until?: number;
  lastFailure?: { failure: DecisionFailure; message: string; at: number; requestId?: string };
  lastOkAt?: number;
}

/** The chain as configured right now, in order. `ready: false` ⇔ no provider at all (Jev off or
    keyless AND no fallback): both features then report unavailable and send nothing. */
export interface DecisionChainStatus {
  ready: boolean;
  providers: DecisionProviderStatus[];
  /** One sentence when not ready. */
  reason?: string;
}

/** GET /api/settings/decisions. */
export interface DecisionSettingsInfo {
  settings: DecisionSettings;
  defaults: DecisionSettings;
  key: DecisionKeyInfo;
  chain: DecisionChainStatus;
  /** Shown as hints beside the fallback row, never pre-selected. */
  suggestions: WorkerChoice[];
  backends: { id: DelegateBackendId; label: string; efforts: string[] }[];
  /** Absolute path of decisions.json, for the footnote. */
  file: string;
}

/** PUT /api/settings/decisions: what is now stored, plus one sentence per warning. */
export interface DecisionSaveResult extends DecisionSettingsInfo {
  warnings: string[];
}

/** POST /api/settings/decisions/probe. */
export interface DecisionProbeResult {
  ok: boolean;
  provider?: DecisionProviderId;
  model?: string;
  latencyMs?: number;
  /** The first provider failed and a later one answered. */
  fellBackFrom?: { provider: DecisionProviderId; failure: DecisionFailure; message: string };
  /** When ok is false. */
  failure?: DecisionFailure;
  message?: string;
  chain: DecisionChainStatus;
}

/** Attention-signal kinds the thresholds (fixed in server/signals-store.ts) derive from raw answers.
    "asks-you": the last reply of a turn with no open alignment question asks the user something
    (open alignment questions stay SessionSummary.align's deterministic count); "looping": the turn
    went in circles. */
export type SignalKind = "asks-you" | "looping";

/** One classified finished turn of a session (<stateRoot>/signals.json keeps the raw answers). */
export interface SessionSignals {
  /** ms epoch the turn was classified. */
  at: number;
  /** Id of the last assistant entry on the active branch when classified (the cache key). */
  turnId: string;
  provider: DecisionProviderId;
  /** score in [0, 2]: 0 progressing … 2 clearly looping. */
  stuck?: { score: number; confidence: number };
  /** P(the last reply asks the user something), 0..1, when that turn was asked. */
  asksUser?: number;
  /** The kinds that fire under the server's thresholds; [] = none. The client never re-derives
      them. Visibility is server-computed too: `signals` (and `workerSignals`) are present on a
      SessionSummary / SessionMarks only while the mark should show (attention on, kinds non-empty,
      not seen since `at`, not running). Present = show. */
  kinds: SignalKind[];
}

/** Fixed topic taxonomy v1 (order = display order). */
export const TAG_TOPICS = [
  "feature", "bugfix", "refactor", "tests", "docs", "infra", "research",
  "planning", "review", "data", "config", "experiment", "chore", "other",
] as const;
export type TagTopic = (typeof TAG_TOPICS)[number];

/** A session's tags, confidence-gated on the server (a field is absent when below its threshold).
    There is no status tag: SessionSummary.readiness says whether work is ready, waiting or merged
    (a status answer stored before is kept in session-tags.json and never sent). */
export interface SessionTags {
  topic?: TagTopic;
  /** A test or scratch session with no lasting work. */
  throwaway?: true;
  /** Manual tags (POST /api/sessions/tags), lowercase, deduped. */
  user?: string[];
}

export interface SessionAlign {
  openDocs: number;
  openQuestions: number;
  questionDocs: number;
  lead?: { id: string; title: string };
}

// Declaration merge: what SessionSummary gains beyond its core fields. `signals`, `workerSignals`
// and `tags` are overlays listSessions sets from the stores, never from the (mtime,size) cache;
// `align` is read from the file itself and cached with the summary. Absent = not classified,
// feature off, nothing waiting, or an older server.
export interface SessionSummary {
  /** The session's open alignments while it waits on the user (§chat.alignment/session-mark), folded
      from its file's `align` tool results along the active branch (server/align-state.ts, read
      incrementally), deterministic, no model. Present only while an alignment is open (not done
      or dropped), align is on (the newest `mode` entry on the branch), and the newest align result
      that changed a document comes after the user's last prompt (a wake nudge or link message is
      not one): once the user has moved on, the questions stay on the card and the chip only.
      `questionDocs` = the open alignments that have open questions; `lead` = the last-touched of
      those, for the wording. */
  align?: SessionAlign;
  signals?: SessionSignals;
  /** Worker checks of this session's subagents: how many look stuck; details are in the attention
      digest. (A worker that ended in an error is the digest's deterministic "worker-error".) */
  workerSignals?: { stuck: number };
  tags?: SessionTags;
  /** Merge readiness of the worktrees this session tracks (§chat.worktrees/readiness,
      server/merge-readiness.ts): git and the file, no model, read in the background, so a row
      gains it a moment after it first lists. Absent when the session tracks no worktree of its
      own, before git was first read, and from older servers. */
  readiness?: SessionReadiness;
}

/** One worktree's merge readiness (§chat.worktrees/readiness). */
/** "removed": the worktree's folder is gone and its work isn't known merged (§chat.worktrees/readiness). */
export type ReadinessState = "merged" | "stale" | "in-progress" | "blocked" | "ready" | "waiting-approval" | "removed";

export interface WorktreeReadiness {
  /** Canonical top level (SessionWorktreeInfo.path). */
  path: string;
  branch: string;
  state: ReadinessState;
  /** Git finds the branch merged into its base, clean tree or not (or, the folder gone, it is
      recorded merged). Set even while uncommitted changes keep `state` stale or in progress: the
      row's count counts it. Absent when not merged. */
  merged?: true;
  /** Why, in a few words: "uncommitted changes", "TEMP commit", "the last check failed", "checks
      passed", "no check run seen", "still tracked active". */
  why?: string;
  /** The line a person reads without hovering (the Session tab): state and why, joined by " · " —
      "Ready to merge · checks passed · 19 commits ahead", "Conflicts with master · 17 files". */
  reason?: string;
  /** Uncommitted files: how many, and the first few (repo-relative). Absent when clean or unknown. */
  dirtyCount?: number;
  dirtyFiles?: string[];
  /** Files a trial merge into the base conflicts on. Absent when none or unknown. */
  conflicts?: number;
}

/** The row's badge, the first that holds (§chat.worktrees/readiness). */
export type ReadinessBadge = "waiting" | "ready" | "restart" | "merged";

export interface SessionReadiness {
  /** Every own, non-dropped tracked worktree, in recorded order. */
  trees: WorktreeReadiness[];
  /** Absent when no badge holds (a worktree in progress, blocked or stale). */
  badge?: ReadinessBadge;
  /** The worktree the badge speaks for. */
  branch?: string;
  /** ms epoch the badge's condition began: the last reply for ready/waiting, the merge for merged. */
  since: number;
  /** How much post-merge work the follow-up check named; the row words it ("2 follow-ups").
      Cleanup is said in the title. */
  followUps?: number;
  /** A merge of this session changed the server since this process started. */
  restartPending?: true;
  /** The newest merge's commit is not on the target's origin branch yet. */
  pushPending?: true;
  /** Merged worktrees still tracked active. */
  cleanup?: number;
  /** The follow-up check's answer for the newest merge (§app.decisions/merge-followup), when it
      names work: its weight and the reply's own line naming it. */
  followUp?: { weight: "small" | "significant"; cue: string };
}

export type TagsBackfillScope = "recent" | "all";

/** GET/POST /api/sessions/tags/backfill. `recent` = sessions active in the last 30 days. */
export interface TagsBackfillProgress {
  running: boolean;
  scope?: TagsBackfillScope;
  done: number;
  total: number;
  failed: number;
  startedAt?: number;
  finishedAt?: number;
  /** Why it stopped early (feature switched off, chain unavailable, …). */
  stoppedReason?: string;
}

/** One session's pushed overlays (the decision marks and the turn-error mark). `null` = cleared (remove the field); absent key = unchanged. */
export interface SessionMarks {
  id: string;
  path: string;
  signals?: SessionSignals | null;
  workerSignals?: { stuck: number } | null;
  tags?: SessionTags | null;
  /** SessionSummary.turnError, pushed so the red mark appears and clears at once. */
  turnError?: { message?: string; provider?: string } | null;
}

/** WS /ws/watch?feed=sessions (see the route comment at the top of this block). */
export type SessionFeedMessage =
  /** `full: true` on connect, ALWAYS (even with zero sessions): every session with a mark (replace
      all overlays); then deltas. The client matches rows by `path` (= SessionSummary.path). */
  | { type: "marks"; full?: true; sessions: SessionMarks[] }
  | { type: "tags_backfill"; progress: TagsBackfillProgress }
  /** This host's session list changed beyond the marks (a path added or removed, or a change
      to live, busy/activity or lastActiveAt). No payload: the client refetches the list
      (coalesced). */
  | { type: "list_changed" }
  /** The logical LLM calls in flight on this host and every connected host: sent once on every
      connect, then on each change of the total or its coverage. Never a reason to re-read the
      list. */
  | { type: "llm_inflight"; inflight: LlmInflight }
  | { type: "error"; message: string };

/** Why an LlmInflight count is only a floor. `host` is the peer's id; absent = this host. */
export type LlmInflightGap =
  /** A Claude Code turn is running: the calls the CLI makes internally without reporting them
      can't be seen. */
  | { reason: "claude-internal"; host?: string }
  /** Processes that don't report a count (no counter loaded, a degraded counter, or a live record
      whose heartbeat went stale while its pid lives). */
  | { reason: "unreported"; host?: string; processes: number }
  /** A connected host whose count isn't here: still connecting, unreachable or refusing, or
      running a Sova too old to answer `/ws/watch?feed=llm`. */
  | { reason: "peer-connecting" | "peer-unreachable" | "peer-unsupported"; host: string };

/** Logical LLM calls in flight (server/llm-inflight.ts). */
export interface LlmInflight {
  /** Calls in flight that are seen: issued and not yet ended, failed or aborted. */
  count: number;
  /** Of `count`, calls timed by a process's spawn and exit (a one-shot `claude -p`). */
  approximate: number;
  /** `gaps.length > 0`: `count` is a floor, never shown as an exact number. */
  partial: boolean;
  gaps: LlmInflightGap[];
}

/** WS /ws/watch?feed=llm — one host's OWN count, for its peers' fan-in (server/llm-inflight.ts).
    `local` never includes a count this host was sent by another; its gaps carry no `host`.
    `instance` is per server process, so a host reached twice is counted once. A snapshot on
    connect, then one per change. */
export type LlmFeedMessage =
  | { type: "llm_local"; host: string; instance: string; local: LlmInflight }
  | { type: "error"; message: string };

// --- Git diffs (server/git-diff.ts, §chat.diff) ---------------------------------------------------
//
// Read-only. The client names WHAT to compare, never a ref: the server resolves every ref itself,
// and every folder must be one the named session already knows (its header cwd, its tracked
// worktrees, its merge cards' paths, its workers' cwds) — a path inside one of those is accepted,
// anything else is refused (400). `sessionPath` is SessionSummary.path.
//
// GET /api/diff/summary?<scope>                 -> 200 DiffSummary; 400 { error } (bad or unknown scope)
// GET /api/diff/patch?<scope>&file=<path>[&old=<oldPath>][&context=1]
//                                               -> 200 DiffFilePatch; 400 { error }; 404 { error } (not in the diff)
//    `context=1` adds `oldText`, the file's old side whole (for expanding folded context).
// <scope> as query parameters: kind=worktree&session=<sessionPath>&path=<worktreePath>
//                            | kind=commit&session=<sessionPath>&path=<repoPath>&sha=<hex sha>
//                            | kind=dirty&session=<sessionPath>&path=<cwd>
// (`diffScopeQuery` below builds it.) Both send Cache-Control: no-store. No route reads a file or a
// blob by a name the client gives: contents leave only as a file's patch and its own old side.

/** What a diff compares. */
export type DiffScope =
  /** A worktree's branch (committed HEAD) against its merge-base with its base branch (the tracked
      worktree's `baseBranch`, else master, else main, else origin/HEAD's target). */
  | { kind: "worktree"; sessionPath: string; worktreePath: string }
  /** One commit against its first parent (a root commit: against the empty tree). `sha` is hex,
      4–64 chars, resolved to a commit in that repository; a merge card's sha, typically. */
  | { kind: "commit"; sessionPath: string; repoPath: string; sha: string }
  /** What a merge card's merge brought in (§chat.changes/endpoint). `repoPath` and `sha` must be a
      merge card this session recorded (its `path` and full `sha`). A merge commit against its
      first parent; a fast-forward (the card's sha is the branch tip) against the tracked worktree's
      base when that is an ancestor of the tip and not the tip itself, else its first parent. */
  | { kind: "merge"; sessionPath: string; repoPath: string; sha: string }
  /** The repository containing `cwd`: index + working tree (untracked files as added) against HEAD. */
  | { kind: "dirty"; sessionPath: string; cwd: string };

/** The scope's query string (no leading `?`). */
export function diffScopeQuery(s: DiffScope): string {
  const q = new URLSearchParams({ kind: s.kind, session: s.sessionPath });
  if (s.kind === "worktree") q.set("path", s.worktreePath);
  else if (s.kind === "commit" || s.kind === "merge") {
    q.set("path", s.repoPath);
    q.set("sha", s.sha);
  } else q.set("path", s.cwd);
  return q.toString();
}

/** M modified, A added (untracked, in the dirty scope), D deleted, R renamed (maybe also edited),
    T type change (file ↔ symlink), B binary (any of those, on a binary file: no line counts). */
export type DiffFileStatus = "M" | "A" | "D" | "R" | "T" | "B";

export interface DiffFileSummary {
  /** Repository-relative, `/`-separated; the new path for a rename, the old one for a delete. */
  path: string;
  /** Renames only: the path before. */
  oldPath?: string;
  status: DiffFileStatus;
  added: number;
  removed: number;
  /** Full blob oids of each side; absent for the missing side (add/delete) and for a working-tree
      side git has not hashed (dirty scope). */
  oldOid?: string;
  newOid?: string;
  /** Dirty scope only: the file is not tracked (shown as added). */
  untracked?: true;
  /** Untracked only: too large to diff, or past the summary's read budget; `added` counts only the
      lines read (server/git-diff.ts MAX_UNTRACKED_READ, UNTRACKED_BUDGET), 0 when none were. */
  tooLarge?: true;
}

/** One side of a comparison, for the header. */
export interface DiffSide {
  /** "master (merge-base)", "a1b2c3d^1", "HEAD", "Working tree" … */
  label: string;
  /** The commit, when the side is one (never for the working tree, or an empty tree). */
  oid?: string;
}

export interface DiffSummary {
  scope: DiffScope;
  /** Repository top level the diff ran in. */
  repo: string;
  base: DiffSide;
  head: DiffSide;
  /** In git's order (path order), at most `MAX_DIFF_FILES` (server/git-diff.ts). */
  files: DiffFileSummary[];
  /** Over every file, including those cut by `truncated`. */
  totals: { files: number; added: number; removed: number };
  /** The file list stopped at the cap; `totals.files` is the real count. */
  truncated?: true;
  generatedAt: number;
}

/** One file's patch. `patch` is git's unified text for this file alone (from its `diff --git`
    header, `--histogram -M`, 3 lines of context, full-index oids), UTF-8 decoded. */
export interface DiffFilePatch {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  /** Present unless `binary` or `tooLarge`. An empty string is a mode-only change. */
  patch?: string;
  binary?: true;
  /** The patch passed the byte cap; `bytes` says how far it got. */
  tooLarge?: { bytes: number; cap: number };
  oldOid?: string;
  newOid?: string;
  /** With `context=1` only: the old side's whole text, the blob `oldOid` names. Absent when the
      patch has no single old side, or that side is binary or past 8 MB. */
  oldText?: string;
  /** As in the summary: a changed HEAD between the two requests shows up here. */
  base: DiffSide;
  head: DiffSide;
}

// ── Resource monitor (§app/resource-monitor) ─────────────────────────────────────────────────
// GET /api/monitor → MonitorSnapshot; GET /api/monitor/history?since=<ms>&res=5s|30s → MonitorHistory.
// Read-only. CPU percentages are of ONE core (100 = one core busy; a 16-core host tops out at 1600),
// averaged over the last tick (5s). Memory is RSS in bytes; swap is VmSwap in bytes.

/** How the measured set was chosen. `unit`: the server runs in a dedicated systemd service
    cgroup (/proc/self/cgroup ends in `.service`), so every process in it is measured, and the
    unit's own cgroup totals are reported. `tree`: the server's descendant tree only (dev,
    hermetic). `none`: no /proc (not Linux): only the server's own Node numbers. */
export type MonitorScope = "unit" | "tree" | "none";

/** How a process was charged to its session/worker, strongest first. Exact: `worker-pid` the
    runtime's in-process worker pid; `session-id` a `claude --resume/--session-id` uuid (a
    worker's session id, or a hosted session's Claude Code provider); `live-record` a pi
    worker's own live record; `team-env` a member-mcp helper's team env; `env` the
    PI_SESSION_FILE pi's bash tool puts in its child's environment (a hosted session's or a pi
    worker's tool child, and everything it started); `descendant` below a charged process;
    `sid` a session id (setsid group) already seen under a charged process (orphans, nohup,
    setsid). Heuristics, to be labelled as such: `exited-tools` CPU of the server's children
    that exited between two ticks, charged to the only hosted session running a tool then;
    `cwd` the process's cwd lies in exactly one hosted session's cwd. */
export type MonitorVia =
  | "worker-pid" | "session-id" | "live-record" | "team-env" | "env" | "descendant" | "sid"
  | "exited-tools" | "cwd";

/** Coarse kind of a process from its argv, parsed once per process. */
export type MonitorProcKind =
  | "server" | "pi-worker" | "claude-worker" | "claude-provider" | "member-mcp"
  | "node" | "java" | "python" | "browser" | "shell" | "build" | "other";

/** Linux pressure-stall `some avg10` (and `full avg10` where it exists), in percent. */
export interface MonitorPressure {
  cpu?: { some: number };
  memory?: { some: number; full: number };
  io?: { some: number; full: number };
}

export interface MonitorProc {
  pid: number;
  ppid: number;
  kind: MonitorProcKind;
  /** Short command, ≤ 120 chars: basename of argv[0] plus the telling args (`java … clojure.main`). */
  cmd: string;
  /** Own CPU% over the last tick, including reaped children's time (cutime/cstime). */
  cpuPct: number;
  rssBytes: number;
  /** Absent until first read (VmSwap is read at most every 30s per process). */
  swapBytes?: number;
  /** Epoch ms the process started. */
  startedAt: number;
  /** Where it was charged; absent = unattributed. */
  sessionPath?: string;
  workerId?: string;
  via?: MonitorVia;
  /** Escaped/unattributed only: the process's cwd, as a hint. */
  cwd?: string;
}

export interface MonitorWorker {
  /** The subagents worker id (e.g. "w3"), or a synthetic key for a worker seen only by argv. */
  id: string;
  name?: string;
  backend?: string;
  /** From the live record: "working" | "waiting" | "idle" | …, as that record says. */
  status?: string;
  /** Epoch ms the worker went idle, when the record says. */
  idleSince?: number;
  /** The worker's own process, when known. */
  pid?: number;
  via: MonitorVia;
  /** Whole subtree (the worker process and every descendant, plus reaped children's time). */
  cpuPct: number;
  rssBytes: number;
  swapBytes: number;
  procCount: number;
  /** The heaviest descendants (not the worker process itself), by CPU then RSS, at most 5. */
  top: MonitorProc[];
}

export interface MonitorSession {
  /** The session file; absent for a group the monitor could not tie to a file. */
  sessionPath?: string;
  /** Session display title, when known. */
  title?: string;
  cwd?: string;
  /** Hosted in this server (its tool children are the server's children). */
  hosted: boolean;
  /** Totals over the session's own processes and all its workers. */
  cpuPct: number;
  rssBytes: number;
  swapBytes: number;
  procCount: number;
  /** Processes charged to the session itself, not to a worker (hosted bash tools, the Claude
      Code provider process), heaviest first, at most 5; `own*` are their totals. */
  own: MonitorProc[];
  ownCpuPct: number;
  ownRssBytes: number;
  workers: MonitorWorker[];
}

/** Totals for a bucket of processes. For `escaped`, the totals cover only the processes no
    session was charged for (a charged one counts in its session), while `procs` lists all. */
export interface MonitorBucket {
  cpuPct: number;
  rssBytes: number;
  swapBytes: number;
  procCount: number;
  /** Heaviest first, at most 20. */
  procs: MonitorProc[];
}

export interface MonitorSampler {
  intervalMs: number;
  /** The last tick's own cost and the average over the last hour, in ms: the server thread's
      CPU time spent in the tick (wall time on Node < 23.9), waits excluded. */
  lastTickMs: number;
  avgTickMs: number;
  /** Ticks skipped because the previous one was still running. */
  skipped: number;
  ticks: number;
  startedAt: number;
}

export interface MonitorSnapshot {
  at: number;
  platform: string;
  scope: MonitorScope;
  /** `unit` only: the unit name, e.g. "sova-runtime.service". */
  unitName?: string;
  cores: number;
  host: {
    loadavg: [number, number, number];
    memTotalBytes: number;
    memAvailableBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
    pressure?: MonitorPressure;
  };
  /** `unit` only: the cgroup's own counters. `memory.current` includes page cache (`file`);
      `anon` is what pushes into swap. */
  unit?: {
    cpuPct: number;
    memory: { current: number; anon: number; file: number; shmem: number; peak?: number };
    swap: { current: number; peak?: number };
    oomKills: number;
    pressure?: MonitorPressure;
  };
  /** The server process itself (Node). `cpuPct` excludes its children. */
  server: {
    pid: number;
    cpuPct: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    /** Event-loop delay over the last tick, ms. */
    eventLoop: { p50: number; p99: number; max: number };
    uptimeSec: number;
  };
  /** Over every measured process (the unit's or the tree's), server included. */
  totals: { cpuPct: number; rssBytes: number; swapBytes: number; procCount: number };
  /** Heaviest first by CPU. Hosted sessions with no processes and no workers are omitted. */
  sessions: MonitorSession[];
  /** Workers the server runs whose session is unknown (no join matched). */
  unownedWorkers: MonitorWorker[];
  /** `unit` only: processes in the unit that are no longer under the server (reparented), each
      charged to a session when sid memory or cwd can say so. */
  escaped: MonitorBucket;
  /** Server descendants not charged to any session or worker (e.g. esbuild, git probes). */
  unattributed: MonitorBucket;
  /** The heaviest processes this tick by CPU, at most 10, across everything measured. */
  topProcs: MonitorProc[];
  sampler: MonitorSampler;
  /** Human notes on what this snapshot cannot see (no /proc, no unit, remote targets). */
  notes: string[];
}

export type MonitorResolution = "5s" | "30s";

/** One process in a history point: the tick's (5s) or the window's (30s) top CPU users. */
export interface MonitorPointProc {
  pid: number;
  cmd: string;
  kind: MonitorProcKind;
  cpuPct: number;
  rssBytes: number;
  /** Key into `MonitorHistory.groups`; absent = unattributed. */
  group?: string;
  workerId?: string;
}

/** One history point. At `30s` resolution `cpuPct` is the window's mean and `cpuPctMax` its
    highest tick; memory figures are the window's maximum. */
export interface MonitorPoint {
  at: number;
  cpuPct: number;
  cpuPctMax?: number;
  rssBytes: number;
  swapBytes: number;
  /** `unit` scope only. */
  anonBytes?: number;
  load1: number;
  /** Server event-loop max delay, ms. */
  loopMaxMs: number;
  /** Per group (session, "escaped", "unattributed", "server"): [cpuPct, rssBytes]. */
  groups: Record<string, [number, number]>;
  /** Per group, then per worker id: [cpuPct, rssBytes] of the worker's whole subtree. */
  workers: Record<string, Record<string, [number, number]>>;
  /** Top 5 by CPU. */
  top: MonitorPointProc[];
}

export interface MonitorHistory {
  res: MonitorResolution;
  /** Echo of the request's `since` (clamped to what is kept). */
  since: number;
  /** Oldest first. */
  points: MonitorPoint[];
  /** Labels for every group key used in `points`. Session groups are keyed by session path. */
  groups: Record<string, { label: string; sessionPath?: string }>;
  /** Worker names by group key, then worker id, for the workers in `points` that had one. */
  workerLabels?: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Voice input (§chat/voice, §app.settings-dialog/voice): server/voice/. GET /api/voice is the
// one status read, polled by the Settings → Voice tab and the composer's setup sheet.
// ---------------------------------------------------------------------------

/** Where the whisper.cpp binary runs: a GPU backend built from source, or the CPU. */
export type VoiceBackend = "vulkan" | "metal" | "cuda" | "cpu";

/** What the mic can do on this host right now. `ready` is the only state that records. */
export type VoiceState = "unsupported" | "not-installed" | "needs-packages" | "installing" | "failed" | "ready";

export type VoiceStepId = "detect" | "packages" | "source" | "build" | "model" | "selftest" | "finish";
export type VoiceStepState = "pending" | "running" | "done" | "skipped" | "failed";

export interface VoiceStep {
  id: VoiceStepId;
  state: VoiceStepState;
  /** A figure while it runs: bytes of a download, or a build's percent. */
  progress?: { done: number; total: number; unit: "bytes" | "percent" };
  /** One short fact about how it went ("Copied from …", "Prebuilt CPU binary"). */
  note?: string;
  error?: string;
}

export interface VoiceInstallJob {
  id: string;
  /** What this job asked for: the detected GPU backend, or the CPU. */
  mode: "gpu" | "cpu";
  /** The backend it is building for (set after detection). */
  backend?: VoiceBackend;
  repair: boolean;
  steps: VoiceStep[];
  startedAt: number;
  finishedAt?: number;
  /** How it ended: ok, stopped for packages, failed at a step, or cancelled. Absent while running. */
  outcome?: "ok" | "needs-packages" | "failed" | "cancelled";
}

export interface VoiceLogLine {
  seq: number;
  at: number;
  text: string;
}

export interface VoiceInstalled {
  backend: VoiceBackend;
  /** The GPU the self-test saw, when it used one ("AMD Radeon 8060S Graphics"). */
  device?: string;
  whisper: string;
  model: string;
  selftestMs: number;
  selftestText: string;
  installedAt: number;
}

export interface VoiceStatus {
  state: VoiceState;
  /** Why the host can't run voice at all (state "unsupported"). */
  reason?: string;
  platform: { os: string; arch: string; distro?: string; packageManager?: string };
  /** The backend a GPU setup would build for, from detection. */
  gpu: { backend: VoiceBackend; device?: string };
  /** A prebuilt CPU binary exists for this host: "Use CPU Instead" is offered. */
  cpuPrebuilt: boolean;
  /** state "needs-packages": what is missing and the one command that installs it (null: no known package manager). */
  missing?: { packages: string[]; command: string | null };
  /** The latest job this server ran (in memory; a restart forgets it, and the next job resumes). */
  install?: VoiceInstallJob;
  installed?: VoiceInstalled;
  runtime: { running: boolean; starting: boolean; lastMs?: number; crashedOut: boolean };
  model: { id: string; bytes: number };
  /** Log lines after the `since` the request asked for, oldest first, and the newest seq. */
  log: { seq: number; lines: VoiceLogLine[] };
  /** Bytes the voice folder holds, only when asked for (`?size=1`). */
  diskBytes?: number;
  /** Bytes free on the voice folder's disk, only when asked for (`?size=1`). */
  diskFree?: number;
  /** The catalog (§app.settings-dialog/voice-models), each entry with its state on this host. */
  models: VoiceModelState[];
  /** The model every device dictates with (one per host). `model` above names it too. */
  activeModel: string;
  /** The latest model download or switch this server ran (one at a time, under the setup lock). */
  modelJob?: VoiceModelJob;
  /** The device named by `?device=<id>` (§chat.voice/decoding); absent without one. */
  device?: VoiceThisDevice;
  /** Every device with a record on this host (it uploaded clips or has saved settings), for Forget. */
  devices: VoiceDeviceState[];
  /** `?device=<id>`'s calibration: its sentences, its kept clips and its run on the active model. */
  calibration?: VoiceCalibration;
  /** A sweep running on this host, whichever device it belongs to: a model switch waits for it. */
  sweep?: { device: string; deviceLabel: string; model: string };
}

/** What runs a catalog model: whisper.cpp's whisper-server, or transcribe.cpp (Parakeet). */
export type VoiceEngine = "whisper" | "transcribe";

export interface VoiceCatalogModel {
  id: string;
  /** "large-v3-turbo", "distil-large-v3.5", "parakeet-tdt-0.6b-v2". */
  label: string;
  /** "q5_0", "q8_0", "f16". */
  quant: string;
  /** The model file's size. */
  bytes: number;
  /** English only, or English and 98 more. */
  languages: "en" | "multi";
  engine: VoiceEngine;
  /** The default model: what setup installs. */
  recommended?: boolean;
  /** Bytes the engine itself needs on first use, when it isn't installed yet (transcribe.cpp). */
  engineBytes?: number;
}

export type VoiceModelStateName = "absent" | "downloading" | "verifying" | "needs-packages" | "ready" | "failed";

export interface VoiceModelState extends VoiceCatalogModel {
  state: VoiceModelStateName;
  /** The model this host dictates with. */
  active: boolean;
  /** Calibration can tune its decoding (whisper); false: it can only score it (no prompt, beam or VAD). */
  tunable: boolean;
  /** Download or hash progress, bytes. */
  progress?: { done: number; total: number };
  /** Why the last download or switch of this model failed. */
  error?: string;
  /** state "needs-packages" (Parakeet without a C compiler): what is missing and the one command that installs it. */
  missing?: { packages: string[]; command: string | null };
  /** The folder a verified copy was taken from instead of downloading ("~/.cache/…"). */
  importedFrom?: string;
  /** The last self-test on this model: its warm time and what it heard. */
  selftestMs?: number;
  selftestText?: string;
}

export interface VoiceModelJob {
  id: string;
  model: string;
  kind: "download" | "switch";
  /** Where it is: the engine (transcribe.cpp's first use), an import, the download, the hash, the self-test. */
  step: "engine" | "import" | "download" | "verify" | "selftest" | "switch";
  progress?: { done: number; total: number };
  startedAt: number;
  finishedAt?: number;
  /** Absent while running. */
  outcome?: "ok" | "failed" | "cancelled";
  error?: string;
}

/** Decoding settings for one device on one model (§chat.voice/decoding). Each is a per-request
    field of whisper-server's /inference, so devices never restart the server for each other. */
export interface VoiceDecodeSettings {
  /** 1: greedy. Above 1: beam search that wide (`beam_size`). */
  beamSize: number;
  /** The temperature fallback step (`temperature_inc`): 0.2 re-decodes a stuck segment warmer, 0 turns fallback off. */
  temperatureInc: number;
  /** The biasing prompt: none, the hotword list ("Sova, pi, …."), or one sentence using the same words. */
  prompt: "none" | "list" | "sentence";
  /** Silero voice detection before decoding (`vad`), with its threshold and padding. */
  vad: boolean;
  vadThreshold: number;
  vadSpeechPadMs: number;
}

/** The browser or installed app the user speaks into. The client makes the id once and keeps it. */
export interface VoiceDeviceInfo {
  id: string;
  /** "iPhone · Safari", "Linux · Chrome". */
  label: string;
  /** The installed home-screen app, not a browser tab. */
  app: boolean;
}

export interface VoiceCalibrationSummary {
  at: number;
  model: string;
  clips: number;
  /** Word error of the applied row and of the device's settings before the run, 0–1. */
  wer: number;
  baselineWer: number;
  jargonHits: number;
  jargonTotal: number;
  medianMs: number;
  /** The row applied (`VoiceCalibrationRow.key`). */
  key: string;
}

/** The requesting device, as GET /api/voice?device=<id> sees it. */
export interface VoiceThisDevice extends VoiceDeviceInfo {
  /** The host has a record of it (it calibrated, or chose settings). */
  known: boolean;
  /** What its dictation sends on the active model: its saved settings or the defaults. */
  settings: VoiceDecodeSettings;
  /** Defaults, a completed sweep's best row, or a results row the user chose. */
  source: "default" | "calibrated" | "chosen";
  /** A calibration's apply can be undone (Revert to Previous). */
  canRevert: boolean;
  calibration?: VoiceCalibrationSummary;
}

export interface VoiceDeviceState extends VoiceDeviceInfo {
  lastSeenAt: number;
  /** Model ids it has saved settings for. */
  calibrated: string[];
}

export interface VoiceCalibrationSentence {
  n: number;
  text: string;
  /** The ~35 s passage: recommended, not required. */
  long?: boolean;
  /** The no-jargon control sentence. */
  control?: boolean;
}

export interface VoiceCalibrationClip {
  n: number;
  sec: number;
  at: number;
}

export interface VoiceCalibrationRow {
  /** Stable id of the settings within a run ("p=list b=1 t=0.2 v=0"). */
  key: string;
  settings: VoiceDecodeSettings;
  /** Word errors over reference words, 0–1, over the clips scored so far. */
  wer: number;
  errors: number;
  words: number;
  /** Jargon words heard as written ("Sova" only capitalized) out of those in the references. */
  jargonHits: number;
  jargonTotal: number;
  medianMs: number;
  /** Clips scored for this row (a stopped run can leave a row short). */
  scored: number;
  /** The device's settings when the run started. */
  current: boolean;
  /** What the device dictates with now. */
  applied: boolean;
  clips: { n: number; heard: string; errors: number; ms: number }[];
}

export interface VoiceCalibrationRun {
  id: string;
  model: string;
  engine: VoiceEngine;
  /** full: the GPU grid; quick: the CPU grid; score: one pass, the model has nothing to tune. */
  grid: "full" | "quick" | "score";
  phase: "running" | "done" | "stopped" | "failed";
  progress: { setting: number; settings: number; clip: number; clips: number; done: number; total: number; etaSec?: number; pausedForDictation: boolean };
  /** Ranked best first: fewest word errors; within one word of the best, more jargon hits, then fewer errors, then faster. */
  rows: VoiceCalibrationRow[];
  best?: string;
  /** The row the run applied to the device when it ended (auto-apply), or one chosen later. */
  applied?: string;
  /** The load average was high at the start or the end: timings may be slow. */
  hostBusy?: boolean;
  /** How many settings were skipped because the voice-detection model couldn't be fetched. */
  vadSkipped?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** One device's calibration on this host: clips are kept under voice/calibration/<device id>/. */
export interface VoiceCalibration {
  sentences: VoiceCalibrationSentence[];
  clips: VoiceCalibrationClip[];
  /** Clips needed before a run. */
  minClips: number;
  /** Its run on the active model: the one running, or the last. */
  run?: VoiceCalibrationRun;
  /** The best row of its last completed run on every other model (Parakeet's score among them), to compare. */
  scores: VoiceModelScore[];
}

export interface VoiceModelScore {
  model: string;
  at: number;
  wer: number;
  errors: number;
  words: number;
  jargonHits: number;
  jargonTotal: number;
  medianMs: number;
}

export interface VoiceTranscript {
  text: string;
  /** whisper's own time for this clip, ms. */
  ms: number;
  audioSec: number;
}
