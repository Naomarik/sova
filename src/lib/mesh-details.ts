// The mesh details modal and the sidebar's host menu (components/MeshDetails.tsx, MeshHostMenu.tsx):
// their open state, the counts the menu shows, and the words the modal says about each host. Pure
// apart from the two signals, so node tests run it without a DOM.

import { createSignal } from "solid-js";
import type { HostDetails, MeshHostDetails } from "../../shared/mesh-details";
import type { PeerStatus } from "../../shared/protocol";
import { duration, relativeTime, shortDate } from "./format";

export type { HostDetails, HostRenameResult, MeshDetails, MeshHostDetails } from "../../shared/mesh-details";

const [open, setOpen] = createSignal(false);
/** The modal is open (it polls only then). */
export const meshDetailsOpen = open;
export const openMeshDetails = (): void => {
  setOpen(true);
};
export const closeMeshDetails = (): void => {
  setOpen(false);
};

/** The modal refreshes this often while open, and never while closed. */
export const DETAILS_POLL_MS = 5_000;

/** "Show this host's sessions" from the modal: the sidebar's host filter takes it (a fresh object each time). */
const [filterAsk, setFilterAsk] = createSignal<{ value: string | null } | null>(null);
export const hostFilterAsk = filterAsk;
export const askHostFilter = (value: string | null): void => {
  setFilterAsk({ value });
};

/** Hosts answering now, this host included, out of every host: "2/3 connected". */
export function connectedCount(peers: readonly Pick<PeerStatus, "state">[]): { up: number; total: number } {
  return { up: 1 + peers.filter((p) => p.state === "up").length, total: 1 + peers.length };
}

/** 1536 → "1.5 KB"; binary steps, one decimal under 10. */
export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 || v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

const PLATFORMS: Record<string, string> = { linux: "Linux", darwin: "macOS", android: "Android", win32: "Windows", freebsd: "FreeBSD" };
const DEVICES: Record<HostDetails["identity"]["device"], string> = { phone: "Phone", laptop: "Laptop", desktop: "Desktop", server: "Server", unknown: "Computer" };

/** "Laptop · Linux 6.9 (x64)"; a phone's Linux kernel is not its OS version, so Android says none. */
export function machineLine(d: HostDetails): string {
  const os = PLATFORMS[d.identity.platform] ?? d.identity.platform;
  const release = d.identity.platform === "android" ? "" : ` ${d.identity.osRelease.split("-")[0]}`;
  return `${DEVICES[d.identity.device] ?? "Computer"} · ${os}${release} (${d.identity.arch})`;
}

/** Why a host shows no details, in the words the modal uses. */
export function unavailableText(h: Pick<MeshHostDetails, "unavailable" | "label">): string | null {
  switch (h.unavailable) {
    case "update":
      return "Update this host to see its details.";
    case "down":
      return `${h.label} isn't answering. Its details show when it's back.`;
    case "refused":
      return `${h.label} doesn't list this host as a peer, so it won't answer.`;
    case "skewed":
      return `${h.label} runs another version of Sova.`;
    default:
      return null;
  }
}

/** The state word beside the dot: never the colour alone. */
export function stateWord(h: Pick<MeshHostDetails, "state">): string {
  return h.state === "self" ? "this host" : h.state === "up" ? "up" : h.state === "skewed" ? "other version" : h.state === "refused" ? "refused" : "down";
}

/** "up for 3h 12m" / "down for 40s" / "" when unknown. */
export function sinceLine(h: Pick<MeshHostDetails, "state" | "stateSince">, now = Date.now()): string {
  if (h.stateSince === null) return "";
  const span = duration(now - h.stateSince);
  return h.state === "up" || h.state === "self" ? `up for ${span}` : `not answering for ${span}`;
}

/** When it was paired, or that nobody wrote it down. */
export function joinedLine(h: Pick<MeshHostDetails, "self" | "pairedAt">, now = Date.now()): string | null {
  if (h.self) return null;
  if (h.pairedAt === null || h.pairedAt === undefined) return "Paired before dates were recorded";
  return `Paired ${shortDate(h.pairedAt, now)}`;
}

