import type {
  AgentsInsight,
  ChatModeResult,
  ContextInfo,
  ExplanationInfo,
  FolderListing,
  ModeInfo,
  ModelInfo,
  SessionGroup,
  SessionInsight,
  SessionSummary,
  SubagentModelPolicy,
  TranscriptItem,
  UploadResult,
  UsageInsight,
} from "../../shared/protocol";
import { type CleanupRequest, type CleanupResult, parseCleanupResult } from "./archive";
import type { TargetInfo } from "./remote-session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("The pi-web server isn't reachable.", 0);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export const listSessions = () => request<SessionSummary[]>("/api/sessions");

export const listCwds = () => request<string[]>("/api/cwds");

/** Subfolders of `path` (no path: $HOME). `hidden` includes dot folders. */
export const listFolders = (path?: string, hidden = false) => {
  const q = new URLSearchParams();
  if (path) q.set("path", path);
  if (hidden) q.set("hidden", "1");
  const qs = q.toString();
  return request<FolderListing>(`/api/folders${qs ? `?${qs}` : ""}`);
};

export const listModels = () => request<ModelInfo[]>("/api/models");

/** Which models and providers are blocked from being spawned as subagents or team members. */
export const getSubagentPolicy = () => request<SubagentModelPolicy>("/api/settings/subagents");

/** Replace the subagent model policy (whole object). Applies to the next spawn, everywhere. */
export const putSubagentPolicy = (policy: SubagentModelPolicy) =>
  request<SubagentModelPolicy>("/api/settings/subagents", { method: "PUT", body: JSON.stringify(policy) });

/** The session cwd's file index for @-mentions: every non-ignored file under it, relative to
    it, capped (truncated flags the cap). Cached both sides; the menu refetches when stale. */
export const fetchFileIndex = (cwd: string) =>
  request<FileIndex>(`/api/files?cwd=${encodeURIComponent(cwd)}`);

/** The default for new sessions, and what exists (GET /api/mode). */
export const getMode = () => request<ModeInfo>("/api/mode");

/**
 * Switch one chat's mode (`path` = its session file): only that chat follows, from its next
 * message, and the reply says how (ChatModeResult.applies). Without `path` this writes the
 * default for new sessions instead and changes no open chat.
 */
export const postMode = (patch: { mode?: string; minorModes?: string[] }, path?: string) =>
  request<ModeInfo | ChatModeResult>(`/api/mode${path ? `?path=${encodeURIComponent(path)}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

/** A local folder (string), or a folder on a configured target. */
export const createSession = (where: string | { target: string; remoteCwd: string }) =>
  request<SessionSummary>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(typeof where === "string" ? { cwd: where } : { target: where.target, remoteCwd: where.remoteCwd }),
  });

export const fetchTargets = () => request<TargetInfo[]>("/api/targets");

/** How long the UI waits on a target's folder listing before saying so (the server bounds its own probe too). */
export const REMOTE_LIST_TIMEOUT_MS = 20_000;

/**
 * Subfolders of `path` on a target (no path: the server's default, the target's cwd or $HOME).
 * Read leniently: the server may send the local FolderListing shape or `{path, dirs}`.
 */
export async function fetchTargetFolders(target: string, path?: string, hidden = false): Promise<FolderListing> {
  const q = new URLSearchParams();
  if (path) q.set("path", path);
  if (hidden) q.set("hidden", "1");
  const qs = q.toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REMOTE_LIST_TIMEOUT_MS);
  try {
    const raw = await request<Partial<FolderListing> & { dirs?: string[] }>(
      `/api/targets/${encodeURIComponent(target)}/folders${qs ? `?${qs}` : ""}`,
      { signal: ctrl.signal },
    );
    const at = raw.path ?? path ?? "/";
    const join = (name: string) => (at === "/" ? `/${name}` : `${at.replace(/\/+$/, "")}/${name}`);
    const entries = raw.entries ?? (raw.dirs ?? []).map((name) => ({ name, path: join(name) }));
    const parent = raw.parent !== undefined ? raw.parent : at === "/" ? null : at.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
    return { path: at, parent, entries, truncated: !!raw.truncated };
  } catch (err) {
    if (ctrl.signal.aborted) throw new ApiError(`No answer within ${REMOTE_LIST_TIMEOUT_MS / 1000}s.`, 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Spawns the connection agent: a seeded session that probes, verifies and writes a new target. */
export const connectTarget = () =>
  request<SessionSummary>("/api/sessions/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

/** Moves a web-spawned session to the Archive region (true) or back to the top (false). */
export const setSessionArchived = (path: string, archived: boolean) =>
  request<SessionSummary>("/api/sessions/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, archived }),
  });

/** The sidebar's user-made groups, in creation order (spec/02-session-list.md §2 "Groups"). */
export const listSessionGroups = () => request<SessionGroup[]>("/api/session-groups");

export const createSessionGroup = (name: string) =>
  request<SessionGroup>("/api/session-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

export const renameSessionGroup = (id: string, name: string) =>
  request<SessionGroup>(`/api/session-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

/** Deletes the group and its assignments; the sessions themselves are untouched. */
export const deleteSessionGroup = (id: string) =>
  request<{ ok: true }>(`/api/session-groups/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Puts one session in a group, or takes it out of the one it's in (`null`). */
export const assignSessionGroup = (path: string, groupId: string | null) =>
  request<{ ok: true }>("/api/session-groups/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, groupId }),
  });

/** POST /api/sessions/cleanup `{ mode:"paths" }`: named session paths, e.g. one archived row. */
export type PathsCleanupRequest = { mode: "paths"; paths: string[] };

/** One cleanup response, read leniently (`parseCleanupResult`), plus what paths mode refused. */
export interface CleanupResponse extends CleanupResult {
  /** paths mode: one entry per refused path with its reason; null when none, or not sent. */
  refused: { path: string; reason: string }[] | null;
}

/** Reads the paths mode's refusal list leniently; anything else reads as null. */
const refusedEntries = (raw: unknown): CleanupResponse["refused"] => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const list = (raw as Record<string, unknown>).refused;
  if (!Array.isArray(list)) return null;
  const out: { path: string; reason: string }[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.path === "string" && typeof o.reason === "string") out.push({ path: o.path, reason: o.reason });
  }
  return out;
};

/**
 * Deletes archive sessions by age or empty "husks" (spec/02-session-list.md §2 "Archive cleanup"), or
 * the named, ARCHIVED sessions of `paths` mode. With `dryRun` nothing is deleted and the result says
 * what would be. Read leniently: the server may send fewer fields.
 */
export const cleanupSessions = (req: CleanupRequest | PathsCleanupRequest, dryRun: boolean): Promise<CleanupResponse> =>
  request<unknown>("/api/sessions/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...req, dryRun }),
  }).then((raw) => ({ ...parseCleanupResult(raw), refused: refusedEntries(raw) }));

