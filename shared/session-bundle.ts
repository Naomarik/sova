// Saved sessions (§chat/saved-sessions): a cleaned, portable copy of a chat kept on one fixed side branch
// of the project's repository, so a colleague can continue it on their own computer. This file is the wire
// contract between server/session-bundles*.ts and src/: the card written beside each saved transcript, the
// REST payloads under /api/saved-sessions, and the constants both sides need. It imports nothing and is
// pi-free; the harness half (export/import of a transcript) is HarnessBundles in shared/harness-history.ts.

// ---- The saved-sessions branch ----------------------------------------------------------------------

/** The one branch every project keeps its saved sessions on: an orphan branch that shares no history with
    the code, is never checked out by Sova and never merged into main. */
export const SAVED_SESSIONS_BRANCH = "sova/saved-sessions";
export const SAVED_SESSIONS_REF = `refs/heads/${SAVED_SESSIONS_BRANCH}`;

/** Where each saved session lives on that branch: `sessions/<bundleId>/` holding these files. */
export const SAVED_SESSIONS_DIR = "sessions";
export const SAVED_CARD_FILE = "session.json";
export const SAVED_TRANSCRIPT_FILE = "transcript.jsonl";
export const SAVED_README_FILE = "README.md";

/** The marker every card (and README) carries. Merge guards and main detection search history and trees
    for this string (git log -S / git grep), never only for a path, so a copy moved anywhere is still found.
    Spelled split on purpose: no file of a repository Sova merges may hold it literally, or the guard
    would stop that repository's own merges. */
export const SAVED_SESSION_MARKER: string = ["sova-saved-session", "v1"].join("/");

/** Path tokens written in place of this computer's paths; restored on continue. */
export const ROOT_TOKEN = "{{sova:root}}";
/** A worktree root of the saving session: `{{sova:worktree:<branch>}}`. */
export const worktreeToken = (branch: string) => `{{sova:worktree:${branch}}}`;

/** Size after cleaning: warn above, require a smaller choice (since last summary, or trimmed tool output) above. */
export const SAVE_WARN_BYTES = 10 * 1024 * 1024;
export const SAVE_LIMIT_BYTES = 50 * 1024 * 1024;

/** The custom message a continued conversation starts with (display: true): the agent's one-time note
    and the user's banner. Its `details` is a ContinuationDetails. */
export const CONTINUATION_NOTE_TYPE = "sova-saved-session-continued";

// ---- The card (session.json) -------------------------------------------------------------------------

export type SaveScope = "whole" | "since-summary";

/** One subagent or team member the saved conversation started, summarised mechanically at save time from
    Sova's own worker/team records (no model call), cleaned like the rest. Never resumable on the other side. */
export interface SavedWorkerSummary {
  kind: "subagent" | "team-member";
  /** The team's name, for a team member. */
  team?: string;
  /** Role or profile name ("backend", "explore"). */
  role: string;
  /** The task it was given, clipped. */
  task: string;
  /** How it ended: "done", "failed", "stopped", "running when saved", … as Sova recorded it. */
  outcome: string;
  /** Its final report, clipped; absent when it reported nothing. */
  report?: string;
}

export interface SavedBy {
  /** git config user.name (fallback: the OS user name). */
  name: string;
  email?: string;
}

export interface SavedCleaning {
  secretsRemoved: number;
  possibleKept: number;
  possibleRemoved: number;
  imagesKept: number;
  imagesRemoved: number;
  thinkingDropped: number;
  pathsRewritten: number;
  /** Absolute paths outside the roots and home, left as written. */
  absolutePathsLeft: number;
  /** Tool results clipped by "trim long tool output". */
  toolOutputsTrimmed: number;
}

export interface SavedSessionCard {
  /** SAVED_SESSION_MARKER. */
  format: string;
  bundleId: string;
  /** 1 on the first save; each save again of the same saved session is rev + 1. */
  rev: number;
  title: string;
  note?: string;
  savedBy: SavedBy;
  /** ISO time of this rev. */
  savedAt: string;
  /** Earlier revs, newest first (who and when only). */
  previous?: { rev: number; savedBy: SavedBy; savedAt: string }[];
  /** The code branches this saved session belongs to (one or more). */
  branches: string[];
  /** HEAD of the saving folder when saved. */
  commit?: string;
  harness: { name: string; sessionVersion: number };
  model?: { provider: string; id: string };
  thinking?: string;
  scope: SaveScope;
  includes: { images: boolean; thinking: boolean; trimmedToolOutput: boolean };
  counts: { entries: number; messages: number };
  /** Bytes of transcript.jsonl as committed. */
  bytes: number;
  /** Rough context size of the conversation as the model would see it (since its last summary). */
  approxTokens: number;
  /** Tokens used in the transcript in place of paths: ROOT_TOKEN and each worktreeToken(branch). */
  roots: { token: string; branch?: string }[];
  cleaning: SavedCleaning;
  workers: SavedWorkerSummary[];
}

