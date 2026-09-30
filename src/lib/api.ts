import type { ProfilesListing } from "../../shared/profiles";
import type {
  VoiceDeviceInfo,
  VoiceStatus,
  VoiceTranscript,
  AutoTitleResponse,
  SessionTitleSettings,
  SessionTitleSettingsInfo,
  AgentsInsight,
  SessionsDirInfo,
  AttentionDigest,
  ChatModeResult,
  ClaudeAccountsInfo,
  ClaudePoolInfo,
  ClaudeCliStatus,
  ClaudeLoginFlowState,
  ContextInfo,
  ExtensionInfo,
  ExplanationInfo,
  FileIndex,
  FolderListing,
  GitSummary,
  ModeInfo,
  ModelFavoriteResult,
  ModelInfo,
  IdeaPatch,
  OverseerIdeaDetail,
  OverseerIdeasInfo,
  OverseerAutonomy,
  OverseerInfo,
  OverseerSaveResult,
  OverseerSettings,
  OverseerSettingsInfo,
  OverseerAction,
  OverseerTodosInfo,
  TodoPatch,
  PlaybookCatalog,
  ScheduleInfo,
  SandboxApplyResult,
  AssignGroupResult,
  BatchPromptResult,
  BatchRefusal,
  SessionGroup,
  SessionHiddenWorkers,
  SessionInsight,
  SessionSetup,
  SessionSummary,
  ThemeList,
  TmpAttachment,
  TranscriptItem,
  TranscriptRows,
  UploadResult,
  UsageInsight,
  WebSettings,
  WorktreesInsight,
  MeshCandidate,
  MeshHello,
  MeshInfo,
  MeshLoginClaim,
  MeshLogins,
  MeshPeerEntry,
  MeshSessions,
  PushDevice,
  PushInfo,
  PushSettings,
  PushSettingsInfo,
  PushSubscribeRequest,
  PushTestResult,
} from "../../shared/protocol";
import type { MeshFrontDoor, MeshLocalSettings } from "../../shared/mesh-local";
import type { OwnerConversation, OwnerHome, OwnerLinkResult, OwnerProject, ProjectUpdate } from "../../shared/owner";
import type { NamedChange, OrgDetail, OrgsInfo, PersonHours, PersonInput, PersonPage, PersonPreview, ProfileChange } from "../../shared/orgs";
import type { BatonInfo, BatonSettings, BatonTold, BatonStartInput, BatonStartResult, BatonView, GatheringAbilities, OfferLink } from "../../shared/baton";
import type { ConflictResolveInput, DecisionsInfo, PromoteResult, SpecStatus } from "../../shared/decisions";
import type { PipelineInfo, PipelineTimeline } from "../../shared/pipeline";
import type { OrgCosts, ProjectCost } from "../../shared/costs";
import type { CodingStartInput, CodingStartResult, ItemCodeInput, ItemCodeResult, ItemSendInput, ItemSendResult, ProjectOverseerInfo, ProjectOverseerPatch } from "../../shared/project-overseer";
import type { HostBrowserAccessChange, HostBrowserAccessResult, HostRename, HostRenameResult, MeshDetails } from "../../shared/mesh-details";
import type { MeshResync, ResyncJob, ResyncStart } from "../../shared/mesh-resync";
import type { LinkSeen, LinkThread } from "../../shared/mesh-links";
import type { MonitorHistory, MonitorResolution, MonitorSnapshot } from "../../shared/protocol";
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
import type { TeamDefaults, TeamDefaultsInfo, TeamDefaultsSaveResult } from "../../shared/team-defaults";
import type { ProviderLimits, ProviderLimitsInfo, ProviderWaiting } from "../../shared/provider-limits";
import type { TargetInfo } from "./remote-session";
import type { DecisionKeyInfo, DecisionProbeResult, DecisionSaveResult, DecisionSettings, DecisionSettingsInfo, TagsBackfillProgress, TagsBackfillScope } from "../../shared/protocol";
import { hostOf, hostUrl, meshReadInit, noteHost, peerBase, routeUrl } from "./mesh";
import type { PreviewList, PreviewMint, PreviewMinted, PreviewView } from "../../shared/preview-links";

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
export const sessionsDir = () => request<SessionsDirInfo>("/api/sessions/dir");

/** A link's message thread as `host` (the pane's session's host) holds it (§mesh.links/agents-pane). */
export const fetchLinkThread = (host: string | null, linkId: string) =>
  request<LinkThread>(hostUrl(host, `/api/links/${encodeURIComponent(linkId)}/thread`), { cache: "no-store" });

/** The pane read a partner's messages up to `at`: they stop counting as unread there. */
export const markLinkSeen = (host: string | null, linkId: string, seen: LinkSeen) =>
  request<{ ok: true }>(hostUrl(host, `/api/links/${encodeURIComponent(linkId)}/seen`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(seen),
  });

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
/** How many of each provider's requests may run at once on this device (§app.provider-limits/setting). */
export const getProviderLimits = () => request<ProviderLimitsInfo>("/api/settings/provider-limits");
export const putProviderLimits = (limits: ProviderLimits) =>
  request<ProviderLimitsInfo>("/api/settings/provider-limits", { method: "PUT", body: JSON.stringify({ limits }) });
/** Who waits on a provider's limit now, by session id (§app.provider-limits/waiting-shown). */
export const getProviderWaiting = () => request<ProviderWaiting>("/api/provider-limits/waiting");

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

/** Team defaults (Settings → Teams): the coordinator and monitor every new team gets. */
export const getTeamDefaults = () => request<TeamDefaultsInfo>("/api/settings/team");

/** Settings → Accounts: this host's Claude logins in order, their standing, and the add-login flow. */
export const getClaudeAccounts = () => request<ClaudeAccountsInfo>("/api/claude/accounts");
/** The logins of the host that holds chat `path` (the query only routes the request there). */
export const getChatClaudeAccounts = (path: string) =>
  request<ClaudeAccountsInfo>(`/api/claude/accounts?path=${encodeURIComponent(path)}`);
