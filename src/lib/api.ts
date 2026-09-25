import type {
  AgentsInsight,
  ChatModeResult,
  ClaudeCliStatus,
  ContextInfo,
  ExtensionInfo,
  ExplanationInfo,
  FileIndex,
  FolderListing,
  GitSummary,
  ModeInfo,
  ModelFavoriteResult,
  ModelInfo,
  PlaybookCatalog,
  SandboxApplyResult,
  AssignGroupResult,
  BatchPromptResult,
  BatchRefusal,
  FanoutConflict,
  FanoutRequest,
  FanoutResult,
  SessionGroup,
  SessionInsight,
  SessionSetup,
  SessionSummary,
  ThemeList,
  TmpAttachment,
  TranscriptItem,
  UploadResult,
  UsageInsight,
  WebSettings,
  WorkerResumeResult,
  FrontDoorConfig,
  MeshCandidate,
  MeshHello,
  MeshInfo,
  MeshPeerEntry,
  MeshSessions,
  MeshSettings,
} from "../../shared/protocol";
import { type CleanupRequest, type CleanupResult, parseCleanupResult } from "./archive";
import type { ModelPolicy } from "./model-policy";
import type {
  DelegateOptions,
  DelegateSaveResult,
  DelegateSettings,
  DelegateSettingsInfo,
  SpecSaveResult,
  SpecSettings,
  SpecSettingsInfo,
  SummarizerSettings,
  SummarizerSettingsInfo,
} from "../../shared/protocol";
import type { TargetInfo } from "./remote-session";
import { hostOf, hostUrl, noteHost, peerBase, routeUrl } from "./mesh";

/**
 * What a batch send can come back as. The refusal is a VALUE, not a throw: it is the route's
 * specified answer to "one of these members can't take a message", and the banner it drives is
 * the whole point of the pre-check.
 */
export type BatchOutcome =
  | { ok: true; result: BatchPromptResult }
  | { ok: false; refused: BatchRefusal[]; error?: undefined; status?: undefined }
  /** `status` so a caller can tell "the group changed under me" (400) from "the server is gone"
      (0) — the first is recoverable by re-reading the list, the second isn't. */
  | { ok: false; error: string; status: number; refused?: undefined };

/** What a fanout can come back as; the 409 is the route's answer, not an exception. */
export type FanoutOutcome =
  | { ok: true; result: FanoutResult }
  | { ok: false; refused: BatchRefusal[]; error?: undefined; status?: undefined; conflict?: undefined }
  /** `conflict` is the route's one coded 400 (`seed-conflict`): the client renders its own
      sentence from the code, and `error` stays the fallback for every other 400. */
  | { ok: false; error: string; status: number; refused?: undefined; conflict?: FanoutConflict["code"] };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed error body, when there was one. A route whose refusal is part of its contract
        (the batch prompt's 409) carries its detail here rather than only in the message. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // A request about a peer's session goes to that peer, through this host (lib/mesh.ts).
    res = await fetch(routeUrl(url, init?.body), init);
  } catch {
    throw new ApiError("The Sova server isn't reachable.", 0);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let parsed: unknown;
    try {
      parsed = await res.json();
      const body = parsed as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new ApiError(message, res.status, parsed);
  }
  return (await res.json()) as T;
}

export const listSessions = () => request<SessionSummary[]>("/api/sessions");

/** `host`: a peer's, for New Session's Host field; left out, this host's. */
export const listCwds = (host?: string | null) => request<string[]>(hostUrl(host, "/api/cwds"));

/** Subfolders of `path` (no path: $HOME). `hidden` includes dot folders. `host`: on that peer. */
export const listFolders = (path?: string, hidden = false, host?: string | null) => {
  const q = new URLSearchParams();
  if (path) q.set("path", path);
  if (hidden) q.set("hidden", "1");
  const qs = q.toString();
  return request<FolderListing>(hostUrl(host, `/api/folders${qs ? `?${qs}` : ""}`));
};

/** `host`: a peer's models, which its own keys and policy decide; left out, this host's. */
export const listModels = (host?: string | null) => request<ModelInfo[]>(hostUrl(host, "/api/models"));

/** Star or unstar one model in the command-palette's favorites file, shared with the TUI. */
export const putModelFavorite = (ref: string, favorite: boolean, host?: string | null) =>
  request<ModelFavoriteResult>(hostUrl(host, "/api/models/favorite"), { method: "PUT", body: JSON.stringify({ ref, favorite }) });

