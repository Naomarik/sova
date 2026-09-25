// The connection indicator of a remote session. The remote extension reports with
// setStatus("remote-status", <JSON>); this module parses that text and turns it into what the chips say.
// It only repeats what the extension knows: "connected" needs a real round trip, a failure says
// "unreachable" with the error's first line, nothing yet says "checking…", never green.

import { createSignal } from "solid-js";
import { clockTime, duration } from "./format";
import { remotePlaceOf } from "./remote-session";

export type RemoteState = "online" | "unreachable" | "unknown";
/** "rate-limited": the host refused the channel's fresh ssh login; per-call ssh (the master) still works. */
export type ChannelState = "off" | "warming" | "idle" | "busy" | "dead" | "rate-limited";

export interface RemoteStatus {
  state: RemoteState;
  host?: string;
  latencyMs?: number;
  /** Whether the fast command channel is up and pinned to this session. */
  pinned: boolean;
  channelState?: ChannelState;
  /** Epoch ms (reporter's clock) when a rate-limited channel may be tried again. */
  channelRetryAt?: number;
  /** Epoch ms of the last successful round trip; 0 when there never was one. */
  lastOkAt: number;
  /** How long the command in flight had been running when this status was produced. */
  runningMs?: number;
  /** First line of the last failure's message. */
  error?: string;
  /** Epoch ms this status was produced (running time ticks on from here between reports). */
  at?: number;
}

const STATES: readonly string[] = ["online", "unreachable", "unknown"];
const CHANNEL_STATES: readonly string[] = ["off", "warming", "idle", "busy", "dead", "rate-limited"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const firstLine = (s: string) => s.split("\n", 1)[0]!.trim();

/** The extension's status text, or null when it isn't the JSON shape (an older plain-text status). */
export function parseRemoteStatus(raw: unknown): RemoteStatus | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.state !== "string" || !STATES.includes(o.state)) return null;
  const error = text(o.error);
  return {
    state: o.state as RemoteState,
    host: text(o.host),
    latencyMs: num(o.latencyMs),
    pinned: o.pinned === true,
    channelState: typeof o.channelState === "string" && CHANNEL_STATES.includes(o.channelState) ? (o.channelState as ChannelState) : undefined,
    channelRetryAt: num(o.channelRetryAt),
    lastOkAt: num(o.lastOkAt) ?? 0,
    runningMs: num(o.runningMs),
    error: error && firstLine(error),
    at: num(o.at),
  };
}

// ---- The store: one entry per open remote chat in this tab --------------------------------------

export interface RemoteEntry {
  target: string;
  /** Null until the extension's first report. */
  status: RemoteStatus | null;
  /** When the entry was opened (for "no status yet") or its last report arrived. */
  since: number;
  receivedAt: number | null;
  /** Check-now and reconnect, present only while the chat's runtime offers the command. */
  controls?: RemoteControls;
}

export interface RemoteControls {
  /** An explicit round trip; the extension reports the result. False when the socket is down. */
  check(): boolean;
  /** Drop a wedged channel and re-probe. */
  reconnect(): boolean;
}

/** The setStatus key carrying the JSON ("remote" itself is the TUI footer's human text). */
export const REMOTE_STATUS_KEY = "remote-status";

/** The extension's command (`/remote check`, `/remote reconnect`), sent as an ordinary prompt:
    the server runs extension commands at once, even mid-turn. */
export const REMOTE_COMMAND = "remote";
export const REMOTE_CHECK_TEXT = `/${REMOTE_COMMAND} check`;
export const REMOTE_RECONNECT_TEXT = `/${REMOTE_COMMAND} reconnect`;
/** Re-publish the current status (no ssh, no toast): sent once per socket hello. */
export const REMOTE_STATUS_TEXT = `/${REMOTE_COMMAND} status`;

/**
 * When to send `/remote status`: at most once per socket hello, and only once the runtime's
 * `commands` list offers the command (a runtime without the extension would answer with a toast).
 * A `commands` message with no hello before it (a runtime reload) asks nothing: the reload's own
 * session_start reports.
 */
export function remoteStatusAsker(isRemote: boolean) {
  let armed = false;
  return {
    hello() {
      armed = isRemote;
    },
    /** True exactly when this `commands` message should trigger the ask. */
    commands(list: readonly { name: string }[]): boolean {
      if (!armed || !list.some((c) => c.name === REMOTE_COMMAND)) return false;
      armed = false;
      return true;
    },
  };
}

const [entries, setEntries] = createSignal<Record<string, RemoteEntry>>({});

/** A remote chat opened: until the extension reports, its chips say "checking…". */
export function openRemoteStatus(path: string, target: string, now = Date.now()) {
  setEntries((m) => ({ ...m, [path]: { target, status: null, since: now, receivedAt: null } }));
}

/** A report arrived (text that isn't the JSON shape is ignored: it can't be read honestly). */
export function reportRemoteStatus(path: string, raw: unknown, now = Date.now()) {
  const status = parseRemoteStatus(raw);
  if (!status) return;
  setEntries((m) => (m[path] ? { ...m, [path]: { ...m[path]!, status, receivedAt: now } } : m));
}

export function setRemoteControls(path: string, controls: RemoteControls | undefined) {
  setEntries((m) => (m[path] && m[path]!.controls !== controls ? { ...m, [path]: { ...m[path]!, controls } } : m));
}

/** The chat closed: nothing reports for it anymore, so nothing is shown for it. */
export function closeRemoteStatus(path: string) {
  setEntries((m) => {
    if (!m[path]) return m;
    const next = { ...m };
    delete next[path];
    return next;
  });
}

export const remoteStatusOf = (path: string): RemoteEntry | undefined => entries()[path];