/** Start `claude auth login` for a new login; answers once its sign-in URL is out. */
/** Add a login, or (with `login`) sign an existing one in again on this device. */
export const startClaudeLogin = (login?: string) =>
  request<ClaudeLoginFlowState>("/api/claude/accounts/flow", { method: "POST", ...(login ? { body: JSON.stringify({ login }) } : {}) });
export const setClaudePoolKeeper = (device: string) =>
  request<ClaudePoolInfo>("/api/claude/pool/keeper", { method: "PUT", body: JSON.stringify({ device }) });
export const pinClaudePoolLogin = (id: string, pin: string | null) =>
  request<ClaudePoolInfo>(`/api/claude/pool/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ pin }) });
export const returnClaudePoolLogin = (id: string) =>
  request<ClaudePoolInfo>(`/api/claude/pool/${encodeURIComponent(id)}/return`, { method: "POST" });
export const putClaudePoolOrder = (order: string[]) =>
  request<ClaudePoolInfo>("/api/claude/pool/order", { method: "PUT", body: JSON.stringify({ order }) });
/** The code the sign-in page showed; answers once Claude Code finished (or refused it). */
export const sendClaudeLoginCode = (code: string) =>
  request<ClaudeLoginFlowState>("/api/claude/accounts/flow/code", { method: "POST", body: JSON.stringify({ code }) });
export const cancelClaudeLogin = () => request<ClaudeAccountsInfo>("/api/claude/accounts/flow", { method: "DELETE" });
export const putClaudeLoginOrder = (order: string[]) =>
  request<ClaudeAccountsInfo>("/api/claude/accounts/order", { method: "PUT", body: JSON.stringify({ order }) });
export const patchClaudeLogin = (id: string, patch: { enabled?: boolean; label?: string | null }) =>
  request<ClaudeAccountsInfo>(`/api/claude/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
export const clearClaudeLogin = (id: string) => request<ClaudeAccountsInfo>(`/api/claude/accounts/${encodeURIComponent(id)}/clear`, { method: "POST" });
export const removeClaudeLogin = (id: string) => request<ClaudeAccountsInfo>(`/api/claude/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });

/** What each worker backend offers for the two roles: the same discovery as Delegate's. */
export const getTeamOptions = () => request<DelegateOptions>("/api/settings/team/options");

/** Replace the whole file. Teams created afterwards, here and in the terminal, use it. */
export const putTeamDefaults = (settings: TeamDefaults) =>
  request<TeamDefaultsSaveResult>("/api/settings/team", { method: "PUT", body: JSON.stringify(settings) });

/** Which model writes the summary line (the topic-outline extension's file; missing → its defaults). */
export const getSummarizerSettings = () => request<SummarizerSettingsInfo>("/api/settings/summarizer");

/** Replace the chain; the file's other keys stay. Sessions started afterwards, here and in the TUI, use it. */
export const putSummarizerSettings = (settings: SummarizerSettings) =>
  request<SummarizerSettingsInfo>("/api/settings/summarizer", { method: "PUT", body: JSON.stringify(settings) });

/** Settings → Summaries → Session titles: the automatic namer's switch, timing and models (Sova's own file). */
export const getSessionTitleSettings = () => request<SessionTitleSettingsInfo>("/api/settings/session-titles");

/** Replace the whole file; the sweep picks it up at once. */
export const putSessionTitleSettings = (settings: SessionTitleSettings) =>
  request<SessionTitleSettingsInfo>("/api/settings/session-titles", { method: "PUT", body: JSON.stringify(settings) });

/**
 * Name these sessions with the host's title model (§app.session-list/auto-titles). All `paths`
 * must live on one host: `request` sends them to that host, as with every path-named route.
 */
export const autoTitleSessions = (paths: string[], dryRun = false) =>
  request<AutoTitleResponse>("/api/sessions/auto-title", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(dryRun ? { paths, dryRun } : { paths }),
  });

/** One session by id, listed or not (the list omits sessions with no user message). 404: no file has that id. */
export const getSessionSummaryById = (id: string) => request<SessionSummary>(`/api/sessions/summary?id=${encodeURIComponent(id)}`);

/** The Overseer: its current file (created on first ask), old files, and the entry button's counts. */
export const getOverseer = () => request<OverseerInfo>("/api/overseer");

/** `/clear`: stops a running turn and starts a new Overseer file. Never refuses. */
export const clearOverseer = () => request<OverseerInfo>("/api/overseer/clear", { method: "POST" });

/** The Overseer's running count and its approvals and rules (§app.overseer/approvals). */
export const getOverseerAutonomy = () => request<OverseerAutonomy>("/api/overseer/autonomy");
export const revokeOverseerPermit = (id: string) =>
  request<{ ok: true }>("/api/overseer/autonomy/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });

/** The Overseer's standing notes (`overseer-notes.md`): they survive /clear. */
export const getOverseerNotes = () => request<{ text: string }>("/api/overseer/notes");
/** `base`: the notes this edit started from; the server refuses (409, with the current `text`) when
    the file holds something else by now, so an edit never deletes a note the Overseer added. */
export const putOverseerNotes = (text: string, base?: string) =>
  request<{ text: string }>("/api/overseer/notes", { method: "PUT", body: JSON.stringify(base === undefined ? { text } : { text, base }) });

/** The Overseer's ideas backlog: the ToC, every record and the link edges (no prose). */
export const getOverseerIdeas = () => request<OverseerIdeasInfo>("/api/overseer/ideas");

/** One idea with its prose, the ideas it reaches (scope) and the ones that link to it. 404: no such idea. */
export const getOverseerIdea = (id: string) => request<OverseerIdeaDetail>(`/api/overseer/idea?id=${encodeURIComponent(id)}`);

/** Edit an idea. `patch.base` = the updatedAt the edit started from: the server refuses (409, an
    IdeaConflict carrying the current detail in `ApiError.body`) when the idea changed since. */
export const patchOverseerIdea = (id: string, patch: IdeaPatch) =>
  request<OverseerIdeaDetail>(`/api/overseer/idea?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });

/** The user's todos, in list order, with the open and done counts. Every write returns the whole list. */
export const getOverseerTodos = () => request<OverseerTodosInfo>("/api/overseer/todos");
export const addOverseerTodo = (text: string) => request<OverseerTodosInfo>("/api/overseer/todos", { method: "POST", body: JSON.stringify({ text }) });
/** `patch.base` (sent for text edits) = the updatedAt the edit started from: the server refuses (409,
    a TodoConflict carrying the current list in `ApiError.body`) when the todo changed since. */
