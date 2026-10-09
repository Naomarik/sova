import { createSignal } from "solid-js";
import type { OutreachFile, OutreachInfo, OutreachPatch, SenderEntry, SenderLinkView, SenderList, SenderRoute, SenderStatus } from "../../shared/outreach";
import { relativeIn, stampTime } from "./format";
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

/** The sender's controls (§app.outreach/sender-controls): each answers the page's info afresh. */
const post = (op: "reconnect" | "pause" | "start", body: unknown = {}) =>
  call<OutreachInfo>(`/api/outreach/sender/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const reconnectSender = () => post("reconnect");
export const pauseSender = (on: boolean) => post("pause", { on });
export const startSender = () => post("start");

/** Linking a phone (§app.outreach/sender-link): the answer carries the newest QR or code, never cached. */
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const startLink = (phone?: string) => call<SenderLinkView>("/api/outreach/sender/link", json(phone ? { phone } : {}));
export const getLink = () => call<SenderLinkView>("/api/outreach/sender/link", { cache: "no-store" });
export const cancelLink = () => call<SenderLinkView>("/api/outreach/sender/link/cancel", json({}));
export const unlinkSender = (confirm: string) => call<OutreachInfo>("/api/outreach/sender/unlink", json({ confirm }));
/** The phone number a pairing code is for: digits only, country code first. */
export const PHONE_DIGITS = /^\d{7,15}$/;

/** The senders this host can use (§app.outreach/sender-list). */
export const getSenders = () => call<SenderList>("/api/outreach/senders", { cache: "no-store" }).then((l) => l.senders);

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

/** When the next automatic attempt is: "2:32 PM, in 12m" (with the day when it isn't today). */
const nextTry = (retryAt: string, now: number) => {
  const rel = relativeIn(retryAt, now);
  return `${stampTime(retryAt, now)}${rel ? `, ${rel}` : ""}`;
};

/**
 * The sender's state in words (a chip and a sentence), as Settings shows it: why it stopped and when it
 * tries again. `here`: the sender is this host's own, so linking a phone is this page's to offer.
 */
export function senderWords(s: Pick<SenderStatus, "state" | "why" | "retryAt" | "paused">, now = Date.now(), here = false): { chip: string; tone: "success" | "warn" | "info" | undefined; text: string } {
  const why = s.why;
  switch (s.state) {
    case "off":
      return { chip: "Off", tone: undefined, text: "Nothing is sent from this host." };
    case "unreachable":
      return { chip: "Not reachable", tone: "warn", text: `Not reachable: ${why ?? "the sender doesn't answer."}` };
    case "open":
      return s.paused
        ? { chip: "Paused", tone: "warn", text: "Connected, but the sender is paused: every send through it is refused until it is resumed." }
        : { chip: "Connected", tone: "success", text: "Connected: sends go at once." };
    case "connecting":
      if (s.retryAt) return { chip: "Reconnecting", tone: "info", text: `${why ?? "The connection closed."} It tries again at ${nextTry(s.retryAt, now)}.` };
      return { chip: "Connecting", tone: "info", text: why ?? "Connecting to WhatsApp." };
    case "linking":
      return { chip: "Linking", tone: "info", text: why ?? "Waiting for the phone to link this device." };
    case "unpaired":
      return here
        ? { chip: "Not paired", tone: "warn", text: "Link a phone to send from: Link a Phone below, or sova-whatsapp pair on this host." }
        : { chip: "Not paired", tone: "warn", text: "Link a phone on the sender's host." };
    case "logged-out":
      return here
        ? { chip: "Logged out", tone: "warn", text: "The phone unlinked this device. Unlink this number, then link a phone again." }
        : { chip: "Logged out", tone: "warn", text: "Link it again on the sender's host." };
    case "replaced":
      return { chip: "Replaced", tone: "warn", text: "Another copy of the sender took over this number. Stop that copy, then reconnect." };
    case "blocked":
      // The sender's own why already says sending is paused: drop that, then say until when.
      return { chip: "Blocked", tone: "warn", text: `${(why ?? "WhatsApp refused the account.").replace(/\s*Sending is paused\.$/, "")} Sending stays paused until the sender is resumed.` };
    case "down":
      if (s.retryAt) return { chip: "Down", tone: "warn", text: `Waiting until ${nextTry(s.retryAt, now)} to reconnect. ${why ?? ""}`.trim() };
      return { chip: "Down", tone: "warn", text: `${why ?? "The sender stopped."} It won't reconnect on its own: reconnect it.` };
  }
}