// ---- Lineage (a session's own record of what it saved or continued from) ----------------------------

/** Written as session state (a StateKind, newest-on-branch) when a session saves or continues a saved
    session; a later save of that session updates the same bundleId to rev + 1. */
export interface SavedLineage {
  bundleId: string;
  rev: number;
  /** "saved": this session wrote that rev. "continued": this session started from it. */
  how: "saved" | "continued";
  at: string;
  pushed?: boolean;
  /** The saved session's title at that rev, for the Saved list (read without git). */
  title?: string;
}

/** `details` of the CONTINUATION_NOTE_TYPE message. */
export interface ContinuationDetails {
  bundleId: string;
  rev: number;
  title: string;
  savedBy: SavedBy;
  savedAt: string;
  note?: string;
  workers: SavedWorkerSummary[];
  /** Set when the history was too big for the model: the conversation starts from its last summary. */
  fromSummary?: boolean;
  model: ContinueModel;
}

// ---- REST: saving (all under /api/saved-sessions) ---------------------------------------------------

/** POST /api/saved-sessions/prepare { path } -> SavePrepareResponse.
    Builds the cleaned copy (without writing anything) and caches it under prepareId for the save. */
export interface SavePrepareRequest {
  /** The session file path, as the session pane knows it. */
  path: string;
}

/** Something cleaning found that the saver must keep or remove before Save is enabled. */
export interface SaveReviewItem {
  id: string;
  kind: "possible-secret" | "image";
  /** Where it was found: "You", "Agent", "bash result", "read result", … and the entry's time. */
  where: string;
  at?: string;
  /** For a possible secret: the surrounding text with the match marked as [[…]]; never the whole value
      when it is long. For an image: empty. */
  excerpt: string;
  /** Why it was flagged ("looks like an API key", "high-entropy string", "value from .env.local"). */
  why?: string;
  /** For an image: GET /api/saved-sessions/prepare/:prepareId/image/:id serves it. */
  mimeType?: string;
  bytes: number;
}

export interface SavePrepareResponse {
  prepareId: string;
  /** Prefilled from the session title. */
  title: string;
  /** Prefilled: the worktrees this session created/attached, else its folder's branch. */
  branches: string[];
  /** Every local branch of the repository, for the branches picker. */
  knownBranches: string[];
  /** Bytes after cleaning, per choice; `sinceSummary` is null when the session has no summary yet. */
  sizes: {
    whole: number;
    wholeTrimmed: number;
    sinceSummary: number | null;
    sinceSummaryTrimmed: number | null;
  };
  /** Counts of what cleaning did automatically (secretsRemoved, thinkingDropped, paths…). */
  cleaning: SavedCleaning;
  review: SaveReviewItem[];
  /** Saving again: the saved session this one updates, when the session has saved or continued one. */
  lineage: {
    bundleId: string;
    rev: number;
    title: string;
    /** From the card at the branch tip, so Save Again keeps what the last version said. */
    note?: string;
    branches: string[];
  } | null;
  push: {
    /** The remote a push goes to; null when the repository has none (the checkbox is disabled). */
    remote: { name: string; url: string } | null;
    /** The project's remembered choice (off by default). */
    remembered: boolean;
    /** True once the user has accepted the may-be-public warning for this remote. */
    publicWarningAccepted: boolean;
  };
  workers: SavedWorkerSummary[];
}

/** POST /api/saved-sessions/save -> SaveResponse. */
export interface SaveRequest {
  path: string;
  prepareId: string;
  title: string;
  note?: string;
  branches: string[];
  scope: SaveScope;
  trimToolOutput: boolean;
  includeImages: boolean;
  /** One decision per SaveReviewItem id; the server refuses (reason "undecided") if any is missing.
      Images are decided here too; includeImages=false removes every image. */
  decisions: Record<string, "keep" | "remove">;
  push: boolean;
  /** Required once with push=true for a remote whose warning wasn't accepted yet. */
  acceptPublicWarning?: boolean;
  /** The answer to a "conflict" refusal. */
  onConflict?: "new-copy" | "replace";
}