export const fetchTranscript = (path: string) =>
  request<{ items: TranscriptItem[] }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => r.items);

/** The transcript plus its context-window fill (null when unknown or stale). */
export const fetchTranscriptWithContext = (path: string) =>
  request<{ items: TranscriptItem[]; context: ContextInfo | null }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => ({
    items: r.items,
    context: r.context ?? null,
  }));

/** The composer draft stored for a session; `text: null` when there is none. The server has
    already dropped attachments whose file is gone. */
export const fetchDraft = (path: string) =>
  request<{ text: string | null; attachments?: UploadResult[]; updatedAt: string | null }>(
    `/api/sessions/draft?path=${encodeURIComponent(path)}`,
    { cache: "no-store" },
  ).then((r) => ({ text: r.text, attachments: r.attachments ?? [], updatedAt: r.updatedAt }));

/** Stores a session's draft; blank text with no attachments deletes it. `keepalive` lets the
    write outlive a page that is being hidden or closed. */
export const putDraft = (path: string, text: string, attachments: UploadResult[], opts: { keepalive?: boolean } = {}) =>
  request<{ ok: true }>("/api/sessions/draft", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, text, attachments }),
    keepalive: opts.keepalive,
  });

/** Stores an image in the session's attachments folder the moment it's attached, so it survives
    a reload as part of the draft; the prompt text then names its path. */
export const uploadImage = (file: File, sessionPath: string) =>
  request<UploadResult>(`/api/upload?draft=${encodeURIComponent(sessionPath)}`, {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });

/** Deletes a draft attachment the user removed. Only files in the attachments folder qualify. */
export const deleteAttachment = (path: string) =>
  request<{ ok: true }>(`/api/attachment?path=${encodeURIComponent(path)}`, { method: "DELETE" });

export const fetchUsage =() => request<UsageInsight>("/api/insights/usage");

export const fetchAgents = () => request<AgentsInsight>("/api/insights/agents");

/** Every /explain artifact in the store, newest first (they're kept forever). */
export const fetchExplanations = () => request<ExplanationInfo[]>("/api/explanations");

export const fetchSessionInsight = (path: string) =>
  request<SessionInsight>(`/api/insights/session?path=${encodeURIComponent(path)}`);

/**
 * `force` (chat only) lets the server open a session whose file was written recently by
 * something that isn't a TUI. It never overrides a live TUI.
 */
export function wsUrl(endpoint: "/ws/chat" | "/ws/watch", path: string, force = false): string {
  return `${wsOrigin()}${endpoint}?path=${encodeURIComponent(path)}${force ? "&force=1" : ""}`;
}

function wsOrigin(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
}

/**
 * Read-only tail of a claude-code worker's own Claude Code session (`/ws/watch?claude=<uuid>`).
 * These workers write no pi session file; the server finds theirs under ~/.claude/projects and
 * sends the same WatchServerMessages.
 */
export function claudeWatchUrl(sessionId: string): string {
  return `${wsOrigin()}/ws/watch?claude=${encodeURIComponent(sessionId)}`;
}

/**
 * The server refuses chat (code "recent") on a file an unknown process wrote within this window
 * (RECENT_WRITE_MS in server/write-guard.ts). The server decides; this is for reference/copy.
 */
export const RECENT_WRITE_WINDOW_MS = 120_000;
