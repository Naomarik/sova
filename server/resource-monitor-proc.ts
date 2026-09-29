// Resource monitor: pure parsers for /proc and cgroup v2 files, and argv classification
// (§app/resource-monitor). No I/O here; server/resource-monitor.ts reads the files.

import type { MonitorPressure, MonitorProcKind } from "../shared/protocol";

/** The fields of /proc/<pid>/stat the monitor uses. Times are clock ticks. */
export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  pgid: number;
  sid: number;
  utime: number;
  stime: number;
  cutime: number;
  cstime: number;
  /** Clock ticks since boot. */
  starttime: number;
  /** Resident pages. */
  rss: number;
}

/**
 * Parse /proc/<pid>/stat. `comm` is in parentheses and may itself hold spaces and parentheses,
 * so the fields after it are found from the LAST ")". Null for anything malformed.
 */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  // Fields from 3 (state) on; f[0] is field 3.
  const f = text.slice(close + 2).split(" ");
  if (!Number.isInteger(pid) || f.length < 22) return null;
  const n = (i: number) => Number(f[i - 3]);
  const s: ProcStat = {
    pid, comm: text.slice(open + 1, close), state: f[0]!,
    ppid: n(4), pgid: n(5), sid: n(6),
    utime: n(14), stime: n(15), cutime: n(16), cstime: n(17),
    starttime: n(22), rss: n(24),
  };
  for (const k of ["ppid", "pgid", "sid", "utime", "stime", "cutime", "cstime", "starttime", "rss"] as const)
    if (!Number.isFinite(s[k])) return null;
  return s;
}

/** VmSwap from /proc/<pid>/status, in bytes; 0 when absent (kernel threads, zombies). */
export function parseStatusSwap(text: string): number {
  const m = /^VmSwap:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : 0;
}

/** VmRSS from /proc/<pid>/status, in bytes (used once, to learn the page size). */
export function parseStatusRss(text: string): number {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : 0;
}

/** A "key value" file (memory.stat, cpu.stat, memory.events) as numbers. */
export function parseKeyValues(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const v = Number(line.slice(sp + 1).trim());
    if (Number.isFinite(v)) out.set(line.slice(0, sp), v);
  }
  return out;
}

/** /proc/meminfo, "Key:   123 kB" lines, in bytes. */
export function parseMeminfo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^([^:]+):\s+(\d+)(?:\s*kB)?/.exec(line);
    if (m) out.set(m[1]!, Number(m[2]) * (line.includes("kB") ? 1024 : 1));
  }
  return out;
}

export function parseLoadavg(text: string): [number, number, number] {
  const [a, b, c] = text.trim().split(/\s+/).map(Number);
  return [a ?? 0, b ?? 0, c ?? 0].map((v) => (Number.isFinite(v) ? v : 0)) as [number, number, number];
}

/** A pressure file (`some avg10=… …` / `full avg10=… …`): the avg10 figures, in percent. */
export function parsePressure(text: string): { some: number; full?: number } | null {
  let some: number | undefined;
  let full: number | undefined;
  for (const line of text.split("\n")) {
    const m = /^(some|full) avg10=([\d.]+)/.exec(line);
    if (!m) continue;
    if (m[1] === "some") some = Number(m[2]);
    else full = Number(m[2]);
  }
  return some === undefined ? null : { some, ...(full === undefined ? {} : { full }) };
}

/** Assemble the three pressure files' text (any may be missing) into a MonitorPressure. */
export function pressureOf(cpu?: string | null, memory?: string | null, io?: string | null): MonitorPressure | undefined {
  const c = cpu ? parsePressure(cpu) : null;
  const m = memory ? parsePressure(memory) : null;
  const i = io ? parsePressure(io) : null;
  if (!c && !m && !i) return undefined;
  return {
    ...(c ? { cpu: { some: c.some } } : {}),
    ...(m ? { memory: { some: m.some, full: m.full ?? 0 } } : {}),
    ...(i ? { io: { some: i.some, full: i.full ?? 0 } } : {}),
  };
}