/** The unified model policy: what may be used at all, and what subagents may additionally use
    (Settings → Models). Both halves apply everywhere — this browser, the TUI, and workers. */
export const getModelPolicy = (host?: string | null) => request<ModelPolicy>(hostUrl(host, "/api/settings/models"));

/** Replace the whole policy. It takes effect on the next model change, turn and spawn, everywhere;
    the server refuses a model it forbids, so this is a rule, not a filter. */
export const putModelPolicy = (policy: ModelPolicy) =>
  request<ModelPolicy>("/api/settings/models", { method: "PUT", body: JSON.stringify(policy) });

/** Delegate mode's routing (Settings → Modes → Delegate): which worker each kind of work goes to. */
export const getDelegateSettings = () => request<DelegateSettingsInfo>("/api/settings/delegate");

/** What each worker backend offers. Slow the first time (it asks the Claude Code CLI; cached 60s);
    a backend that can't answer comes back with `models: null`, which is not "offers nothing". */
export const getDelegateOptions = () => request<DelegateOptions>("/api/settings/delegate/options");

/** Replace the whole routing. Delegate sessions everywhere pick it up at their next turn. */
export const putDelegateSettings = (settings: DelegateSettings) =>
  request<DelegateSaveResult>("/api/settings/delegate", { method: "PUT", body: JSON.stringify(settings) });

/** The spec writer (Settings → Modes → Spec): which worker writes draft claims and evidence while spec is on. */
export const getSpecSettings = () => request<SpecSettingsInfo>("/api/settings/spec");

/** What each worker backend offers for the writer: the same discovery as Delegate's. */
export const getSpecOptions = () => request<DelegateOptions>("/api/settings/spec/options");

/** Replace the writer (`writer: null` = none). Sessions with spec on pick it up at their next turn. */
export const putSpecSettings = (settings: SpecSettings) =>
  request<SpecSaveResult>("/api/settings/spec", { method: "PUT", body: JSON.stringify(settings) });

/** Which model writes the summary line (the topic-outline extension's file; missing → its defaults). */
export const getSummarizerSettings = () => request<SummarizerSettingsInfo>("/api/settings/summarizer");

/** Replace the chain; the file's other keys stay. Sessions started afterwards, here and in the TUI, use it. */
export const putSummarizerSettings = (settings: SummarizerSettings) =>
  request<SummarizerSettingsInfo>("/api/settings/summarizer", { method: "PUT", body: JSON.stringify(settings) });

/** Every theme the app can find — the ones it ships and the ones in the user's folder — rescanned
    per request. Never fails on an unreadable folder: that comes back as `error` with the built-ins
    still listed. */
export const getThemes = () => request<ThemeList>("/api/themes");

/** Sova's own settings (GET /api/settings). Today: the experimental Claude Code switch. */
export const getWebSettings = () => request<WebSettings>("/api/settings");

/** Replace Sova's settings. Applies to sessions created after the change, not to open ones. */
export const putWebSettings = (settings: WebSettings) =>
  request<WebSettings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) });

/** Whether the Claude Code CLI is usable, for the Experimental tab's status line. */
export const getClaudeCliStatus = () => request<ClaudeCliStatus>("/api/settings/claude-status");

/** The session cwd's file index for @-mentions: every non-ignored file under it, relative to
    it, capped (truncated flags the cap). Cached both sides; the menu refetches when stale. */
export const fetchFileIndex = (cwd: string, host?: string | null) =>
  request<FileIndex>(hostUrl(host, `/api/files?cwd=${encodeURIComponent(cwd)}`));

/** The Playbooks dialog's catalog: shipped, the user's, and (given a local cwd) the project's.
    Never an error for a cwd it can't list — `project.state` says why instead. */
export const fetchPlaybooks = (cwd: string | null, host?: string | null) =>
  request<PlaybookCatalog>(hostUrl(host, cwd ? `/api/playbooks?cwd=${encodeURIComponent(cwd)}` : "/api/playbooks"));

/** The default for new sessions, and what exists (GET /api/mode). */
export const getMode = (host?: string | null) => request<ModeInfo>(hostUrl(host, "/api/mode"));