export const patchOverseerTodo = (id: string, patch: TodoPatch) =>
  request<OverseerTodosInfo>(`/api/overseer/todo?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteOverseerTodo = (id: string) => request<OverseerTodosInfo>(`/api/overseer/todo?id=${encodeURIComponent(id)}`, { method: "DELETE" });
/** `ids` must be every todo exactly once (400 otherwise: the list changed meanwhile). */
export const reorderOverseerTodos = (ids: string[]) => request<OverseerTodosInfo>("/api/overseer/todos/order", { method: "PUT", body: JSON.stringify({ ids }) });
export const clearDoneOverseerTodos = () => request<OverseerTodosInfo>("/api/overseer/todos/done", { method: "DELETE" });

/** The attention digest: what needs the user, what finished, what is running (≤30 items, tier first). */
export const getAttention = () => request<AttentionDigest>("/api/overseer/attention");

/** Settings → Overseer. */
export const getOverseerSettings = () => request<OverseerSettingsInfo>("/api/settings/overseer");

/** Replace the Overseer's settings; model and thinking apply at once while it is idle. */
export const putOverseerSettings = (settings: OverseerSettings) =>
  request<OverseerSaveResult>("/api/settings/overseer", { method: "PUT", body: JSON.stringify(settings) });

// ---- phone notifications (Web Push; shared/protocol.ts) ----------------------------------------------

const JSON_HEADERS = { "content-type": "application/json" };

/** The server's public key, the devices (never their endpoints) and the settings. */
export const getPushInfo = () => request<PushInfo>("/api/push");
export const putPushSettings = (settings: PushSettings) =>
  request<PushSettingsInfo>("/api/push/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(settings) });
/** Add or refresh this browser's subscription. A `resync` of a removed device answers 410. */
export const postPushSubscription = (body: PushSubscribeRequest) =>
  request<PushDevice>("/api/push/subscribe", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
export const deletePushSubscription = (which: { endpoint: string } | { id: string }) =>
  request<{ removed: boolean }>("/api/push/subscribe", { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify(which) });
export const sendPushTest = () => request<PushTestResult>("/api/push/test", { method: "POST", headers: JSON_HEADERS, body: "{}" });

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

/** Approve a playbook's schedule (§chat.schedules/approval): `pin` is what the user was shown; a
    changed file refuses (409). Only a click in Sova calls this. */
export const approveSchedule = (body: { cwd: string; playbook: string; pin: string }, host?: string | null) =>
  request<ScheduleInfo>(hostUrl(host, "/api/schedules/approve"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Revoke a schedule's approval: it fires nothing more and reads Needs approval again. */
export const revokeSchedule = (id: string, host?: string | null) =>
  request<{ ok: true }>(hostUrl(host, "/api/schedules/revoke"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });

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
/** `deleted`: archiving an empty husk deleted its file instead (§app.session-list/archive-org-guard). */
export const setSessionArchived = (path: string, archived: boolean) =>
  request<SessionSummary & { deleted?: true }>("/api/sessions/archive", {
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

/** Profiles (§chat/profiles): what a folder can use, one pick, approving and hiding (profiles are files; nothing here writes one). */
export type ProfilePickRef = { source: "sova" | "user" | "project"; id: string };
export const fetchProfiles = (cwd?: string | null) =>
  request<ProfilesListing>(cwd ? `/api/profiles?cwd=${encodeURIComponent(cwd)}` : "/api/profiles", { cache: "no-store" });
export const pickProfile = (path: string, profile: ProfilePickRef | { remove: string[]; grant: string[]; from?: ProfilePickRef } | null) =>
  request<{ ok: true }>("/api/sessions/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, profile }) });
/** Approve a project profile's powers, exactly the ones shown (§chat.profiles/trust). */
export const approveProfile = (cwd: string, p: { id: string; grant: string[]; overseerMayStart: boolean }) =>
  request<ProfilesListing>("/api/profiles/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, id: p.id, grant: p.grant, overseerMayStart: p.overseerMayStart }),
  });
export const setProfileHidden = (key: string, hidden: boolean, cwd?: string | null) =>
  request<ProfilesListing>("/api/profiles/hidden", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, hidden, ...(cwd ? { cwd } : {}) }) });
/** A new session in `cwd` with a profile picked; nothing is sent (the shelf's Run and Start, the chip's Run Again). */
export const startProfileSession = (cwd: string, profile: ProfilePickRef) =>
  request<SessionSummary>("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, profile }) });

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
 * place, `PATCH {order}` is the reposition. It never deletes a group, emptied or not.
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
 * form.
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

/** The whole branch with each row light (`view=light`): what the session pane reads of every row,
    without the replies' text, tools' output and image bytes that only the thread draws. */
export const fetchTranscriptLight = (path: string) =>
  request<{ items: TranscriptItem[] }>(`/api/transcript?path=${encodeURIComponent(path)}&view=light`).then((r) => noteAttachmentsHost(path, r.items));

/** The transcript plus its context-window fill (null when unknown or stale). */
export const fetchTranscriptWithContext = (path: string) =>
  request<{ items: TranscriptItem[]; context: ContextInfo | null }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => ({
    items: noteAttachmentsHost(path, r.items),
    context: r.context ?? null,
  }));

/** What GET /api/transcript's rows can ask for (TranscriptRows in shared/protocol.ts). */
export type RowsAsk = { tail: true } | { before: string; from?: string; explain?: string; chars?: number } | { from: string };

/** Rows of a session's branch (lib/older-rows), or why not: the branch moved under the list, or the
    target isn't on it. */
export async function fetchTranscriptRows(path: string, ask: RowsAsk, leaf?: string | null): Promise<TranscriptRows | { code: "moved" | "missing" }> {
  const q = new URLSearchParams({ path });
  for (const [k, v] of Object.entries(ask)) q.set(k, v === true ? "1" : String(v));
  if (leaf) q.set("leaf", leaf);
  try {
    const r = await request<TranscriptRows>(`/api/transcript?${q}`);
    return { ...r, items: noteAttachmentsHost(path, r.items) };
  } catch (err) {
    const code = err instanceof ApiError ? (err.body as { code?: unknown } | undefined)?.code : undefined;
    if (code === "moved" || code === "missing") return { code };
    throw err;
  }
}

/**
 * A transcript's newest rows for keeping in memory (lib/recent-preload): the same read-only GET, with its size
 * (the body's length, else the JSON's characters) for the memory budget. `fits` sees the
 * announced length before the body comes: when it says no, the download stops there and the
 * answer is just the size.
 */
export async function fetchTranscriptForCache(
  path: string,
  fits: (size: number) => boolean,
): Promise<(TranscriptRows & { size: number }) | { tooBig: number }> {
  const aborter = new AbortController();
  // The newest rows only, as a view's hello carries them (TranscriptRows): the view fetches the
  // rest when it wants them (lib/older-rows).
  const res = await fetch(routeUrl(`/api/transcript?path=${encodeURIComponent(path)}&tail=1`), { signal: aborter.signal });
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  const announced = Number(res.headers.get("content-length")) || 0;
  if (announced && !fits(announced)) {
    aborter.abort();
    return { tooBig: announced };
  }
  const text = await res.text();
  const rows = JSON.parse(text) as TranscriptRows;
  // A server that predates the rows sends the whole branch: nothing above it.
  return {
    items: noteAttachmentsHost(path, rows.items),
    older: rows.older ?? 0,
    olderSummary: rows.olderSummary ?? { inputs: [], messages: 0, replies: false },
    size: announced || text.length,
  };
}

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

/** The git worktrees of the named sessions (the Agents board's visible rows). */
export const fetchWorktrees = (paths: readonly string[]) =>
  request<WorktreesInsight>(`/api/insights/worktrees?paths=${encodeURIComponent(paths.join(","))}`);

/** Installed extensions (the manifest), each with its backend's cached health. */
export const fetchExtensions = () => request<ExtensionInfo[]>("/api/extensions");

/** Every /explain artifact in the store, newest first (they're kept forever). */
export const fetchExplanations = () => request<ExplanationInfo[]>("/api/explanations");

export const fetchSessionInsight = (path: string) =>
  request<SessionInsight>(`/api/insights/session?path=${encodeURIComponent(path)}`);

/** The workers the session's live record doesn't list, read from its file on request. */
export const fetchHiddenWorkers = (path: string) =>
  request<SessionHiddenWorkers>(`/api/insights/session/workers?path=${encodeURIComponent(path)}`);

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
/** `init`: the poll's deadline while the mesh is on (lib/mesh `meshReadInit`); none otherwise. */
export const fetchMesh = (init?: RequestInit) => request<MeshInfo>("/api/mesh", init);

/** This host's own hello: its version and wire-contract fingerprint. */
export const fetchMeshHello = () => request<MeshHello>("/api/mesh/hello", meshReadInit(true));

/** Replace peers.json's list; the answer is the mesh as it stands after the write. An entry
    without `nodeId` is resolved by its name on the tailnet. */
export const putMeshPeers = (peers: MeshPeerEntry[]) =>
  request<MeshInfo>("/api/mesh/peers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ peers }) });

/** Tailnet nodes the serving host can see, and which of them run Sova. Only asked for on demand. */
export const fetchMeshCandidates = () => request<MeshCandidate[]>("/api/mesh/candidates");

/** Every peer's own session list, through the proxy. Only asked for while a peer is configured. */
export const fetchMeshSessions = () => request<MeshSessions>("/api/mesh/sessions", meshReadInit(true));

/** This host's mesh settings, with the fields only its own page uses (shared/mesh-local.ts). */
export const getMeshSettings = () => request<MeshLocalSettings>("/api/mesh/settings");

/** The Caddy front door these hosts would need, in failover order. Generated only: Sova never runs Caddy. */
export const fetchFrontDoor = () => request<MeshFrontDoor>("/api/mesh/front-door");

export const putMeshSettings = (settings: Partial<MeshLocalSettings>) =>
  request<MeshLocalSettings>("/api/mesh/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });

/** Every login this host syncs, with the ones that differ from a peer's since before sync. */
export const fetchMeshLogins = () => request<MeshLogins>("/api/mesh/logins");

/** "Use this host's login everywhere": it becomes a login made now, so every peer takes it. */
export const claimMeshLogin = (key: string) =>
  request<{ ok: true }>("/api/mesh/logins/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key } satisfies MeshLoginClaim),
  });

/** Every host's own details (shared/mesh-details.ts), this host first; mesh on only. */
export const fetchMeshDetails = () => request<MeshDetails>("/api/mesh/details", meshReadInit(true));

/** Where each peer's build sits against this host's boot build, and the last resync job per host (§mesh.peers/resync). */
export const fetchMeshResync = () => request<MeshResync>("/api/mesh/resync", { cache: "no-store" });

/** Deploy this host's boot build to a peer that is behind: `commit` is the one the sheet showed, refused once it isn't. */
export const startMeshResync = (id: string, commit: string) =>
  request<ResyncJob>(`/api/mesh/resync/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commit } satisfies ResyncStart),
  });