/** `btime` (boot time, epoch seconds) from /proc/stat. */
export function parseBootTime(text: string): number | null {
  const m = /^btime\s+(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The cgroup v2 path from /proc/self/cgroup (`0::/user.slice/…/sova-runtime.service`), and
 * whether it is a dedicated service unit: only then do the unit's counters mean "this server".
 */
export function parseSelfCgroup(text: string): { path: string; unit?: string } | null {
  const line = text.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const path = line.slice(3).trim();
  const last = path.split("/").pop() ?? "";
  return last.endsWith(".service") ? { path, unit: last } : { path };
}

/** Environment entries the monitor reads (once per process). */
export interface ProcEnv {
  /** PI_SESSION_FILE, set by pi's bash tool for its child. */
  sessionFile?: string;
  /** PI_SUBAGENTS_TEAM_MEMBER's team and worker id (member-mcp helpers, team workers). */
  team?: { teamId: string; workerId: string };
}

/** Pick the monitor's entries out of /proc/<pid>/environ (NUL-separated). */
export function parseEnviron(text: string): ProcEnv {
  const env: ProcEnv = {};
  for (const entry of text.split("\0")) {
    if (entry.startsWith("PI_SESSION_FILE=")) {
      const v = entry.slice("PI_SESSION_FILE=".length);
      if (v) env.sessionFile = v;
    } else if (entry.startsWith("PI_SUBAGENTS_TEAM_MEMBER=")) {
      try {
        const v = JSON.parse(entry.slice("PI_SUBAGENTS_TEAM_MEMBER=".length)) as Record<string, unknown>;
        if (typeof v.teamId === "string" && typeof v.workerId === "string") env.team = { teamId: v.teamId, workerId: v.workerId };
      } catch { /* malformed: ignored */ }
    }
  }
  return env;
}

/** /proc/<pid>/cmdline as argv. A retitled process (pi sets its title) reads as one padded word. */
export function parseCmdline(text: string): string[] {
  const parts = text.split("\0");
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.length === 1 ? parts[0]!.trim().split(/\s+/).filter(Boolean) : parts;
}

const CMD_MAX = 120;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** A path argument shown by its last segment; anything else as is. */
const shortArg = (a: string) => (a.startsWith("/") && a.length > 1 ? base(a) : a);
const cut = (s: string) => (s.length > CMD_MAX ? s.slice(0, CMD_MAX - 1) + "…" : s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What argv says about a process: its coarse kind, short command, and any Claude session uuid. */
export interface ArgvInfo {
  kind: MonitorProcKind;
  cmd: string;
  /** `claude --session-id <uuid>` or `--resume <uuid>`. */
  claudeSession?: string;
}

/** The script a node/python/bun command runs, skipping interpreter flags (and their values). */
function scriptIndex(args: string[], valued: Set<string>): number {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (valued.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return i;
  }
  return -1;
}
const NODE_VALUED = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C", "--env-file"]);
const PY_VALUED = new Set(["-W", "-X"]);
const JAVA_VALUED = new Set(["-cp", "-classpath", "--class-path", "-p", "--module-path", "--add-opens", "--add-exports", "--add-modules"]);

/**
 * Classify a process by its argv and short its command to ≤120 chars, keeping what tells two
 * processes apart (`java … clojure.main`, `node tsx server/index.ts`, `chrome --type=renderer`).
 * `comm` is the fallback for an empty argv (kernel threads, zombies).
 */
export function classifyArgv(argv: string[], comm = ""): ArgvInfo {
  if (!argv.length) return { kind: "other", cmd: comm ? `[${comm}]` : "?" };
  const exe = base(argv[0]!);
  const rest = argv.slice(1);
  if (exe === "pi") return { kind: "pi-worker", cmd: cut(["pi", ...rest.map(shortArg)].join(" ")) };
  // Claude Code: its own binary, or node running its cli.js.
  const claudeAt = exe === "claude" ? 0 : /^(node|bun)$/.test(exe) && argv[1] && /claude(-code)?\/cli\.m?js$|\/claude$/.test(argv[1]) ? 1 : -1;
  if (claudeAt >= 0) {
    const a = argv.slice(claudeAt + 1);
    const at = (flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
    const sessionId = at("--session-id");
    const resume = at("--resume");
    const claudeSession = [sessionId, resume].find((v) => v && UUID.test(v));
    const model = at("--model");
    const parts = ["claude", ...(a.includes("-p") ? ["-p"] : []),
      ...(sessionId ? ["--session-id", sessionId.slice(0, 8)] : resume ? ["--resume", resume.slice(0, 8)] : []),
      ...(model ? ["--model", model] : [])];
    return { kind: "claude-worker", cmd: cut(parts.join(" ")), ...(claudeSession ? { claudeSession: claudeSession.toLowerCase() } : {}) };
  }
  if (/^(node|nodejs|bun|deno|tsx)$/.test(exe)) {
    const i = scriptIndex(argv, NODE_VALUED);
    const script = i >= 0 ? argv[i]! : "";
    if (/subagents\/member-mcp\.ts$/.test(script)) return { kind: "member-mcp", cmd: "node member-mcp.ts" };
    // tsx: node …/tsx/dist/cli.mjs server/index.ts → node tsx server/index.ts
    const shown = /\/tsx\/dist\/cli\.m?js$/.test(script) ? "tsx" : script ? shortArg(script) : "";
    const tail = i >= 0 ? argv.slice(i + 1).map(shortArg) : [];
    const kind: MonitorProcKind = /^(vite|tsc|esbuild|rollup|webpack|eslint|biome|vitest|jest)(\.m?js)?$/.test(shown) ? "build" : "node";
    return { kind, cmd: cut([exe, ...(shown ? [shown] : []), ...tail].join(" ")) };
  }
  if (/^python[\d.]*$/.test(exe)) {
    const m = argv.indexOf("-m");
    const i = m > 0 ? m : scriptIndex(argv, PY_VALUED);
    const args = i >= 0 ? argv.slice(i) : rest;
    const shown = args[0] === "-m" ? args.slice(0, 2) : args.slice(0, 1).map(shortArg);
    return { kind: "python", cmd: cut([exe, ...shown, ...args.slice(shown.length).map(shortArg)].join(" ")) };
  }
  if (exe === "java" || exe === "javaw") {
    // Classpaths and -D/-X options say nothing useful: `java … clojure.main -m foo`.
    let main = -1;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (JAVA_VALUED.has(a)) { i++; continue; }
      if (a === "-jar") { main = i; break; }
      if (!a.startsWith("-")) { main = i; break; }
    }
    const tail = main >= 0 ? argv.slice(main).map(shortArg) : [];
    return { kind: "java", cmd: cut(["java", ...(main > 1 ? ["…"] : []), ...tail].join(" ")) };
  }
  if (/^(chrome|chromium|chromium-browser|google-chrome|headless_shell|chrome_crashpad_handler|firefox)$/.test(exe)) {
    const type = rest.find((a) => a.startsWith("--type="));
    return { kind: "browser", cmd: cut([exe, ...(type ? [type] : [])].join(" ")) };
  }
  if (/^(ba|z|da|fi|k)?sh$/.test(exe)) {
    const c = rest.indexOf("-c");
    const script = c >= 0 ? rest[c + 1] ?? "" : rest.map(shortArg).join(" ");
    // Claude Code's bash tool wraps each command after sourcing a shell snapshot; show the command.
    const eval_ = /eval '((?:[^']|'"'"')*)'/.exec(script);
    const shown = (eval_ ? eval_[1]!.replace(/'"'"'/g, "'") : script).replace(/\s+/g, " ").trim();
    return { kind: "shell", cmd: cut(`${exe} ${c >= 0 ? "-c " : ""}${shown}`) };
  }
  if (/^(esbuild|tsc|vite|cargo|rustc|make|gcc|cc|ld|go|gradle|mvn|clj|lein)$/.test(exe))
    return { kind: "build", cmd: cut([exe, ...rest.map(shortArg)].join(" ")) };
  return { kind: "other", cmd: cut([exe, ...rest.map(shortArg)].join(" ")) };
}
