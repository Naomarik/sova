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

/** The Transport agent as its card shows it, with what it asks you (§app.transport/agent). */
export interface TransportAgentView {
  sessionId: string;
  path: string;
  title: string;
  device?: string;
  state: "working" | "ready" | "needs-you";
  checks: { id: string; ok: boolean; detail: string }[];
  /** Its download list: each tool, its version and the site it comes from; asked until your Allow. */
  downloads?: { id: string; items: { tool: string; version: string; host: string }[]; why?: string; state: "asked" | "allowed" };
  /** Commands for you to run yourself, asked until your Done: needing administrator rights, or (`kind` "path") putting a
      program on your PATH, which the agent's sandbox never writes. */
  admin?: { id: string; kind?: "path"; command: string; why?: string; state: "asked" | "done" }[];
  /** Files the project needs that live outside it on the device the chat came from (`from`), as `~/…` in its home and
      here; asked until your Bring From (brought, or kept when one was already here) or I Placed It Myself. */
  outside?: { id: string; path: string; folder: string; why?: string; from: string; state: "asked" | "brought" | "kept" | "placed" }[];
}

/** The arrived chat's running copy (§app.transport/agent "Ready means the app runs"): `waiting` until the rest here is
    set up, `none` when the project has no running-copy definition (no copy was started). */
export interface TransportCopyView {
  state: "waiting" | "starting" | "running" | "failed" | "none";
  copies: { name: string; ok: boolean; detail: string; entry?: { endpoint: string; port: number; path: string } }[];
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
    /** A Move waited for busy helpers (its dialog keeps that step). */
    waitedHelpers?: boolean;
    /** The newest readings of the bytes that device held while it pulled, each with when this device read it. */
    sent?: { at: number; n: number }[];
    /** The Transport agent, as this device knows it (the source keeps what the destination reports). */
    agent?: TransportAgentView;
    /** What the agent sets up there after arrival (short names): done reads "…; setting up … there". */
    settingUp?: string[];
    /** Here, after arrival: each host value this device lacks for the project, prefilled with the source's value. */
    hostAsk?: { name: string; value: string }[];
    /** Here, after arrival: why the agent couldn't start (this device can't confine it). */
    agentBlocked?: string;
    /** Here, after arrival: the chat's running copy, which its card links to once it runs. */
    copy?: TransportCopyView;
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

/** The card's Allow Downloads (your click): the agent may download exactly what its list names. */
export const allowTransportDownloads = (tid: string, plan: string) =>
  call<{ ok: boolean; agent?: TransportAgentView }>(`/api/transport/${encodeURIComponent(tid)}/allow-downloads`, { method: "POST", body: JSON.stringify({ plan }) });

/** The card's Done (your click): you ran the command the agent can't run itself. */
export const transportAdminDone = (tid: string, step: string) =>
  call<{ ok: boolean; agent?: TransportAgentView }>(`/api/transport/${encodeURIComponent(tid)}/admin-done`, { method: "POST", body: JSON.stringify({ step }) });

/** The card's Bring From {device} (your click): that one file, from the device it lives on, to the same path here. */
export const bringTransportFile = (tid: string, file: string) =>
  call<{ ok: boolean; agent?: TransportAgentView }>(`/api/transport/${encodeURIComponent(tid)}/bring-file`, { method: "POST", body: JSON.stringify({ file }) });

/** The card's I Placed It Myself (your click): you put the file there yourself. */
export const transportFilePlaced = (tid: string, file: string) =>
  call<{ ok: boolean; agent?: TransportAgentView }>(`/api/transport/${encodeURIComponent(tid)}/placed-file`, { method: "POST", body: JSON.stringify({ file }) });

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
