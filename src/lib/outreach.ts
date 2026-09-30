import { createSignal } from "solid-js";
import type { OutreachFile, OutreachInfo, OutreachPatch, SenderRoute, SenderState } from "../../shared/outreach";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Outreach (§app.settings-dialog/outreach): the API client, the staged Sender and Accept
 * sends from (settings-draft.ts: saved by the dialog's Save Changes), and the words for the sender's
 * state. Main listener only, so plain fetches, not api.ts's peer-routed `request`.
 */

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("The Sova server isn't reachable.");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Non-JSON error body: keep the status line.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const getOutreach = () => call<OutreachInfo>("/api/outreach", { cache: "no-store" });
export const putOutreach = (patch: OutreachPatch) => call<OutreachInfo>("/api/outreach", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });

export type SenderChoice = "off" | "local" | "via";

export interface OutreachDraft {
  sender: SenderChoice;
  socket: string;
  viaNodeId: string;
  acceptFrom: "all" | string[];
}

export function outreachDraftOf(f: OutreachFile): OutreachDraft {
  const s = f.sender;
  return {
    sender: s === "off" ? "off" : "local" in s ? "local" : "via",
    socket: typeof s === "object" && "local" in s ? (s.local.socket ?? "") : "",
    viaNodeId: typeof s === "object" && "via" in s ? s.via.nodeId : "",
    acceptFrom: f.acceptFrom === "all" ? "all" : [...f.acceptFrom],
  };
}

export function routeOf(d: OutreachDraft): SenderRoute {
  if (d.sender === "local") return { local: d.socket.trim() ? { socket: d.socket.trim() } : {} };
  if (d.sender === "via") return { via: { nodeId: d.viaNodeId } };
  return "off";
}

const sameAccept = (a: "all" | string[], b: "all" | string[]) => (a === "all" || b === "all" ? a === b : a.length === b.length && [...a].sort().join() === [...b].sort().join());

export const sameOutreach = (d: OutreachDraft, f: OutreachFile): boolean => JSON.stringify(routeOf(d)) === JSON.stringify(f.sender) && sameAccept(d.acceptFrom, f.acceptFrom);

/** Why the draft can't be saved, or null. */
export function outreachProblem(d: OutreachDraft): string | null {
  if (d.sender === "via" && !d.viaNodeId) return "Pick the peer the sender runs on.";
  if (d.sender === "local" && d.socket.trim() && !d.socket.trim().startsWith("/")) return "The socket path must be absolute.";
  return null;
}

/** The sender's state in words (a chip and a sentence), as Settings shows it. */
export function senderWords(state: SenderState, why?: string): { chip: string; tone: "success" | "warn" | "info" | undefined; text: string } {
  switch (state) {
    case "off":
      return { chip: "Off", tone: undefined, text: "Nothing is sent from this host." };
    case "unreachable":
      return { chip: "Not reachable", tone: "warn", text: `Not reachable: ${why ?? "the sender doesn't answer."}` };
    case "open":
      return { chip: "Connected", tone: "success", text: "Connected: sends go at once." };
    case "connecting":
      return { chip: "Connecting", tone: "info", text: why ?? "Connecting to WhatsApp." };
    case "unpaired":
    case "linking":
      return { chip: "Not paired", tone: "warn", text: "Pair it on the sender's host: sova-whatsapp pair." };
    case "logged-out":
      return { chip: "Logged out", tone: "warn", text: "Pair it again on the sender's host: sova-whatsapp pair." };
    case "replaced":
      return { chip: "Replaced", tone: "warn", text: "Another copy of the sender took over this number." };
    case "blocked":
      return { chip: "Blocked", tone: "warn", text: why ?? "WhatsApp refused the account; sending is paused." };
    case "down":
      return { chip: "Down", tone: "warn", text: why ? `${why} Reconnect it on the sender's host.` : "Reconnect it on the sender's host." };
  }
}

const [info, setInfo] = createSignal<OutreachInfo | null>(null);
export const outreachInfo = info;
export const setOutreachInfo = setInfo;

const store = createDraftStore<OutreachDraft, OutreachFile, OutreachInfo>({
  tab: "outreach",
  label: "Outreach",
  toDraft: outreachDraftOf,
  same: sameOutreach,
  problem: (d) => {
    const p = outreachProblem(d);
    return p ? `Outreach: ${p}` : null;
  },
  write: async (d) => {
    const next = await putOutreach({ sender: routeOf(d), acceptFrom: d.acceptFrom });
    setInfo(next);
    return { saved: next.file, result: next };
  },
  onReset: () => setInfo(null),
});

/** A GET answer arrived: the draft store follows it. */
export function acceptOutreachInfo(next: OutreachInfo): void {
  setInfo(next);
  store.setSaved(next.file);
}

export const outreachDraft = store.draft;
export const setOutreachDraft = store.setDraft;
export const outreachSaving = store.saving;
export const outreachSaveError = store.error;