/** The freshest report for a target across this tab's open chats (the sidebar group's dot). */
export function remoteStatusOfTarget(target: string): RemoteEntry | undefined {
  let best: RemoteEntry | undefined;
  for (const e of Object.values(entries())) {
    if (e.target !== target) continue;
    if (!best || (e.receivedAt ?? 0) > (best.receivedAt ?? 0)) best = e;
  }
  return best;
}

// ---- What the chips say --------------------------------------------------------------------------

/** A success older than this is shown as old, not as a current "connected" (matches the channel's idle close). */
export const REMOTE_STALE_MS = 120_000;
/** With no report at all after this long, "checking…" would be a claim: say there's no status. */
export const REMOTE_SILENT_MS = 30_000;

export interface RemoteView {
  /** "connected" | "last ok" | "unreachable" | "checking…" | "no status". */
  word: string;
  /** Hue for the dot; undefined = neutral. Green only for a fresh, real round trip. */
  tone?: "success" | "error";
  host?: string;
  /** "42s ago" — the age of the last successful call; "never" when there was none. */
  age?: string;
  /** "running 12s" while a command is in flight. Never "hung": a hung call looks like a slow one. */
  running?: string;
  error?: string;
  /** A channel condition worth a line of its own in the pane (today only rate-limited):
      "rate-limited (ssh refused) · retry in 12s". Not a failure: the dot's tone ignores it. */
  channel?: string;
  /** The hover text: latency, the fast channel, the last success. */
  title: string;
}

const CHANNEL_WORDS: Record<ChannelState, string> = {
  off: "off",
  warming: "warming up",
  idle: "idle",
  busy: "busy",
  dead: "dropped",
  "rate-limited": "rate-limited (ssh refused)",
};

export function remoteView(entry: RemoteEntry, now = Date.now()): RemoteView {
  const s = entry.status;
  if (!s) {
    const silent = now - entry.since >= REMOTE_SILENT_MS;
    return {
      word: silent ? "no status" : "checking…",
      title: silent
        ? `No status from the remote extension in ${duration(now - entry.since)}. Nothing is known about ${entry.target}.`
        : `Waiting for the first report on ${entry.target}.`,
    };
  }
  // Ages are measured on the reporter's clock (`at`) plus the time since the report landed here,
  // so a phone whose clock is off from the server's doesn't make an old success look fresh.
  const sinceReport = Math.max(0, now - (entry.receivedAt ?? now));
  const reporterNow = s.at !== undefined ? s.at + sinceReport : now;
  const age = s.lastOkAt > 0 ? `${duration(reporterNow - s.lastOkAt)} ago` : "never";
  const running = s.runningMs !== undefined ? `running ${duration(s.runningMs + sinceReport)}` : undefined;
  // Rate-limited: per-call ssh still works, so it's a line of its own, never the chip's word or hue.
  const channel =
    s.channelState === "rate-limited"
      ? `${CHANNEL_WORDS["rate-limited"]} · ${
          s.channelRetryAt !== undefined && s.channelRetryAt > reporterNow ? `retry in ${duration(s.channelRetryAt - reporterNow)}` : "retry on next call"
        }`
      : undefined;
  const lines: string[] = [];
  if (s.host) lines.push(`${entry.target} (${s.host})`);
  else lines.push(entry.target);
  if (s.latencyMs !== undefined) lines.push(`Latency ${Math.round(s.latencyMs)} ms`);
  lines.push(
    channel
      ? `Fast channel ${channel}; calls use per-call ssh`
      : s.pinned
      ? `Fast channel pinned${s.channelState ? `, ${CHANNEL_WORDS[s.channelState]}` : ""}`
      : `Fast channel not pinned${s.channelState && s.channelState !== "off" ? ` (${CHANNEL_WORDS[s.channelState]})` : ""}; calls use per-call ssh`,
  );
  lines.push(s.lastOkAt > 0 ? `Last successful call ${age}, at ${clockTime(s.lastOkAt)}` : "No successful call yet");
  if (running) lines.push(`A command has been ${running}`);
  const base = {
    host: s.host,
    age,
    running,
    channel,
    title: lines.join("\n"),
  };
  switch (s.state) {
    case "unreachable":
      if (s.error) base.title = `${s.error}\n${base.title}`;
      return { ...base, word: "unreachable", tone: "error", error: s.error };
    case "online":
      // A success is only "connected" while it's recent; an old one says how old it is.
      return reporterNow - s.lastOkAt < REMOTE_STALE_MS ? { ...base, word: "connected", tone: "success" } : { ...base, word: "last ok" };
    default:
      return { ...base, word: "checking…" };
  }
}

/** A notify from the remote extension (its text starts "remote:"): a connection event, not a generic error. */
export const isRemoteNotice = (message: string) => /^remote\b/i.test(message.trim());

// ---- The always-on remote chip -------------------------------------------------------------------

/**
 * What the always-on remote chip says: this session is remote, and where its files live. Built from
 * the summary's own `target`/`remoteCwd` (else the placeholder cwd), so it exists the moment the
 * session does — before any status, and for a watched or TUI-owned session with no chat socket at
 * all. It is identity, never liveness.
 */
export interface RemoteIdentity {
  target: string;
  /** Absolute path on the target. Never run through tildePath: the target's $HOME isn't ours. */
  remoteCwd: string;
  /** What the chip shows: the folder on the target. */
  path: string;
}

/** The identity of a remote session, or null for an ordinary local one. */
export function remoteIdentity(s: { cwd: string; target?: string; remoteCwd?: string }): RemoteIdentity | null {
  const place = remotePlaceOf(s);
  if (!place) return null;
  return { target: place.target, remoteCwd: place.remoteCwd, path: place.remoteCwd };
}
