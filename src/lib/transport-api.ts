// The page's calls for Transport (§app/transport): this host's own routes only (server/transport/routes.ts).

export interface TransportPreview {
  chat: { id: string; title: string; path: string };
  refusal: string | null;
  devices: { id: string; label: string; state: "ready" | "offline" | "update" | "no-grant" }[];
  folder: string;
  travels: { conversationBytes: number; code: { branch: string | null; bytes: number }[]; helpers: number; scratch: { dir: string; size: number }[] };
  privateFiles: { tree: string; path: string; size: number }[];
  large: { tree: string; path: string; size: number }[];
  staysHere: { left: string[]; leftBytes: number; jobs: string[]; copies?: string[] };
  busyHelpers: { id: string; name: string; role?: string }[];
  needs: string[];
  /** That device lacks the project and can't clone it: it comes from this device, about this many bytes of history. */
  projectFromHere?: { bytes: number };
  /** With the project from here: what its setup definition says that device lacks, set up after it arrives. */
  afterArrival?: string[];
  agentModels: string[];
  agentModelDefault: string | null;
}

export interface TransportView {
  tid: string;
  side: "source" | "destination";
  mode: "move" | "copy";
  chatId: string;
  peer: string;
  peerLabel: string;
  state: "preparing" | "waiting-helpers" | "packing" | "sending" | "checking" | "switching" | "done" | "needs-you" | "cancelled";
  steps: Record<string, string>;
  needsYou?: { reason: string };
  pkg?: { size: number };
  received?: number;
  ext?: {
    waiting?: number;
    /** The Transport agent, as this device knows it (the source keeps what the destination reports). */
    agent?: { sessionId: string; path: string; title: string; device?: string; state: "working" | "ready" | "needs-you"; checks: { id: string; ok: boolean; detail: string }[] };
    /** What the agent sets up there after arrival (short names): done reads "…; setting up … there". */
    settingUp?: string[];
    /** Here, after arrival: each host value this device lacks for the project, prefilled with the source's value. */
    hostAsk?: { name: string; value: string }[];
    /** Here, after arrival: why the agent couldn't start (this device can't confine it). */
    agentBlocked?: string;
  };
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const transportPreview = (path: string, peer?: string) =>
  call<TransportPreview>(`/api/transport/preview?path=${encodeURIComponent(path)}${peer ? `&peer=${encodeURIComponent(peer)}` : ""}`);

export const startTransport = (body: { path: string; peer: string; mode: "move" | "copy"; folder: string; untick: string[]; include: string[]; busyChoice?: "safe" | "interrupt"; agentModel?: string }) =>
  call<{ tid: string; transport: TransportView }>("/api/transport", { method: "POST", body: JSON.stringify(body) });

export const transportOf = (tid: string) => call<TransportView>(`/api/transport/${encodeURIComponent(tid)}`);

/** The card's Save: the host values it asks for, written into this device's host.json for the project (your click). */
export const saveTransportHostValues = (tid: string, values: Record<string, string>) =>
  call<{ ok: boolean; left: { name: string; value: string }[] }>(`/api/transport/${encodeURIComponent(tid)}/host-values`, { method: "POST", body: JSON.stringify({ values }) });

export const transportAct = (tid: string, act: "retry" | "cancel" | "interrupt") => call<{ ok: boolean }>(`/api/transport/${encodeURIComponent(tid)}/${act}`, { method: "POST", body: "{}" });

/** "4.2 MB", "340 KB", "12 bytes". */
export function sizeText(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? "" : "s"}`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export interface BackState {
  can: "move" | "copy" | null;
  reason?: string;
  peer: string;
  to: string;
  path?: string;
}

export const transportBack = (tid: string) => call<BackState>(`/api/transport/${encodeURIComponent(tid)}/back`);
export const moveBack = (tid: string) => call<{ ok: boolean }>(`/api/transport/${encodeURIComponent(tid)}/move-back`, { method: "POST", body: "{}" });
export const transportsOf = (sessionId: string) => call<{ transports: TransportView[] }>(`/api/transport?session=${encodeURIComponent(sessionId)}`);