/**
 * POST /api/mode with a patch. With `path` (a session file) it switches that one chat: only it
 * follows, from its next message, the reply says how (ChatModeResult.applies), and mode.json is not
 * written. Without `path` this writes the default for new sessions instead and changes no open chat.
 */
export const postMode = (patch: { mode?: string; minorModes?: string[] }, path?: string) =>
  request<ModeInfo | ChatModeResult>(`/api/mode${path ? `?path=${encodeURIComponent(path)}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

/** POST /api/mode?path=… { saveDefault: true }: that chat's OWN mode becomes the default new
    sessions start from. Nothing is switched. Returns the file as written. */
export const saveModeDefault = (path: string) =>
  request<ModeInfo>(`/api/mode?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ saveDefault: true }),
  });

/** POST /api/sandbox?path=… { on }: flip that held chat's sandbox from its next tool call.
    "unsupported" when its runtime has no sandbox extension (the row isn't shown then). */
export const setSandbox = (path: string, on: boolean) =>
  request<SandboxApplyResult>(`/api/sandbox?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on }),
  });

/** POST /api/workers/resume?path=&id=: start one restored worker of that held chat again, idle.
    Throws ApiError with the extension's reason (409) when it can't. */
export const resumeWorker = (path: string, id: string) =>
  request<WorkerResumeResult>(`/api/workers/resume?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`, { method: "POST" });

/** A local folder (string), or a folder on a configured target; `host`: on that peer, which then holds it. */
export const createSession = (where: string | { target: string; remoteCwd: string }, host?: string | null) =>
  request<SessionSummary>(hostUrl(host, "/api/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(typeof where === "string" ? { cwd: where } : { target: where.target, remoteCwd: where.remoteCwd }),
  });

export const fetchTargets = (host?: string | null) => request<TargetInfo[]>(hostUrl(host, "/api/targets"));

/** How long the UI waits on a target's folder listing before saying so (the server bounds its own probe too). */
export const REMOTE_LIST_TIMEOUT_MS = 20_000;

/**
 * Subfolders of `path` on a target (no path: the server's default, the target's cwd or $HOME).
 * Read leniently: the server may send the local FolderListing shape or `{path, dirs}`.
 */
export async function fetchTargetFolders(target: string, path?: string, hidden = false, host?: string | null): Promise<FolderListing> {
  const q = new URLSearchParams();
  if (path) q.set("path", path);
  if (hidden) q.set("hidden", "1");
  const qs = q.toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REMOTE_LIST_TIMEOUT_MS);
  try {
    const raw = await request<Partial<FolderListing> & { dirs?: string[] }>(
      hostUrl(host, `/api/targets/${encodeURIComponent(target)}/folders${qs ? `?${qs}` : ""}`),
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
export const connectTarget = (host?: string | null) =>
  request<SessionSummary>(hostUrl(host, "/api/sessions/connect"), {
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

/**
 * Renames a session, or clears the user's title with `null` so the derived one (its first user
 * message) comes back. Sova's own store — the session's .jsonl is never written, so a session
 * open in a TUI can be renamed too.
 */
export const setSessionTitle = (path: string, title: string | null) =>
  request<SessionSummary>("/api/sessions/title", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, title }),
  });

/** The sidebar's user-made groups, in creation order. */
export const listSessionGroups = () => request<SessionGroup[]>("/api/session-groups");

export const createSessionGroup = (name: string) =>
  request<SessionGroup>("/api/session-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });

/**
 * Renames and/or reorders and/or (re)labels a group's members. Every field is optional, at least
 * one is required, and `order` is ALWAYS the whole array of session ids: the server reads it as
 * "these first, in this order; everything left out keeps its relative order behind them", so a
 * one-id order would silently move that member to the front. Ids that are not in the group are
 * ignored — they race with assign.
 */
export const patchSessionGroup = (id: string, patch: { name?: string; order?: string[]; labels?: { id: string; label: string | null }[] }) =>
  request<SessionGroup>(`/api/session-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

export const renameSessionGroup = (id: string, name: string) => patchSessionGroup(id, { name });

/** The group's members in display order (`SessionGroup.members`), as session ids. */
export const reorderSessionGroup = (id: string, order: string[]) => patchSessionGroup(id, { order });

/** Deletes the group and its assignments; the sessions themselves are untouched. */
export const deleteSessionGroup = (id: string) =>
  request<{ ok: true }>(`/api/session-groups/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * Puts one session in a group, or takes it out of the one it's in (`null`).
 *
 * `label` sets the session's label in the group it lands in, `null` clears it, and leaving it out
 * keeps the label it already had — a session moved between groups carries its metadata with it.
 * `index` is where it lands in the member order (0 first, omitted or past the end = the end), so
 * an undo restores the label AND the place in one write that can't half-succeed. It is ignored
 * when ungrouping, and ignored for a session already in that group: assign never reorders in
 * place, `PATCH {order}` is the reposition.
 *
 * `dissolved` comes back only when this write removed the last member of a group Sova fanned
 * out, which deletes it in the same atomic write — the client cannot infer that from a count it
 * just changed.
 */
export const assignSessionGroup = (path: string, groupId: string | null, opts?: { label?: string | null; index?: number }) =>
  request<AssignGroupResult>("/api/session-groups/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      groupId,
      ...(opts?.label === undefined ? {} : { label: opts.label }),
      ...(opts?.index === undefined ? {} : { index: opts.index }),
    }),
  });