/** The Resource Monitor's latest tick (§app/resource-monitor); polled only while its modal is open. */
export const fetchMonitor = () => request<MonitorSnapshot>("/api/monitor", { cache: "no-store" });
/** Monitor history after `since` (epoch ms): the 5s ring, or the 30s rollups on disk. */
export const fetchMonitorHistory = (since: number, res: MonitorResolution) =>
  request<MonitorHistory>(`/api/monitor/history?since=${Math.floor(since)}&res=${res}`, { cache: "no-store" });

/** Rename a host: this one, or a peer (which then tells its own peers). */
export const putHostLabel = (id: string, label: string) =>
  request<HostRenameResult>("/api/mesh/label", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, label } satisfies HostRename),
  });

/** A host's own Browser access: this host's, or a peer asked to change its own. */
export const putHostBrowserAccess = (id: string, browserAccess: boolean) =>
  request<HostBrowserAccessResult>("/api/mesh/browser-access", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, browserAccess } satisfies HostBrowserAccessChange),
  });

// ---- Settings → Decisions (components/DecisionSettings.tsx) --------------------------------------

export const getDecisionSettings = () => request<DecisionSettingsInfo>("/api/settings/decisions");

/** What each backend offers for the fallback row: the same discovery as Delegate's. */
export const getDecisionOptions = () => request<DelegateOptions>("/api/settings/decisions/options");

