import type {
  AgentsInsight,
  ContextInfo,
  FolderListing,
  ModeInfo,
  ModelInfo,
  SessionInsight,
  SessionSummary,
  TranscriptItem,
  UploadResult,
  UsageInsight,
} from "../../shared/protocol";

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

/** The global mode switch and what exists (GET /api/mode). */
export const getMode = () => request<ModeInfo>("/api/mode");

/** Switch the global mode; every open web chat follows from its next message. */
export const postMode = (patch: { mode?: string; minorModes?: string[] }) =>
  request<ModeInfo>("/api/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

export const createSession = (cwd: string) =>
  request<SessionSummary>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });

/** Moves a web-spawned session to the Archive region (true) or back to the top (false). */
export const setSessionArchived = (path: string, archived: boolean) =>
  request<SessionSummary>("/api/sessions/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, archived }),
  });

export const fetchTranscript = (path: string) =>
  request<{ items: TranscriptItem[] }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => r.items);

/** The transcript plus its context-window fill (null when unknown or stale). */
export const fetchTranscriptWithContext = (path: string) =>
  request<{ items: TranscriptItem[]; context: ContextInfo | null }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => ({
    items: r.items,
    context: r.context ?? null,
  }));

/** Stores an image in /tmp like a TUI clipboard paste; the prompt text then names its path. */
export const uploadImage = (file: File) =>
  request<UploadResult>("/api/upload", {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });

export const fetchUsage =() => request<UsageInsight>("/api/insights/usage");

export const fetchAgents = () => request<AgentsInsight>("/api/insights/agents");

export const fetchSessionInsight = (path: string) =>
  request<SessionInsight>(`/api/insights/session?path=${encodeURIComponent(path)}`);

/**
 * `force` (chat only) lets the server open a session whose file was written recently by
 * something that isn't a TUI. It never overrides a live TUI.
 */
export function wsUrl(endpoint: "/ws/chat" | "/ws/watch", path: string, force = false): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${endpoint}?path=${encodeURIComponent(path)}${force ? "&force=1" : ""}`;
}

/**
 * The server refuses chat (code "recent") on a file an unknown process wrote within this window
 * (RECENT_WRITE_MS in server/write-guard.ts). The server decides; this is for reference/copy.
 */
export const RECENT_WRITE_WINDOW_MS = 120_000;