/** The figures under the state: since when, the number, sends and automatic reconnects against their limits. */
export function senderFacts(s: SenderStatus, now = Date.now()): string[] {
  const out: string[] = [];
  if (s.since && s.state !== "open" && s.state !== "off") out.push(`Since ${stampTime(s.since, now)}`);
  if (s.me) out.push(`Number ${s.me}`);
  if (s.usage && s.limits) out.push(`Sends: ${s.usage.hour} of ${s.limits.perHour} this hour, ${s.usage.day} of ${s.limits.perDay} in 24 h`);
  if (s.reconnects) out.push(`Automatic reconnects: ${s.reconnects.hour} of ${s.reconnects.perHour} this hour, ${s.reconnects.day} of ${s.reconnects.perDay} in 24 h`);
  return out;
}

/** The states with a linked device: Unlink This Number clears it, logged out included (§app.outreach/sender-link). */
const LINKED: ReadonlySet<SenderStatus["state"]> = new Set(["open", "connecting", "down", "replaced", "blocked", "logged-out"]);

/**
 * Which of the sender's controls this page offers now (§app.outreach/sender-controls, /sender-link).
 * Reconnect: down, replaced, or a backoff wait; blocked only on the sender's own host, behind its
 * warning. Pause/Resume: the sender's own host, while it answers. Start: the sender's own host, its unit
 * installed and stopped. Link: the sender's own host, unpaired. Unlink: the sender's own host, linked.
 */
export function senderActions(info: Pick<OutreachInfo, "file" | "sender" | "unit">): {
  reconnect: false | "plain" | "blocked";
  pause: null | "pause" | "resume";
  start: boolean;
  link: boolean;
  unlink: boolean;
} {
  const route = info.file.sender;
  const local = typeof route === "object" && "local" in route;
  const via = typeof route === "object" && "via" in route;
  const s = info.sender;
  const waiting = s.state === "down" || s.state === "replaced" || (s.state === "connecting" && !!s.retryAt);
  const reconnect = local && s.state === "blocked" ? "blocked" : (local || via) && waiting ? "plain" : false;
  const pause = local && s.state !== "off" && s.state !== "unreachable" ? (s.paused ? "resume" : "pause") : null;
  const start = local && s.state === "unreachable" && !!info.unit && (info.unit.active === "inactive" || info.unit.active === "failed");
  return { reconnect, pause, start, link: local && s.state === "unpaired", unlink: local && LINKED.has(s.state) };
}

/** A sender's use against its limits, for its row in the list: "4 of 60 sent in 24 h, 1 of 20 this hour". */
export function senderUse(s: SenderStatus): string | null {
  if (!s.usage || !s.limits) return null;
  return `${s.usage.day} of ${s.limits.perDay} sent in 24 h, ${s.usage.hour} of ${s.limits.perHour} this hour`;
}

/** The draft's choice for an entry of the list, and whether the draft has picked it. */
export const entryChoice = (e: SenderEntry): Pick<OutreachDraft, "sender" | "viaNodeId"> =>
  e.where === "local" ? { sender: "local", viaNodeId: "" } : { sender: "via", viaNodeId: e.nodeId ?? "" };
export const entryPicked = (e: SenderEntry, d: OutreachDraft | null | undefined): boolean =>
  !!d && (e.where === "local" ? d.sender === "local" : d.sender === "via" && d.viaNodeId === e.nodeId);

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
