#!/usr/bin/env node
/**
 * pi-sessions — standalone reader for the pi live-session directory.
 *
 * Runs on plain `node` (type stripping): node builtins and the relative
 * schema/feed/focus modules only, erasable TypeScript only. The public
 * contract it emits is documented in ../public/SCHEMA.md. It never prints a
 * FocusTarget or window address outside the published record, and never
 * writes to the live directory.
 */
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import {
  defaultLiveDir, diffLive, feedState, makeHello, readLiveDir, STALE_MS,
  type FeedEvent, type FeedState, type LiveSession,
} from "../feed.ts";
import { checkFocusable, focusTarget } from "../focus.ts";
import { parseLiveRecord } from "../schema.ts";

const USAGE = `usage: pi-sessions <command> [options]

commands:
  snapshot [--include-stale]              print one snapshot event (JSON)
  watch [--heartbeats] [--snapshot-every 30s]
                                          NDJSON feed: hello, snapshot, upsert/remove
  focus <id-or-name>                      validate and focus that session's terminal
  menu [--format dmenu|json]              launcher lines "<label>\\t<id>" (default dmenu)

options:
  --dir <path>   live directory (default: $PI_SESSIONS_DIR, else $PI_CODING_AGENT_DIR/sessions/live,
                 else ~/.pi/agent/sessions/live)
  --help         show this text

Output is JSON on stdout. Exit codes: 0 ok, 1 runtime/record error, 2 usage error.
`;

class UsageError extends Error {}

type Args = { command: string; positionals: string[]; flags: Map<string, string | true> };

const VALUE_FLAGS = new Set(["--dir", "--snapshot-every", "--format"]);
const BOOL_FLAGS = new Set(["--include-stale", "--heartbeats", "--json", "--help", "-h"]);
const ALLOWED: Record<string, string[]> = {
  snapshot: ["--dir", "--include-stale", "--json"],
  watch: ["--dir", "--heartbeats", "--snapshot-every"],
  focus: ["--dir"],
  menu: ["--dir", "--format"],
};

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { positionals.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      flags.set(name, value);
    } else if (BOOL_FLAGS.has(name) && eq === -1) {
      flags.set(name, true);
    } else throw new UsageError(`unknown option ${arg}`);
  }
  if (flags.has("--help") || flags.has("-h")) throw new UsageError("");
  const command = positionals.shift();
  if (!command) throw new UsageError("");
  const allowed = ALLOWED[command];
  if (!allowed) throw new UsageError(`unknown command ${command}`);
  for (const name of flags.keys()) if (!allowed.includes(name)) throw new UsageError(`${name} is not valid for ${command}`);
  return { command, positionals, flags };
}

/** "30s", "500ms", "2m", "5000" (ms) ⇒ ms; 0 disables. */
function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (!match) throw new UsageError(`invalid duration ${text}`);
  const scale = match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 1;
  const ms = Math.round(Number(match[1]) * scale);
  if (ms !== 0 && ms < 100) throw new UsageError(`duration ${text} is below 100ms`);
  return ms;
}

function liveDir(flags: Args["flags"]): string {
  const flag = flags.get("--dir");
  if (typeof flag === "string") return flag;
  return process.env.PI_SESSIONS_DIR || defaultLiveDir();
}

let closing = false;
/** Write one line; a closed consumer (EPIPE) ends the process quietly. */
function out(value: unknown): void {
  if (closing) return;
  try {
    process.stdout.write(JSON.stringify(value) + "\n");
  } catch (error) {
    onStdoutError(error);
  }
}
function onStdoutError(error: unknown): void {
  closing = true;
  process.exit((error as { code?: string })?.code === "EPIPE" ? 0 : 1);
}

const RANK: Record<string, number> = { "needs-input": 0, error: 1, working: 2 };
const displayName = (s: LiveSession) => s.record.session.name || basename(s.record.session.cwd) || s.id;

/** Humans first: attention (needs-input, error), working by recency, the rest by name; stale last. */
function sortSessions(sessions: LiveSession[]): LiveSession[] {
  const rank = (s: LiveSession) => s.fresh ? RANK[s.state] ?? 3 : 4;
  return [...sessions].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra <= 2) {
      const d = b.record.session.lastActivity - a.record.session.lastActivity;
      if (d) return d;
    }
    return displayName(a).localeCompare(displayName(b)) || a.id.localeCompare(b.id);
  });
}