/** "1st in the front door" / "Left out of the front door". */
export function frontDoorLine(f: MeshHostDetails["frontDoor"]): string {
  if (f.excluded || f.position === null) return "Left out of the front door";
  const n = f.position;
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix} in the front door`;
}

/** "81%, charging"; a phone without Termux:API says how to get the reading. */
export function batteryLine(r: HostDetails["resources"]): string | null {
  if (r.battery) return `${r.battery.percent}%${r.battery.charging ? ", charging" : ""}`;
  if (r.batteryHint === "termux-api") return "Install the Termux:API app to see the battery.";
  return null;
}

/** "3.1 GB of 16 GB used". */
export function memoryLine(m: HostDetails["resources"]["memory"]): string {
  return `${bytes(m.total - m.available)} of ${bytes(m.total)} used`;
}

/** "8 cores · load 0.52". */
export function cpuLine(r: HostDetails["resources"]): string {
  const cores = `${r.cores} ${r.cores === 1 ? "core" : "cores"}`;
  return r.load ? `${cores} · load ${r.load[0].toFixed(2)}` : cores;
}

/** Whether a host speaks this host's wire contract (the same protocol hash). */
export function protocolLine(d: HostDetails, own: string | undefined): string {
  if (!own) return d.versions.protocol;
  return d.versions.protocol === own ? "Same as this host" : "Differs from this host";
}

/** Sync: "4 logins · 1 conflict" and each category's last sync. */
export function loginsLine(s: HostDetails["sync"]): string | null {
  if (!s.logins) return null;
  const { count, conflicts } = s.logins;
  return `${count} ${count === 1 ? "login" : "logins"}${conflicts ? ` · ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}` : ""}`;
}

/** "3 sessions · 1 turn running · 2 workers". */
export function activityLine(a: HostDetails["activity"]): string {
  const parts = [`${a.sessions} ${a.sessions === 1 ? "session" : "sessions"}`];
  if (a.turnsRunning) parts.push(`${a.turnsRunning} ${a.turnsRunning === 1 ? "turn" : "turns"} running`);
  if (a.workers) parts.push(`${a.workers} ${a.workers === 1 ? "worker" : "workers"}`);
  return parts.join(" · ");
}

/** A short commit for display. */
export const shortCommit = (sha: string | undefined): string | null => (sha ? sha.slice(0, 7) : null);

/** Whether the modal offers a rename for this host, or why not. */
export function renameRefusal(h: Pick<MeshHostDetails, "self" | "state" | "unavailable" | "label">): string | null {
  if (h.self) return null;
  if (h.unavailable === "update") return `Update ${h.label} to rename it from here.`;
  if (h.state !== "up" && h.state !== "skewed") return `${h.label} isn't answering, so it can't be renamed now.`;
  return null;
}

/** A name the server will take: 1–80 characters once trimmed; else why not. */
export function labelProblem(v: string): string | null {
  const t = v.trim();
  if (!t) return "Give it a name.";
  if (t.length > 80) return "Keep it to 80 characters.";
  return null;
}

/**
 * The label/value rows of one host's section. Each row is built on its own: a host on a later
 * build that drops or reshapes a field loses that row, never the dialog.
 */
export function detailRows(h: MeshHostDetails, ownProtocol: string | undefined, now: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const row = (label: string, value: () => string | null | undefined | false) => {
    try {
      const v = value();
      if (typeof v === "string" && v) out.push([label, v]);
    } catch {
      // a field this build doesn't know the shape of: no row
    }
  };
  const x = h.details;
  const up = h.state === "up" || h.state === "self";
  const ago = (t: number) => relativeTime(new Date(t).toISOString(), now);
  const secs = (s: number) => duration(s * 1000);
  if (x) {
    row("Machine", () => (x.identity.model ? `${machineLine(x)} · ${x.identity.model}` : machineLine(x)));
    row("Address", () => [x.identity.dnsName, ...(x.identity.addresses ?? [])].filter(Boolean).join(" · "));
    row("Sova", () => [x.versions.sova, shortCommit(x.versions.commit)].filter(Boolean).join(" · "));
    row("pi · Node", () => `${x.versions.pi} · ${x.versions.node}`);
    if (!h.self) row("Protocol", () => protocolLine(x, ownProtocol));
  }
  if (!h.self) {
    row("Connection", () => [h.latencyMs !== undefined && up ? `${h.latencyMs} ms round trip` : "", sinceLine(h, now)].filter(Boolean).join(" · "));
    if (!up && h.lastSeen) row("Last seen", () => ago(h.lastSeen!));
  }
  if (x) {
    row("Uptime", () => [`Sova ${secs(x.uptime.process)}`, typeof x.uptime.machine === "number" ? `machine ${secs(x.uptime.machine)}` : ""].filter(Boolean).join(" · "));
    row("CPU", () => cpuLine(x.resources));
    row("Memory", () => memoryLine(x.resources.memory));
    row("Disk", () => x.resources.disk && `${bytes(x.resources.disk.free)} free of ${bytes(x.resources.disk.total)}`);
    row("Battery", () => batteryLine(x.resources));
    row("Activity", () => activityLine(x.activity));
    row("Sync", () => x.sync.categories.map((s) => `${s.category} ${s.state === "ok" && s.lastAt ? ago(s.lastAt) : s.state}`).join(" · "));
    row("Logins", () => loginsLine(x.sync));
  }
  row("Front door", () => frontDoorLine(h.frontDoor));
  row("Joined", () => joinedLine(h, now));
  return out;
}