export type SaveRefusal =
  | "undecided" // a review item has no decision
  | "too-big" // over SAVE_LIMIT_BYTES with the chosen scope
  | "conflict" // the branch tip has a newer rev of this saved session from someone else
  | "public-warning" // push=true and the remote's warning wasn't accepted
  | "expired" // prepareId unknown (server restarted or > 30 min)
  | "not-a-repo"
  | "invalid"
  | "internal";

export type SaveResponse =
  | {
      ok: true;
      card: SavedSessionCard;
      /** The saved-sessions commit written locally. */
      commit: string;
      pushed: boolean;
      /** Set when push was asked but failed after retries; the save itself stands. */
      pushError?: string;
    }
  | {
      ok: false;
      reason: SaveRefusal;
      message: string;
      /** For "conflict": the newer rev on the branch. */
      theirs?: { rev: number; savedBy: SavedBy; savedAt: string };
    };

/** GET /api/saved-sessions/for-session?path= -> SavedForSessionResponse: the Sharing tab's Saved list. */
export interface SavedForSessionEntry {
  bundleId: string;
  rev: number;
  title: string;
  savedAt: string;
  how: "saved" | "continued";
  pushed: boolean;
}
export interface SavedForSessionResponse {
  /** Whether the session's folder is inside a git repository (Save Session is disabled otherwise). */
  repo: boolean;
  saved: SavedForSessionEntry[];
}

// ---- REST: discovery on the new-session screen ------------------------------------------------------

/** One row of the Saved sessions section. */
export interface SavedSessionRow {
  bundleId: string;
  rev: number;
  title: string;
  savedBy: SavedBy;
  savedAt: string;
  branches: string[];
  bytes: number;
  approxTokens: number;
  messages: number;
  /** From the seen store (bundleId -> rev): never seen = "new", seen an older rev = "updated". */
  badge: "new" | "updated" | null;
  /** Set when the card or transcript can't be read; the row shows "Can't be read" and no Continue. */
  unreadable?: string;
}

/** GET /api/saved-sessions?cwd= -> SavedListResponse. Reads the newer of the local branch and its
    remote-tracking ref; never fetches. */
export interface SavedListResponse {
  /** False when the folder is not in a git repository (the section isn't shown). */
  repo: boolean;
  /** The folder's current branch (not a filter by default). */
  folderBranch: string | null;
  /** Every branch named by any row, sorted, for the filter dropdown. */
  branches: string[];
  /** Branches named by rows that git finds merged into the main branch: the screen offers to delete
      their saved sessions or keep them (§chat.saved-sessions/prune). */
  mergedBranches: string[];
  /** Newest first. */
  sessions: SavedSessionRow[];
  /** Whether the repository has a remote to Get from (the button is shown only then). */
  hasRemote: boolean;
  /** That remote's name ("origin"), null when there is none. */
  remote: string | null;
  /** The project's remembered push choice: a prune pushes its commit only when this is on. */
  pushOnSave: boolean;
  /** When the remote's saved-sessions ref was last fetched by Sova, if ever. */
  fetchedAt?: string;
}

/** POST /api/saved-sessions/fetch { cwd } -> SavedFetchResponse: fetches ONLY the saved-sessions ref, then
    lists. The one fetch Sova does on request (the other is inside a pushed save). */
export type SavedFetchResponse =
  | ({ ok: true } & SavedListResponse)
  | { ok: false; reason: "offline" | "no-remote" | "auth" | "no-saved-branch" | "internal"; message: string };

/** GET /api/saved-sessions/preview?cwd=&bundleId= -> SavedPreviewResponse. Read only; marks the rev seen. */
export interface SavedPreviewMessage {
  role: "user" | "assistant";
  text: string;
  at?: string;
}
export interface ContinueModel {
  provider: string;
  id: string;
  /** False when the saved model can't run here and this is the user's default instead. */
  saved: boolean;
  /** The saved model ("<provider>/<id>"), set when saved=false, so the notice can name it. */
  savedId?: string;
  /** Why it fell back, for the notice ("No zai key on this computer."); only the cause, never a restatement
      that the model isn't available. Absent when there is nothing more to say. */
  reason?: string;
}
export interface SavedPreviewResponse {
  card: SavedSessionCard;
  /** The last few messages, oldest first, text only. */
  lastMessages: SavedPreviewMessage[];
  /** The model Continue would use. */
  model: ContinueModel;
  /** Set when the history is bigger than that model's window: Continue starts from the last summary. */
  wontFit?: { approxTokens: number; window: number; hasSummary: boolean };
}