function snapshotEvent(dir: string, includeStale: boolean, now = Date.now()): FeedEvent {
  const sessions = readLiveDir(dir, now);
  return { type: "snapshot", at: now, sessions: sortSessions(includeStale ? sessions : sessions.filter(s => s.fresh)) };
}

// ── menu ────────────────────────────────────────────────────────────────────

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const LABELS: Record<string, string> = { "needs-input": "needs input", error: "error", working: "working", idle: "idle" };
/** Launcher lines are split on tab/newline: flatten them out of any text. */
const flat = (text: string) => text.replace(/[\t\r\n\u2028\u2029]+/g, " ").trim();

function menuLine(s: LiveSession, now = Date.now()): string {
  const p = s.record.presence;
  const glyph = !s.fresh ? "◌" : s.attention !== "none" ? "⚑" : s.state === "working" ? "●" : "○";
  const since = p?.activity?.since ?? p?.since;
  const label = !s.fresh ? `stale ${ago(s.age)}` : `${LABELS[s.state] ?? s.state}${since !== undefined ? ` ${ago(now - since)}` : ""}`;
  const parts = [`${glyph} ${flat(displayName(s))}`, label];
  if (p?.outline?.lastHeading) parts.push(`# ${flat(p.outline.lastHeading)}`);
  const total = p ? p.workerCounts?.total ?? p.workers.length : 0;
  if (total > 0) parts.push(`◆${s.workersWorking}/${total}`);
  return `${parts.join(" · ")}\t${s.id}`;
}

// ── focus ───────────────────────────────────────────────────────────────────

type FocusResult = { ok: true; id: string } | { ok: false; id?: string; reason: string; candidates?: { id: string; name: string }[] };
type ResolveError = Extract<FocusResult, { ok: false }>;

function resolve(query: string, sessions: LiveSession[]): LiveSession | ResolveError {
  const exact = sessions.find(s => s.id === query);
  if (exact) return exact;
  const pick = (matches: LiveSession[]): LiveSession | ResolveError | undefined => {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      // A leftover stale record never makes a live session ambiguous.
      const fresh = matches.filter(s => s.fresh);
      if (fresh.length === 1) return fresh[0];
      return { ok: false, reason: "ambiguous",
        candidates: matches.map(s => ({ id: s.id, name: s.record.session.name ?? "" })) };
    }
  };
  const lower = query.toLowerCase();
  return pick(sessions.filter(s => s.id.startsWith(query)))
    ?? pick(sessions.filter(s => s.record.session.name?.toLowerCase().includes(lower)))
    ?? { ok: false, reason: "not found" };
}

