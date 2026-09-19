import type { SessionSummary, TranscriptItem } from "../../shared/protocol";

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

export const createSession = (cwd: string) =>
  request<SessionSummary>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });

export const fetchTranscript = (path: string) =>
  request<{ items: TranscriptItem[] }>(`/api/transcript?path=${encodeURIComponent(path)}`).then((r) => r.items);

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