export const putDecisionSettings = (settings: DecisionSettings) =>
  request<DecisionSaveResult>("/api/settings/decisions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });

/** Store a Jev key once Jev accepts it. A rejected key isn't stored: the 422's body is its status,
    returned like a success so the screen can say so. Only `last4` ever comes back. */
export async function putDecisionKey(key: string): Promise<DecisionKeyInfo> {
  try {
    return await request<DecisionKeyInfo>("/api/settings/decisions/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  } catch (err) {
    const body = err instanceof ApiError && err.status === 422 ? (err.body as Partial<DecisionKeyInfo> | undefined) : undefined;
    if (body && typeof body.status === "string" && typeof body.present === "boolean") return body as DecisionKeyInfo;
    throw err;
  }
}

export const deleteDecisionKey = () => request<DecisionKeyInfo>("/api/settings/decisions/key", { method: "DELETE" });

/** One canned decision through the chain (the Test button). A provider failure is `ok: false`, not a throw. */
export const probeDecisions = () => request<DecisionProbeResult>("/api/settings/decisions/probe", { method: "POST" });

export const getTagsBackfill = () => request<TagsBackfillProgress>("/api/sessions/tags/backfill");

/** Start tagging past sessions, or get the job already running. */
export const startTagsBackfill = (scope: TagsBackfillScope) =>
  request<TagsBackfillProgress>("/api/sessions/tags/backfill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });

/** Stop the running backfill; what it tagged stays. */
export const cancelTagsBackfill = () => request<TagsBackfillProgress>("/api/sessions/tags/backfill/cancel", { method: "POST" });

// ---- organizations and baton sessions (§app/organizations, §app/baton) -------------------------------

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const getOrgs = () => request<OrgsInfo>("/api/orgs");
export const createOrg = (name: string, dir?: string) => request<OrgDetail>("/api/orgs", jsonInit("POST", { name, ...(dir ? { dir } : {}) }));
/** `confirm`: attach although another host holds it (the answer to a 409 `code: "held"`). */
export const attachOrg = (dir: string, confirm = false) => request<OrgDetail>("/api/orgs/attach", jsonInit("POST", { dir, ...(confirm ? { confirm: true } : {}) }));
export const setOperatorName = (name: string) => request<OrgsInfo>("/api/orgs/operator", jsonInit("PUT", { name }));
export const getOrg = (id: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}`);
export const patchOrg = (id: string, patch: { name?: string; about?: string }) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}`, jsonInit("PATCH", patch));
/** r13: the company's zone and working hours, the default for anyone without their own ("" / null clear them). */
export const putOrgHours = (id: string, body: { tz: string; hours: PersonHours | null }) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/hours`, jsonInit("PUT", body));
/** r13: the company's zone or hours back to history line `at`'s `from`; refused when that field changed since. */
export const revertOrgHours = (id: string, at: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/hours/revert`, jsonInit("POST", { at }));
/** The org's About text back to history line `at`'s `from` (§app.organizations/about). */
export const revertOrgAbout = (id: string, at: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/about/revert`, jsonInit("POST", { at }));
export const detachOrg = (id: string) => request<{ ok: true }>(`/api/orgs/${encodeURIComponent(id)}`, jsonInit("DELETE"));
/** Reload the org's charts from its workspace (a fixed journal, restored snapshots): `problems` is what is still wrong. */
export const reloadOrg = (id: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/reload`, jsonInit("POST"));
export const commitOrg = (id: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/commit`, jsonInit("POST"));
export const setOrgRemote = (id: string, url: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/remote`, jsonInit("PUT", { url }));
export const addPerson = (id: string, person: PersonInput) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/people`, jsonInit("POST", person));
export const patchPerson = (id: string, pid: string, patch: Partial<PersonInput>) =>
  request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}`, jsonInit("PATCH", patch));
export const personHistory = (id: string, pid: string) => request<ProfileChange[]>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}/history`);
export const revertPersonChange = (id: string, pid: string, at: string) =>
  request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}/revert`, jsonInit("POST", { at }));
/** One person's page (§app.organizations/person-page). */
export const getPersonPage = (id: string, pid: string) => request<PersonPage>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}`);
/** Turns off one link of theirs (`one`), or every live link of theirs on this host. */
export const revokePersonLinks = (id: string, pid: string, one?: { sessionId: string; n: number }) =>
  request<PersonPage>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}/links/revoke`, jsonInit("POST", one ?? {}));
/** A session as their link shows it, read-only ("Preview as {name}"); no token. */
export const previewAsPerson = (id: string, pid: string, sid: string) =>
  request<PersonPreview>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}/preview?session=${encodeURIComponent(sid)}`);
export const addOrgProject = (id: string, name: string, root: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/projects`, jsonInit("POST", { name, root }));
/** Set or clear a project's main stakeholder (a roster person's id, or null for none). */
export const setProjectStakeholder = (id: string, pid: string, stakeholder: string | null) =>
  request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/projects/${encodeURIComponent(pid)}`, jsonInit("PATCH", { stakeholder }));
/** Archive a project (§app.organizations/archive): 409 naming what is open; Unarchive brings it back. */
export const archiveOrgProject = (id: string, pid: string) =>
  request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/projects/${encodeURIComponent(pid)}/archive`, jsonInit("POST", {}));