/**
 * Removal by session id, for a member whose FILE is gone (gone from disk):
 * the path form 404s when there is no file to resolve, but the pane's `Remove From Group` still
 * has to work, so the route takes `id` for unassignment only. Same response shape as the path
 * form, `dissolved` included — taking the last member out of a fanout group dissolves it whether
 * the file existed or not.
 */
export const unassignSessionById = (id: string) =>
  request<AssignGroupResult>("/api/session-groups/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, groupId: null }),
  });

/**
 * The shared follow-up: one request, the server prompts every member in GROUP order.
 *
 * The 409 is part of this route's contract, not an exception — every member is checked before any
 * is prompted, and one unavailable member refuses the whole batch having sent NOTHING. So it comes
 * back as a value the caller must handle, rather than a throw it might not. `members` is the
 * user's explicit subset ("Send to the rest"), never inferred here or on the server.
 *
 * `sent` means ACCEPTED, not answered: the route returns once every prompt is queued. A member
 * that fails after acceptance reports in its own pane, over its own socket, never in this body.
 */
export async function promptSessionGroup(id: string, text: string, members?: string[]): Promise<BatchOutcome> {
  try {
    const result = await request<BatchPromptResult>(`/api/session-groups/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(members ? { text, members } : { text }),
    });
    return { ok: true, result };
  } catch (err) {
    const refused = err instanceof ApiError && err.status === 409 ? refusalsOf(err.body) : null;
    if (refused) return { ok: false, refused };
    return { ok: false, error: (err as Error).message, status: err instanceof ApiError ? err.status : 0 };
  }
}

/**
 * N sessions from one starting point, as one group. One write:
 * the group, its members and their assignments land together, because a fanout that half-exists
 * is a sidebar section the user has to clean up.
 *
 * Like the batch prompt, the refusal is a VALUE — a source that is mid-turn, TUI-live, in an older
 * format or has moved on since the dialog opened comes back as a 409 with exactly one entry naming
 * the SOURCE (which is a member of nothing, so its `id` is empty by design). A 201 can still carry
 * `failed`: members that couldn't start, named by `ref` since they have no session.
 */
export async function createFanout(body: FanoutRequest): Promise<FanoutOutcome> {
  try {
    const result = await request<FanoutResult>("/api/session-groups/fanout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: true, result };
  } catch (err) {
    const refused = err instanceof ApiError && err.status === 409 ? refusalsOf(err.body) : null;
    if (refused) return { ok: false, refused };
    const status = err instanceof ApiError ? err.status : 0;
    return { ok: false, error: (err as Error).message, status, conflict: conflictOf(err) };
  }
}

/**
 * A fork's answer. The 201 carries the new session and, for a fork taken BEFORE a user message,
 * that message for the new composer — its text, its uploaded attachments and any inline image
 * bytes — so the fork lands you exactly where you were about to send, with nothing auto-sent.
 *
 * The shapes are the server's (POST /api/sessions/fork, see the team's wire contract). They are
 * described here only as far as this client reads them; the words for a refusal are Sova's own
 * (`forkRefusalText`), never the server's prose parsed.
 */
export interface ForkEditor {
  text?: string;
  attachments?: TmpAttachment[];
  /** Inline image bytes (data URLs) the message carried. A composer draft holds uploaded files,
      not bytes, so these can be shown but not re-staged — the announcement says so. */
  images?: string[];
}

export type ForkOutcome =
  | { ok: true; session: SessionSummary; editor?: ForkEditor }
  /** A refusal is a VALUE, like the fanout's: the strip renders it on the message's own row. */
  | { ok: false; code?: string; message: string; status: number };

/**
 * Fork a session at one of its entries: `position: "before"` on a user message (pi's /fork — the
 * branch through its parent, that message handed to the new composer), `"at"` on any entry (pi's
 * /clone — everything through it). Never sends anything in the new session.
 */
export async function createFork(body: { path: string; entryId: string; position: "before" | "at" }): Promise<ForkOutcome> {
  try {
    const result = await request<{ session: SessionSummary; editor?: ForkEditor }>("/api/sessions/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: true, session: result.session, editor: result.editor };
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    const refused = err instanceof ApiError && err.status === 409 ? forkRefusalOf(err.body) : null;
    return { ok: false, code: refused?.code, message: refused?.message ?? (err as Error).message, status };
  }
}

/** The 409 body's single refusal, when it is shaped like one. An unknown shape is not invented
    into a code: the caller then says the plain "couldn't fork" sentence. */
function forkRefusalOf(body: unknown): { code?: string; message: string } | null {
  const list = (body as { refused?: unknown } | undefined)?.refused;
  const first = Array.isArray(list) ? list[0] : list;
  if (!first || typeof first !== "object") return null;
  const { code, message } = first as { code?: unknown; message?: unknown };
  return { code: typeof code === "string" ? code : undefined, message: typeof message === "string" ? message : "" };
}

/** The coded 400 this route can answer with, when it is one. */
function conflictOf(err: unknown): FanoutConflict["code"] | undefined {
  if (!(err instanceof ApiError) || err.status !== 400) return undefined;
  const code = (err.body as { code?: unknown } | undefined)?.code;
  return code === "seed-conflict" ? code : undefined;
}

/** The 409's members, or null when the body isn't the shape this route promises. */
function refusalsOf(body: unknown): BatchRefusal[] | null {
  if (typeof body !== "object" || body === null) return null;
  const list = (body as { refused?: unknown }).refused;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.every((r) => typeof r === "object" && r !== null && typeof (r as BatchRefusal).code === "string")
    ? (list as BatchRefusal[])
    : null;
}

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
 * Deletes archive sessions by age or empty "husks", or
 * the named, ARCHIVED sessions of `paths` mode. With `dryRun` nothing is deleted and the result says
 * what would be. Read leniently: the server may send fewer fields.
 */
export const cleanupSessions = (req: CleanupRequest | PathsCleanupRequest, dryRun: boolean): Promise<CleanupResponse> =>
  request<unknown>("/api/sessions/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...req, dryRun }),
  }).then((raw) => ({ ...parseCleanupResult(raw), refused: refusedEntries(raw) }));

/** A peer session's items name files on that peer (images it attached): their bytes come from it too. */
function noteAttachmentsHost(path: string, items: TranscriptItem[]): TranscriptItem[] {
  const host = hostOf(path);
  if (host) for (const item of items) for (const a of item.attachments ?? []) noteHost(a.path, host);
  return items;
}

export const fetchTranscript = (path: string) =>
  request<{ items: TranscriptItem[] }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => noteAttachmentsHost(path, r.items));

/** The transcript plus its context-window fill (null when unknown or stale). */
export const fetchTranscriptWithContext = (path: string) =>
  request<{ items: TranscriptItem[]; context: ContextInfo | null }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => ({
    items: noteAttachmentsHost(path, r.items),
    context: r.context ?? null,
  }));

/** The composer draft stored for a session; `text: null` when there is none. The server has
    already dropped attachments whose file is gone. */
export const fetchDraft = (path: string) =>
  request<{ text: string | null; attachments?: UploadResult[]; updatedAt: string | null }>(
    `/api/sessions/draft?path=${encodeURIComponent(path)}`,
    { cache: "no-store" },
  ).then((r) => {
    const attachments = r.attachments ?? [];
    const host = hostOf(path);
    if (host) for (const a of attachments) noteHost(a.path, host);
    return { text: r.text, attachments, updatedAt: r.updatedAt };
  });

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
  }).then((u) => {
    // Stored on the session's own host: its preview, delete and send all go there.
    noteHost(u.path, hostOf(sessionPath));
    return u;
  });

/** Deletes a draft attachment the user removed. Only files in the attachments folder qualify. */
export const deleteAttachment = (path: string) =>
  request<{ ok: true }>(`/api/attachment?path=${encodeURIComponent(path)}`, { method: "DELETE" });

export const fetchUsage =() => request<UsageInsight>("/api/insights/usage");

/** Fetch every provider's usage now and rewrite the shared cache; resolves to the new insight. */
export const refreshUsage = () => request<UsageInsight>("/api/insights/usage/refresh", { method: "POST" });

export const fetchAgents = () => request<AgentsInsight>("/api/insights/agents");

/** Installed extensions (the manifest), each with its backend's cached health. */
export const fetchExtensions = () => request<ExtensionInfo[]>("/api/extensions");

/** Every /explain artifact in the store, newest first (they're kept forever). */
export const fetchExplanations = () => request<ExplanationInfo[]>("/api/explanations");

export const fetchSessionInsight = (path: string) =>
  request<SessionInsight>(`/api/insights/session?path=${encodeURIComponent(path)}`);

/** The repository around a session's folder (read-only git). `fresh` skips the server's ~10s cache.
    Use loadGitSummary (lib/git-summary.ts), which shares a request already running. */
export const fetchGitSummary = (path: string, fresh = false) =>
  request<GitSummary>(`/api/sessions/git?path=${encodeURIComponent(path)}${fresh ? "&fresh=1" : ""}`);

/** What pi loads for a session (context files, offered skills, system-prompt files), read for its
    folder. `fresh` skips the server's cache. */
export const fetchSessionSetup = (path: string, fresh = false) =>
  request<SessionSetup>(`/api/sessions/context?path=${encodeURIComponent(path)}${fresh ? "&fresh=1" : ""}`);

/**
 * `force` (chat only) lets the server open a session whose file was written recently by
 * something that isn't a TUI. It never overrides a live TUI.
 */
export function wsUrl(endpoint: "/ws/chat" | "/ws/watch", path: string, force = false, host: string | null = hostOf(path)): string {
  return `${wsOrigin()}${peerBase(host)}${endpoint}?path=${encodeURIComponent(path)}${force ? "&force=1" : ""}`;
}

function wsOrigin(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
}

/**
 * Read-only tail of a claude-code worker's own Claude Code session (`/ws/watch?claude=<uuid>`).
 * These workers write no pi session file; the server finds theirs under ~/.claude/projects and
 * sends the same WatchServerMessages.
 */
export function claudeWatchUrl(sessionId: string, host: string | null = null): string {
  return `${wsOrigin()}${peerBase(host)}/ws/watch?claude=${encodeURIComponent(sessionId)}`;
}

/**
 * The server refuses chat (code "recent") on a file an unknown process wrote within this window
 * (RECENT_WRITE_MS in server/write-guard.ts). The server decides; this is for reference/copy.
 */
export const RECENT_WRITE_WINDOW_MS = 120_000;

// ---- the peer mesh (lib/mesh.ts) ----------------------------------------------------------------

/** This host, its peers and what syncs. Answers from local state only: no peer is asked. */
export const fetchMesh = () => request<MeshInfo>("/api/mesh");

/** This host's own hello: its version and wire-contract fingerprint. */
export const fetchMeshHello = () => request<MeshHello>("/api/mesh/hello");

/** Replace peers.json's list; the answer is the mesh as it stands after the write. An entry
    without `nodeId` is resolved by its name on the tailnet. */
export const putMeshPeers = (peers: MeshPeerEntry[]) =>
  request<MeshInfo>("/api/mesh/peers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ peers }) });

/** Tailnet nodes the serving host can see, and which of them run Sova. Only asked for on demand. */
export const fetchMeshCandidates = () => request<MeshCandidate[]>("/api/mesh/candidates");

/** Every peer's own session list, through the proxy. Only asked for while a peer is configured. */
export const fetchMeshSessions = () => request<MeshSessions>("/api/mesh/sessions");

export const getMeshSettings = () => request<MeshSettings>("/api/mesh/settings");

/** The Caddy front door these hosts would need, in failover order. Generated only: Sova never runs Caddy. */
export const fetchFrontDoor = () => request<FrontDoorConfig>("/api/mesh/front-door");

export const putMeshSettings = (settings: Partial<MeshSettings>) =>
  request<MeshSettings>("/api/mesh/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