async function focus(dir: string, query: string): Promise<FocusResult> {
  const now = Date.now();
  const resolved = resolve(query, readLiveDir(dir, now));
  if ("ok" in resolved) {
    // An exact id whose file exists but fails validation is not "not found".
    if (resolved.reason === "not found" && /^[^/\\.][^/\\]*$/.test(query) && existsSync(join(dir, `${query}.json`)))
      return { ok: false, id: query, reason: "record is unreadable or invalid" };
    return resolved;
  }
  const s = resolved, id = s.id;
  if (!s.fresh) {
    return { ok: false, id, reason: s.age > STALE_MS ? `stale (no heartbeat for ${ago(s.age)})` : "session process is not running" };
  }
  const gate = checkFocusable(s.record.presence);
  if (!gate.ok) return { ok: false, id, reason: gate.reason ?? "not focusable" };
  const target = s.record.presence!.target!;
  if (target.origin.pid !== s.record.session.pid) return { ok: false, id, reason: "focus target does not belong to this session's process" };
  try {
    await focusTarget(target);
  } catch (error) {
    return { ok: false, id, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, id };
}

// ── watch ───────────────────────────────────────────────────────────────────

function watchFeed(dir: string, heartbeats: boolean, snapshotEvery: number): void {
  let prev: FeedState = new Map();
  const reported = new Set<string>(); // malformed file names already announced
  let dirError = false;
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;

  const error = (message: string) => out({ type: "error", at: Date.now(), message });

  /** Valid sessions plus the names of *.json files that exist but don't validate. */
  const scan = (now: number): { sessions: LiveSession[]; invalid: Set<string> } | undefined => {
    let names: string[];
    try {
      names = readdirSync(dir);
      dirError = false;
    } catch (e) {
      if (!dirError) error(e instanceof Error ? e.message : String(e));
      dirError = true;
      return;
    }
    const sessions = readLiveDir(dir, now);
    const valid = new Set(sessions.map(s => `${s.id}.json`));
    const invalid = new Set<string>();
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".json") || valid.has(name)) continue;
      try {
        const record = parseLiveRecord(JSON.parse(readFileSync(join(dir, name), "utf8")), now);
        if (record && `${record.session.id}.json` === name) continue; // became valid mid-scan
      } catch (e) {
        if ((e as { code?: string })?.code === "ENOENT") continue; // vanished mid-scan
      }
      invalid.add(name);
    }
    return { sessions, invalid };
  };

  const track = (invalid: Set<string>) => {
    for (const name of invalid) if (!reported.has(name)) { reported.add(name); error(`invalid record: ${name}`); }
    for (const name of reported) if (!invalid.has(name)) reported.delete(name);
  };

  const emitSnapshot = () => {
    const now = Date.now();
    const result = scan(now);
    const sessions = result?.sessions ?? [];
    if (result) track(result.invalid);
    out({ type: "snapshot", at: now, sessions: sortSessions(sessions.filter(s => s.fresh)) });
    prev = feedState(sessions);
  };

  const tick = () => {
    if (closing) return;
    ensureWatcher();
    const now = Date.now();
    const result = scan(now);
    if (!result) return;
    track(result.invalid);
    for (const event of diffLive(prev, result.sessions, now)) {
      if (event.type === "remove" && event.reason === "left" && result.invalid.has(`${event.id}.json`)) out({ ...event, reason: "invalid" });
      else out(event);
    }
    if (heartbeats) {
      for (const s of result.sessions) {
        const old = prev.get(s.id);
        if (!s.fresh || !old?.fresh || old.record.heartbeat === s.record.heartbeat) continue;
        // diffLive already announced any content change for this id.
        if (feedState([s]).get(s.id)!.hash !== old.hash) continue;
        const changed = ["heartbeat"];
        if (old.record.session.lastActivity !== s.record.session.lastActivity) changed.push("session.lastActivity");
        out({ type: "upsert", at: now, session: s, changed });
      }
    }
    prev = feedState(result.sessions);
  };

  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = undefined; tick(); }, 50);
  };

  function ensureWatcher(): void {
    if (watcher) return;
    try {
      watcher = watch(dir, { persistent: false }, schedule);
      watcher.on("error", () => { watcher?.close(); watcher = undefined; schedule(); });
    } catch { /* missing dir or no inotify: the poll covers it and retries */ }
  }

  const stop = () => { closing = true; watcher?.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  out(makeHello(dir));
  ensureWatcher();
  emitSnapshot();
  setInterval(tick, 2000);
  if (snapshotEvery > 0) setInterval(emitSnapshot, snapshotEvery);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const dir = liveDir(args.flags);
  switch (args.command) {
    case "snapshot":
      if (args.positionals.length) throw new UsageError("snapshot takes no arguments");
      out(snapshotEvent(dir, args.flags.has("--include-stale")));
      return 0;
    case "menu": {
      if (args.positionals.length) throw new UsageError("menu takes no arguments");
      const format = args.flags.get("--format") ?? "dmenu";
      if (format !== "dmenu" && format !== "json") throw new UsageError(`unknown format ${format}`);
      const now = Date.now();
      const sessions = sortSessions(readLiveDir(dir, now).filter(s => s.fresh));
      if (format === "json") out(sessions);
      else for (const s of sessions) process.stdout.write(menuLine(s, now) + "\n");
      return 0;
    }
    case "focus": {
      if (args.positionals.length !== 1 || !args.positionals[0]) throw new UsageError("focus needs exactly one <id-or-name>");
      const result = await focus(dir, args.positionals[0]);
      out(result);
      return result.ok ? 0 : 1;
    }
    case "watch": {
      if (args.positionals.length) throw new UsageError("watch takes no arguments");
      const every = args.flags.get("--snapshot-every");
      watchFeed(dir, args.flags.has("--heartbeats"), typeof every === "string" ? parseDuration(every) : 0);
      return -1; // keeps running
    }
  }
  throw new UsageError(`unknown command ${args.command}`);
}

process.stdout.on("error", onStdoutError);
main(process.argv.slice(2)).then(code => {
  if (code >= 0) process.exitCode = code;
}, (error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write((error.message ? `pi-sessions: ${error.message}\n\n` : "") + USAGE);
    process.exitCode = 2;
  } else {
    out({ type: "error", at: Date.now(), message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
});