export const unarchiveOrgProject = (id: string, pid: string) =>
  request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/projects/${encodeURIComponent(pid)}/unarchive`, jsonInit("POST", {}));

// ---- the org's owner and the Owner page (§app/owner-page; routes in shared/owner.ts) ----
/** Set the org's owner (an active roster person's id), or none. */
export const setOrgOwner = (id: string, personId: string | null) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/owner`, jsonInit("PUT", { personId }));
/** Mint the owner's link, shown once; the older one stops at once. */
export const ownerLink = (id: string) => request<OwnerLinkResult>(`/api/orgs/${encodeURIComponent(id)}/owner/link`);
export const revokeOwnerLink = (id: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/owner/revoke`, jsonInit("POST"));
/** The Owner page as the owner sees it (Home, a project `q_…`, a conversation `k_…`); no token, no visit. */
export const previewOwnerPage = (id: string, at?: { project?: string; c?: string }) =>
  request<OwnerHome | OwnerProject | OwnerConversation>(
    `/api/orgs/${encodeURIComponent(id)}/owner/preview${at?.project ? `?project=${encodeURIComponent(at.project)}` : at?.c ? `?c=${encodeURIComponent(at.c)}` : ""}`,
  );
/** Show this project on the owner's page, or not. */
export const setProjectOwnerHidden = (id: string, pid: string, ownerHidden: boolean) =>
  request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/projects/${encodeURIComponent(pid)}`, jsonInit("PATCH", { ownerHidden }));
/** Hide one conversation from the owner's page, or show it again. */
export const setBatonHiddenFromOwner = (sid: string, hidden: boolean) => request<BatonInfo>(`/api/baton/${encodeURIComponent(sid)}/owner`, jsonInit("POST", { hidden }));
/** The project's updates on the owner's page, newest first, withdrawn ones included. */
export const getProjectUpdates = (id: string, pid: string) => request<ProjectUpdate[]>(`/api/orgs/${encodeURIComponent(id)}/projects/${encodeURIComponent(pid)}/updates`);
export const withdrawProjectUpdate = (id: string, pid: string, uid: string) =>
  request<ProjectUpdate[]>(`/api/orgs/${encodeURIComponent(id)}/projects/${encodeURIComponent(pid)}/updates/${encodeURIComponent(uid)}/withdraw`, jsonInit("POST"));

export const startBaton = (input: BatonStartInput) => request<BatonStartResult>("/api/baton", jsonInit("POST", input));
export const getBaton = (path: string) => request<BatonInfo>(`/api/baton?path=${encodeURIComponent(path)}`);
/** What It's Told (§app.baton/told): fetched when opened, the operator's only. */
export const getBatonTold = (sid: string) => request<BatonTold>(`/api/baton/${encodeURIComponent(sid)}/told`);
export const batonLink = (sid: string) => request<{ link: string; n: number; at?: string; linkWarning?: string }>(`/api/baton/${encodeURIComponent(sid)}/link`);
export const revokeBatonLink = (sid: string) => request<{ ok: true }>(`/api/baton/${encodeURIComponent(sid)}/revoke`, jsonInit("POST"));
export const takeBaton = (sid: string) => request<{ ok: true }>(`/api/baton/${encodeURIComponent(sid)}/take`, jsonInit("POST"));
export const closeBaton = (sid: string) => request<{ ok: true }>(`/api/baton/${encodeURIComponent(sid)}/close`, jsonInit("POST"));
/** Raise the session's message limit by `by` (the operator, at the limit). */
export const extendBaton = (sid: string, by: number) => request<BatonInfo>(`/api/baton/${encodeURIComponent(sid)}/extend`, jsonInit("POST", { by }));
/** What a gathering session can do, from its next reply (§app.baton/abilities). */
export const setBatonAbilities = (sid: string, abilities: Partial<GatheringAbilities>) => request<BatonInfo>(`/api/baton/${encodeURIComponent(sid)}/abilities`, jsonInit("POST", abilities));
/** The host's defaults for new hand-off sessions (Settings → Organizations). */
export const getBatonSettings = () => request<BatonSettings>("/api/baton/settings");
export const putBatonSettings = (settings: BatonSettings) => request<BatonSettings>("/api/baton/settings", jsonInit("PUT", settings));
export const offerBaton = (sid: string, to: string[], question?: string, briefing?: string) =>
  request<{ links: OfferLink[]; info?: BatonInfo; linkWarning?: string }>(`/api/baton/${encodeURIComponent(sid)}/offer`, jsonInit("POST", { to, ...(question ? { question } : {}), ...(briefing ? { briefing } : {}) }));
export const withdrawOffer = (sid: string) => request<BatonInfo>(`/api/baton/${encodeURIComponent(sid)}/offer/withdraw`, jsonInit("POST"));
/** A fresh link for one invitee of the open offer (their older one stops working). */
export const inviteeLink = (sid: string, personId: string) => request<{ link: string; n: number; at?: string; linkWarning?: string }>(`/api/baton/${encodeURIComponent(sid)}/link?person=${encodeURIComponent(personId)}`);
/** The operator hands the session to a person ("Hand this session to Bob"). */
export const handBaton = (sid: string, to: string, question: string, briefing?: string) =>
  request<{ info?: BatonInfo; link?: string; at?: string; linkWarning?: string; offHours?: string }>(`/api/baton/${encodeURIComponent(sid)}/handoff`, jsonInit("POST", { to, question, ...(briefing ? { briefing } : {}) }));
export const approvePerson = (id: string, pid: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}/approve`, jsonInit("POST"));
export const declinePerson = (id: string, pid: string) => request<OrgDetail>(`/api/orgs/${encodeURIComponent(id)}/people/${encodeURIComponent(pid)}/decline`, jsonInit("POST"));
export const orgChanges = (id: string, limit = 50) => request<NamedChange[]>(`/api/orgs/${encodeURIComponent(id)}/changes?limit=${limit}`);
/** Run a wrap-up that stopped again (the operator's Retry Wrap-Up). */
export const retryWrapup = (sid: string) => request<BatonInfo>(`/api/baton/${encodeURIComponent(sid)}/wrapup/retry`, jsonInit("POST"));

// ---- a project's decisions, their reconciliation and promotion (§app/requirements) ------------------

const projectBase = (orgId: string, projectId: string) => `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
export const getDecisions = (orgId: string, projectId: string) => request<DecisionsInfo>(`${projectBase(orgId, projectId)}/decisions`);
export const reconcileProject = (orgId: string, projectId: string) => request<DecisionsInfo>(`${projectBase(orgId, projectId)}/reconcile`, jsonInit("POST"));
export const redraftProject = (orgId: string, projectId: string) => request<DecisionsInfo>(`${projectBase(orgId, projectId)}/draft`, jsonInit("POST"));
/** `bulk`: the ids are exactly what Select All Ready chose (the server holds bulk to the stricter rule). */
export const promoteDecisions = (orgId: string, projectId: string, ids: string[], bulk: boolean) =>
  request<PromoteResult>(`${projectBase(orgId, projectId)}/promote`, jsonInit("POST", { ids, bulk }));
