import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";

/** Serializable identity, not a PID-only or window-title focus hint. */
export type FocusTarget = {
  version: 1;
  instance: string;
  bootId: string;
  origin: Identity;
  ghostty: Identity;
  terminal: Identity;
  address: string;
  /** Unique caller-installed terminal title; only a currently visible tab matches. */
  title?: string;
  tmux?: {
    socket: string;
    server: Identity;
    pane: string;
    paneProcess: Identity;
    client: Identity;
    clientTty: string;
    session: string;
    window: string;
  };
};
type Identity = { pid: number; start: string; tty: string };
type Proc = Identity & { ppid: number; comm: string; state: string };
type Client = { address: string; pid: number; class: string; title: string; mapped: boolean; hidden: boolean };
type IO = {
  platform: string;
  pid: number;
  env: NodeJS.ProcessEnv;
  read(path: string): Promise<string>;
  list(path: string): Promise<string[]>;
  link(path: string): Promise<string>;
  run(command: string, args: string[]): Promise<string>;
};
const exec = promisify(execFile);
const system: IO = {
  platform: process.platform, pid: process.pid, env: process.env,
  read: (path) => readFile(path, "utf8"), list: readdir, link: readlink,
  run: async (command, args) => (await exec(command, args, {
    encoding: "utf8", timeout: 4000, maxBuffer: 4 * 1024 * 1024,
  })).stdout,
};
function fail(message: string): never { throw new Error(`Cannot focus pi session: ${message}`); }
function identity(p: Proc): Identity { return { pid: p.pid, start: p.start, tty: p.tty }; }
function parseStat(text: string): Proc {
  // comm may contain spaces and parentheses. Fields after its final ')' are fixed.
  const end = text.lastIndexOf(")");
  const start = text.indexOf("(");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const pid = Number(text.slice(0, start).trim());
  if (start < 0 || end < start || fields.length < 20 || !Number.isSafeInteger(pid) || pid < 1 ||
      !/^\d+$/.test(fields[19]) || !/^-?\d+$/.test(fields[4]) || !/^\d+$/.test(fields[1])) {
    return fail("malformed /proc stat");
  }
  return { pid, comm: text.slice(start + 1, end), state: fields[0],
    ppid: Number(fields[1]), tty: fields[4], start: fields[19] };
}
async function processes(io: IO): Promise<Map<number, Proc>> {
  const result = new Map<number, Proc>();
  await Promise.all((await io.list("/proc")).filter((s) => /^\d+$/.test(s)).map(async (pid) => {
    try {
      const p = parseStat(await io.read(`/proc/${pid}/stat`));
      if (p.state !== "Z" && p.state !== "X") result.set(p.pid, p);
    } catch (error) {
      // A process can exit during enumeration. Other errors must not hide extra surfaces.
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }));
  return result;
}
function ancestry(all: Map<number, Proc>, pid: number): Proc[] {
  const chain: Proc[] = [];
  const seen = new Set<number>();
  while (pid > 0) {
    if (seen.has(pid)) return fail("cyclic process ancestry");
    seen.add(pid);
    const p = all.get(pid);
    if (!p) break;
    chain.push(p); pid = p.ppid;
  }
  return chain;
}
function same(a: Identity, b: Identity): boolean {
  return a.pid === b.pid && a.start === b.start && a.tty === b.tty;
}
function rows(text: string): string[][] {
  return text.trimEnd() ? text.trimEnd().split("\n").map((line) => line.split("\t")) : [];
}
function tmuxEnv(value: string): { socket: string; pid: number } {
  const match = /^(\/[^\n\r\0]+),(\d+),(\d+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) return fail("invalid TMUX socket identity");
  return { socket: match[1], pid: Number(match[2]) };
}
async function build(io: IO, pid: number, mux?: { socket: string; pid: number; pane: string }, title?: string): Promise<FocusTarget> {
  if (title !== undefined && (typeof title !== "string" || !title.length || title.length > 512 || /[\x00-\x1f\x7f]/.test(title))) return fail("invalid exact terminal title");
  if (io.platform !== "linux" || !io.env.HYPRLAND_INSTANCE_SIGNATURE) return fail("only Linux/Hyprland is supported");
  const all = await processes(io);
  const origin = all.get(pid);
  if (!origin || origin.tty === "0") return fail("session has no live controlling terminal");
  let terminalPid = pid;
  let tmux: FocusTarget["tmux"];
  if (mux) {
    if (!/^%\d+$/.test(mux.pane) || !mux.socket.startsWith("/") || /[\0\n\r]/.test(mux.socket)) return fail("invalid tmux pane/socket");
    const run = (...args: string[]) => io.run("tmux", ["-S", mux.socket, ...args]);
    const panes = rows(await run("list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{session_id}\t#{window_id}"))
      .filter((row) => row[0] === mux.pane);
    if (panes.length !== 1) return fail("tmux pane is missing or linked ambiguously");
    const [, panePid, paneTty, session, window] = panes[0];
    const paneProcess = all.get(Number(panePid));
    const server = all.get(mux.pid);
    if (!server || !paneProcess || !/^\$\d+$/.test(session) || !/^@\d+$/.test(window) ||
        !ancestry(all, pid).some((p) => same(p, paneProcess)) || paneProcess.tty !== origin.tty ||
        !ancestry(all, paneProcess.pid).some((p) => same(p, server)) ||
        await io.link(`/proc/${pid}/fd/0`) !== paneTty) return fail("tmux pane no longer owns the session TTY/ancestry");
    const clients = rows(await run("list-clients", "-F", "#{client_pid}\t#{client_tty}\t#{client_readonly}"));
    if (clients.length !== 1 || clients[0][2] !== "0") return fail("tmux needs exactly one writable attached client");
    const [clientPid, clientTty] = clients[0];
    const client = all.get(Number(clientPid));
    if (!client || client.tty === "0" || !/^\/dev\/pts\/\d+$/.test(clientTty) ||
        await io.link(`/proc/${client.pid}/fd/0`) !== clientTty) return fail("tmux client TTY identity is unavailable");
    terminalPid = client.pid;
    tmux = { socket: mux.socket, server: identity(server), pane: mux.pane, paneProcess: identity(paneProcess),
      client: identity(client), clientTty, session, window };
  }
  const chain = ancestry(all, terminalPid);
  const ghostIndex = chain.findIndex((p) => p.comm === "ghostty");
  if (ghostIndex < 1) return fail("no Ghostty ancestor (nested/detached terminals are unsupported)");
  const ghost = chain[ghostIndex];
  const terminal = chain[ghostIndex - 1];
  if (!(await io.link(`/proc/${ghost.pid}/exe`)).endsWith("/ghostty")) return fail("Ghostty executable identity changed");
  // Hyprland only exposes top-level windows, not Ghostty tabs/splits. Without
  // a caller-installed unique title, require exactly one provable PTY surface.
  // With a title, the caller asserts its uniqueness; only the visible tab can
  // match. Never use the active window or a generic pi/shell title as a fallback.
  const children = [...all.values()].filter((p) => p.ppid === ghost.pid);
  if ((!title && (children.length !== 1 || children[0].pid !== terminal.pid)) || terminal.tty === "0" ||
      chain.slice(0, ghostIndex).some((p) => p.tty !== terminal.tty)) {
    return fail("Ghostty has ambiguous tabs/splits/children or a mismatched TTY");
  }
  // Count open PTY masters too: tabs whose shell exited can still retain a
  // surface without a live child. Linux exposes each master's tty-index here.
  const terminalTty = await io.link(`/proc/${terminal.pid}/fd/0`);
  const ttyMatch = /^\/dev\/pts\/(\d+)$/.exec(terminalTty);
  const masters = new Set<string>();
  for (const fd of await io.list(`/proc/${ghost.pid}/fdinfo`)) {
    const info = await io.read(`/proc/${ghost.pid}/fdinfo/${fd}`);
    const match = /^tty-index:\s*(\d+)\s*$/m.exec(info);
    if (match) masters.add(match[1]);
  }
  if (!ttyMatch || (!title && masters.size !== 1) || !masters.has(ttyMatch[1])) return fail("Ghostty PTY surfaces are ambiguous or cannot be verified");
  const clients: Client[] = JSON.parse(await io.run("hyprctl", ["-j", "clients"]));
  if (!Array.isArray(clients)) return fail("invalid Hyprland client response");
  const windows = clients.filter((c) => c.pid === ghost.pid && (title === undefined || c.title === title));
  if (windows.length !== 1 || !windows[0].mapped || windows[0].hidden ||
      !/^(com\.mitchellh\.ghostty|ghostty)$/i.test(windows[0].class) ||
      !/^0x[0-9a-f]+$/i.test(windows[0].address)) return fail("Ghostty window is absent, hidden, or ambiguous");
  return { version: 1, instance: io.env.HYPRLAND_INSTANCE_SIGNATURE, bootId: (await io.read("/proc/sys/kernel/random/boot_id")).trim(),
    origin: identity(origin), ghostty: identity(ghost), terminal: identity(terminal), address: windows[0].address,
    ...(title !== undefined ? { title } : {}), ...(tmux ? { tmux } : {}) };
}
export function isFocusTarget(value: unknown): value is FocusTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, any>;
  const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  const id = (v: any): boolean => !!v && typeof v === "object" && !Array.isArray(v) &&
    Number.isSafeInteger(v.pid) && v.pid > 0 && typeof v.start === "string" && /^\d{1,24}$/.test(v.start) &&
    typeof v.tty === "string" && /^-?\d{1,16}$/.test(v.tty);
  if (t.version !== 1 || !text(t.instance) || !text(t.bootId) || !id(t.origin) || !id(t.ghostty) || !id(t.terminal) ||
      typeof t.address !== "string" || !/^0x[0-9a-f]{1,32}$/i.test(t.address)) return false;
  if (t.title !== undefined && !text(t.title, 512)) return false;
  if (t.tmux === undefined) return true;
  const m = t.tmux;
  return !!m && typeof m === "object" && !Array.isArray(m) && text(m.socket, 4096) && m.socket.startsWith("/") &&
    id(m.server) && id(m.paneProcess) && id(m.client) && text(m.pane) && /^%\d+$/.test(m.pane) &&
    text(m.clientTty) && /^\/dev\/pts\/\d+$/.test(m.clientTty) && text(m.session) && /^\$\d+$/.test(m.session) &&
    text(m.window) && /^@\d+$/.test(m.window);
}
function api(io: IO) {
  return {
    /** title must be a unique marker installed by this session, not a generic title.
     * Discovery never focuses. Hidden tabs and unsupported layouts reject.
     */
    async discoverFocusTarget(title?: string): Promise<FocusTarget | undefined> {
      // Unsupported platforms/layouts deliberately reject with an actionable error.
      // The optional return type lets callers store targets only when available.
      const env = io.env;
      if (!!env.TMUX !== !!env.TMUX_PANE) return fail("incomplete tmux environment");
      // An inactive tmux pane does not own the terminal's visible title. Its
      // exact pane/client identity plus an unambiguous host is the focus route.
      return build(io, io.pid, env.TMUX ? { ...tmuxEnv(env.TMUX), pane: env.TMUX_PANE! } : undefined, env.TMUX ? undefined : title);
    },
    async focusTarget(target: FocusTarget): Promise<void> {
      if (!isFocusTarget(target) || target.instance !== io.env.HYPRLAND_INSTANCE_SIGNATURE) return fail("unsupported target or different Hyprland instance");
      const current = await build(io, target.origin.pid, target.tmux ? {
        socket: target.tmux.socket, pid: target.tmux.server.pid, pane: target.tmux.pane,
      } : undefined, target.title);
      // Compare fields, independent of serialized property ordering.
      const equal = (a: unknown, b: unknown): boolean => {
        if (a === b) return true;
        if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
        const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
        return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((key) => equal(x[key], y[key]));
      };
      if (!equal(current, target)) return fail("stale process, terminal, tmux, or window identity");
      if (current.tmux) {
        const t = current.tmux;
        await io.run("tmux", ["-S", t.socket, "switch-client", "-c", t.clientTty, "-t", `${t.session}:${t.window}`,
          ";", "select-pane", "-t", t.pane]);
      }
      const result = await io.run("hyprctl", ["dispatch", "focuswindow", `address:${current.address}`]);
      if (result.trim() !== "ok") return fail(`Hyprland rejected focus: ${result.trim()}`);
    },
  };
}
export const { discoverFocusTarget, focusTarget } = api(system);
/** Dependency-injected helpers for tests; never execute real focus commands. */
export const __testing = { api, parseStat, ancestry, tmuxEnv };