// ---- REST: continuing ---------------------------------------------------------------------------------

/** POST /api/saved-sessions/continue -> ContinueResponse. Loads the saved conversation INTO the blank,
    unprompted session at `path`; never switches the folder's branch; the user's mode and sandbox stay. */
export interface ContinueRequest {
  /** The blank session on screen. */
  path: string;
  cwd: string;
  bundleId: string;
  rev: number;
}

/** A branch the saved session worked on, offered as a worktree. */
export interface WorktreeOfferItem {
  branch: string;
  /** "local": the branch exists here (worktree add). "remote": only <remote>/<branch> (worktree add -b).
      "here": it is the folder's own branch (nothing to set up). "missing": nowhere (can't be offered). */
  where: "local" | "remote" | "here" | "missing";
  remoteRef?: string;
  /** Set when a worktree on that branch already exists. */
  existingPath?: string;
}

export type ContinueResponse =
  | {
      ok: true;
      model: ContinueModel;
      fromSummary: boolean;
      worktreeOffer: WorktreeOfferItem[];
    }
  | { ok: false; reason: "not-blank" | "not-found" | "invalid" | "too-big" | "internal"; message: string };

/** POST /api/saved-sessions/worktrees { path, branches } -> WorktreesResponse: sets up the offered worktrees
    and tells the agent where they are (one note in the session). */
export interface WorktreesRequest {
  path: string;
  branches: string[];
}
export interface WorktreesResponse {
  created: { branch: string; path: string }[];
  failed: { branch: string; message: string }[];
}

// ---- REST: on main, and after a merge -----------------------------------------------------------------

/** A saved session found where it must not be. */
export interface SavedOnMainItem {
  /** Folder in main's tree that holds the card (for a historyOnly item: where it was). */
  dir: string;
  /** Not in main's tree, only in its unpushed history (added and later deleted): nothing to Remove from
      Main; Purge from History applies. */
  historyOnly?: boolean;
  bundleId?: string;
  title?: string;
}

/** GET /api/saved-sessions/on-main?cwd= -> SavedOnMainResponse. */
export interface SavedOnMainResponse {
  mainBranch: string | null;
  found: SavedOnMainItem[];
  /** The commits on main that added them are all unpushed: Purge from history is offered. */
  purgeable: boolean;
  /** Set when purgeable: how many unpushed commits the rewrite rebuilds, and the backup branch it creates first. */
  purge?: { commits: number; backupBranch: string };
}

/** POST /api/saved-sessions/remove-from-main { cwd, dirs } -> one commit deleting only those folders. */
export interface RemoveFromMainRequest {
  cwd: string;
  dirs: string[];
}
export type RemoveFromMainResponse = { ok: true; commit: string } | { ok: false; reason: "dirty" | "not-found" | "internal"; message: string };

/** POST /api/saved-sessions/purge-from-main { cwd, dirs } -> rewrites only unpushed commits, backup first. */
export type PurgeFromMainResponse =
  | { ok: true; backupBranch: string; head: string }
  | { ok: false; reason: "pushed" | "dirty" | "not-found" | "internal"; message: string };

/** POST /api/saved-sessions/prune { cwd, branch } -> deletes that branch's saved sessions from the
    saved-sessions branch (a normal commit; pushed only if the project's push choice is on). Offered after
    the branch merged. A saved session that also belongs to other branches only loses that branch. */
export type PruneResponse = { ok: true; removed: number; commit: string | null } | { ok: false; reason: string; message: string };

/** What Sova's merges (worktree merge, Merge Branch, merge round) report when the history being merged
    carries saved-session cards; the merge stops unless the caller passes the override.
    On the wire a refusal body carries it as `savedSessions` beside its usual error text (Merge Branch:
    409 { error, savedSessions }), and the caller retries with `allowSavedSessions: true`. */
export interface SavedSessionsInHistory {
  commits: { sha: string; subject: string; paths: string[] }[];
}