/** Who decides a decision: a roster decision area or "none" (§app.requirements/owner-area). */
export const setOwnerArea = (orgId: string, projectId: string, did: string, ownerArea: string) =>
  request<DecisionsInfo>(`${projectBase(orgId, projectId)}/decisions/${encodeURIComponent(did)}`, jsonInit("PATCH", { ownerArea }));
/** A promoted decision edited in the spec: keep the spec's words, or promote the person's again. */
export const settleSpecText = (orgId: string, projectId: string, did: string, action: "keep" | "restore") =>
  request<DecisionsInfo>(`${projectBase(orgId, projectId)}/decisions/${encodeURIComponent(did)}/text`, jsonInit("POST", { action }));
export const routeConflict = (orgId: string, projectId: string, cid: string, to?: string) =>
  request<DecisionsInfo & { offHours?: string }>(`${projectBase(orgId, projectId)}/conflicts/${encodeURIComponent(cid)}/route`, jsonInit("POST", to ? { to } : {}));
export const resolveConflict = (orgId: string, projectId: string, cid: string, input: ConflictResolveInput) =>
  request<DecisionsInfo>(`${projectBase(orgId, projectId)}/conflicts/${encodeURIComponent(cid)}/resolve`, jsonInit("POST", input));
export const setSpecFrozen = (orgId: string, projectId: string, frozen: boolean) =>
  request<SpecStatus>(`${projectBase(orgId, projectId)}/spec`, jsonInit("PATCH", { frozen }));

// ---- a project's Pipeline and the acts waiting in a hold (§app.project-overseer/pipeline, /holds) -----

const pipelineBase = (orgId: string, projectId: string) => `${projectBase(orgId, projectId)}/pipeline`;
export const getPipeline = (orgId: string, projectId: string) => request<PipelineInfo>(pipelineBase(orgId, projectId));
export const holdGap = (orgId: string, projectId: string, itemId: string) =>
  request<PipelineInfo>(`${pipelineBase(orgId, projectId)}/${encodeURIComponent(itemId)}/hold`, jsonInit("POST", {}));
export const resumeGap = (orgId: string, projectId: string, itemId: string) =>
  request<PipelineInfo>(`${pipelineBase(orgId, projectId)}/${encodeURIComponent(itemId)}/resume`, jsonInit("POST", {}));
export const getGapTimeline = (orgId: string, projectId: string, itemId: string) =>
  request<PipelineTimeline>(`${pipelineBase(orgId, projectId)}/${encodeURIComponent(itemId)}/timeline`);
/** Stop a held act before it goes ahead (the operator's Cancel). */
export const cancelHeldAct = (orgId: string, holdId: string, reason?: string) =>
  request<{ ok: true }>(`/api/orgs/${encodeURIComponent(orgId)}/held/${encodeURIComponent(holdId)}/cancel`, jsonInit("POST", reason ? { reason } : {}));

// ---- a project's cost at API prices (§app/project-costs) ---------------------------------------------

export const getProjectCost = (orgId: string, projectId: string) => request<ProjectCost>(`${projectBase(orgId, projectId)}/costs`);
export const getOrgCosts = (orgId: string) => request<OrgCosts>(`/api/orgs/${encodeURIComponent(orgId)}/costs`);

// ---- a project's overseer (§app/project-overseer) ---------------------------------------------------

const overseerBase = (orgId: string, projectId: string) => `${projectBase(orgId, projectId)}/overseer`;
export const getProjectOverseer = (orgId: string, projectId: string) => request<ProjectOverseerInfo>(overseerBase(orgId, projectId));
export const openProjectOverseer = (orgId: string, projectId: string) => request<ProjectOverseerInfo>(overseerBase(orgId, projectId), jsonInit("POST"));
export const patchProjectOverseer = (orgId: string, projectId: string, patch: ProjectOverseerPatch) =>
  request<ProjectOverseerInfo>(overseerBase(orgId, projectId), jsonInit("PATCH", patch));
export const runProjectOverseer = (orgId: string, projectId: string) => request<ProjectOverseerInfo>(`${overseerBase(orgId, projectId)}/run`, jsonInit("POST"));
/** A new conversation; the current one moves to its read-only history. */
export const clearProjectOverseer = (orgId: string, projectId: string) => request<ProjectOverseerInfo>(`${overseerBase(orgId, projectId)}/clear`, jsonInit("POST"));
export const projectOverseerActions = (orgId: string, projectId: string, limit = 30) =>
  request<OverseerAction[]>(`${overseerBase(orgId, projectId)}/actions?limit=${limit}`);
export const projectOverseerIdeas = (orgId: string, projectId: string) => request<OverseerIdeasInfo>(`${overseerBase(orgId, projectId)}/ideas`);
export const addProjectOverseerIdea = (orgId: string, projectId: string, idea: { id: string; title: string }) =>
  request<OverseerIdeasInfo>(`${overseerBase(orgId, projectId)}/ideas`, jsonInit("POST", idea));
export const projectOverseerTodos = (orgId: string, projectId: string) => request<OverseerTodosInfo>(`${overseerBase(orgId, projectId)}/todos`);
export const addProjectOverseerTodo = (orgId: string, projectId: string, text: string) =>
  request<OverseerTodosInfo>(`${overseerBase(orgId, projectId)}/todos`, jsonInit("POST", { text }));
export const patchProjectOverseerTodo = (orgId: string, projectId: string, id: string, patch: TodoPatch) =>
  request<OverseerTodosInfo>(`${overseerBase(orgId, projectId)}/todo?id=${encodeURIComponent(id)}`, jsonInit("PATCH", patch));
export const sendProjectItem = (orgId: string, projectId: string, input: ItemSendInput) =>
  request<ItemSendResult>(`${overseerBase(orgId, projectId)}/items/send`, jsonInit("POST", input));
export const codeProjectItem = (orgId: string, projectId: string, input: ItemCodeInput) =>
  request<ItemCodeResult>(`${overseerBase(orgId, projectId)}/items/code`, jsonInit("POST", input));
/** New Coding Session: a coding session in its own worktree, tied to no item, with nothing sent. */
export const startProjectCoding = (orgId: string, projectId: string, input: CodingStartInput = {}) =>
  request<CodingStartResult>(`${overseerBase(orgId, projectId)}/coding`, jsonInit("POST", input));
/** The operator's gestures on a coding session's worktree: merge its branch into the root's, or remove it. */
export const mergeCodingWorktree = (orgId: string, projectId: string, sessionId: string) =>
  request<ProjectOverseerInfo>(`${overseerBase(orgId, projectId)}/worktrees/merge`, jsonInit("POST", { sessionId }));
export const removeCodingWorktree = (orgId: string, projectId: string, sessionId: string) =>
  request<ProjectOverseerInfo>(`${overseerBase(orgId, projectId)}/worktrees/remove`, jsonInit("POST", { sessionId }));

// ---- voice input (§chat/voice, §app.settings-dialog/voice) ---------------------------------------

/** The voice status, with the setup log after `since`; `size` also measures the voice folder. `device`: this
    device's voice id (§chat.voice/decoding), which adds its settings and calibration. */
export const getVoiceStatus = (since = 0, size = false, device?: VoiceDeviceInfo) =>
  request<VoiceStatus>(`/api/voice?since=${since}${size ? "&size=1" : ""}${device ? `&${deviceQuery(device)}` : ""}`, { cache: "no-store" });
/** Start (or resume) setup: the detected GPU backend, or the CPU. */
export const installVoice = (backend: "gpu" | "cpu" = "gpu") => request<VoiceStatus>("/api/voice/install", jsonInit("POST", { backend }));
export const cancelVoiceInstall = () => request<VoiceStatus>("/api/voice/install/cancel", jsonInit("POST"));
export const repairVoice = () => request<VoiceStatus>("/api/voice/repair", jsonInit("POST"));
export const uninstallVoice = () => request<{ freed: number }>("/api/voice", jsonInit("DELETE"));
/** Load whisper while the user speaks; failures surface on the transcribe. */
export const warmVoice = () => fetch("/api/voice/warm", { method: "POST" }).catch(() => {});
/** `device=<id>&label=<label>[&app=1]`: the id decides; the label and flag only refresh the host's record. */
const deviceQuery = (d: VoiceDeviceInfo) => `device=${encodeURIComponent(d.id)}&label=${encodeURIComponent(d.label)}${d.app ? "&app=1" : ""}`;
const wavInit = (method: string, wav: Uint8Array): RequestInit => ({ method, headers: { "Content-Type": "audio/wav" }, body: wav as Uint8Array<ArrayBuffer> });
/** A 16 kHz mono WAV → its text, decoded with `device`'s settings. `hint`: the session folder's name, a prompt word. */
export const transcribeVoice = (wav: Uint8Array, device: VoiceDeviceInfo, hint?: string | null) =>
  request<VoiceTranscript>(`/api/voice/transcribe?${deviceQuery(device)}${hint ? `&hint=${encodeURIComponent(hint)}` : ""}`, wavInit("POST", wav));

// Models (§app.settings-dialog/voice-models): one job at a time; the status says how it goes.
const modelPath = (id: string) => `/api/voice/models/${encodeURIComponent(id)}`;
export const downloadVoiceModel = (id: string) => request<VoiceStatus>(`${modelPath(id)}/download`, jsonInit("POST"));
export const cancelVoiceModelDownload = () => request<VoiceStatus>("/api/voice/models/cancel", jsonInit("POST"));
export const useVoiceModel = (id: string) => request<VoiceStatus>(`${modelPath(id)}/use`, jsonInit("POST"));
export const deleteVoiceModel = (id: string) => request<{ freed: number }>(modelPath(id), jsonInit("DELETE"));

// Calibration (§app.settings-dialog/voice-calibration): always one device's.
const calPath = (path: string, device: string) => `/api/voice/calibration${path}?device=${encodeURIComponent(device)}`;
/** Upload sentence `n`'s take, replacing an earlier one. */
export const putCalibrationClip = (device: VoiceDeviceInfo, n: number, wav: Uint8Array) =>
  request<VoiceStatus>(`/api/voice/calibration/clips/${n}?${deviceQuery(device)}`, wavInit("PUT", wav));
export const deleteCalibrationClips = (device: string) => request<VoiceStatus>(calPath("/clips", device), jsonInit("DELETE"));
export const runCalibration = (info: VoiceDeviceInfo) => request<VoiceStatus>(calPath("/run", info.id), jsonInit("POST", { device: info }));
export const stopCalibration = (device: string) => request<VoiceStatus>(calPath("/stop", device), jsonInit("POST"));
/** Save a results row as this device's settings for the active model. */
export const applyCalibration = (info: VoiceDeviceInfo, key: string) => request<VoiceStatus>(calPath("/apply", info.id), jsonInit("POST", { device: info, key }));
export const revertCalibration = (info: VoiceDeviceInfo) => request<VoiceStatus>(calPath("/revert", info.id), jsonInit("POST", { device: info }));
/** Forget a device: its settings, clips and runs. */
export const forgetVoiceDevice = (id: string) => request<VoiceStatus>(`/api/voice/devices/${encodeURIComponent(id)}`, jsonInit("DELETE"));

// ---- preview links (§mesh.public/preview): this host's own, never a peer's ----------------------------

export const getPreviews = (orgId?: string, projectId?: string) =>
  request<PreviewList>(`/api/previews${orgId && projectId ? `?orgId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projectId)}` : ""}`, { cache: "no-store" });
export const mintPreview = (body: PreviewMint) => request<PreviewMinted>("/api/previews", jsonInit("POST", body));
export const turnOffPreview = (id: string) => request<PreviewView>(`/api/previews/${encodeURIComponent(id)}/off`, jsonInit("POST", {}));
export const extendPreview = (id: string, days: number) => request<PreviewView>(`/api/previews/${encodeURIComponent(id)}/extend`, jsonInit("POST", { days }));
