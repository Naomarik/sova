// The chat-runtime trial's view of processes, on Linux (/proc) and darwin (ps, lsof): the one place
// the trial reads another process's state. Nothing here signals a process. Builtins only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";

export const darwin = process.platform === "darwin";

const ps = (args) => {
  try {
    return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
};
const statFields = (pid) => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  return s.slice(s.lastIndexOf(")") + 2).split(" ");
};

/** Whether `pid` runs (a zombie does not). */
export function alive(pid) {
  if (!pid) return false;
  if (!darwin) {
    try {
      return existsSync(`/proc/${pid}`) && statFields(pid)[0] !== "Z";
    } catch {
      return false;
    }
  }
  const st = ps(["-o", "stat=", "-p", String(pid)]).trim();
  return !!st && !st.startsWith("Z");
}

/** Every process: pid, parent pid, process group, session, nice and command line (argv joined by spaces). */
export function table() {
  if (!darwin) {
    const out = [];
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const f = statFields(d);
        const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        out.push({ pid: Number(d), ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), nice: Number(f[16]), cmd });
      } catch {}
    }
    return out;
  }
  return ps(["-ww", "-A", "-o", "pid=,ppid=,pgid=,sess=,nice=,command="])
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], sid: +m[4], nice: +m[5], cmd: m[6].trim() }));
}

/** One process's row of `table()`, or null. */
export function info(pid) {
  if (!pid) return null;
  if (!darwin) return table().find((p) => p.pid === Number(pid)) ?? null;
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(ps(["-ww", "-o", "pid=,ppid=,pgid=,sess=,nice=,command=", "-p", String(pid)]).trim());
  return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], sid: +m[4], nice: +m[5], cmd: m[6].trim() } : null;
}

/** The command line, argv joined by spaces ("" when gone). */
export const cmdOf = (pid) => info(pid)?.cmd ?? "";
/** The nice value (null when gone). */
export const niceOf = (pid) => info(pid)?.nice ?? null;

/** pid and every descendant, each with its command line. */
export function tree(pid) {
  const all = table();
  const out = [Number(pid)];
  for (let i = 0; i < out.length; i++) for (const p of all) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
  return out.map((p) => ({ pid: p, cmd: all.find((x) => x.pid === p)?.cmd ?? "" }));
}

/** pid's ancestors, nearest first (pid itself excluded). */
export function ancestors(pid) {
  const all = new Map(table().map((p) => [p.pid, p]));
  const out = [];
  for (let p = all.get(Number(pid))?.ppid; p && p > 1 && !out.includes(p); p = all.get(p)?.ppid) out.push(p);
  return out;
}

/**
 * Value of the environment variable `name` of every process of this user that has it set, as
 * [{pid, value, cmd}]. Linux: /proc/<pid>/environ. darwin: `ps -wwEax`, which prints the environment
 * after the command line for the user's own processes (one line each, so a value holding " NAME=" is
 * misread; the trial's names and paths never do).
 */
export function withEnv(name) {
  const out = [];
  if (!darwin) {
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const hit = readFileSync(`/proc/${d}/environ`, "utf8").split("\0").find((e) => e.startsWith(`${name}=`));
        if (hit) out.push({ pid: Number(d), value: hit.slice(name.length + 1), cmd: readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim() });
      } catch {}
    }
    return out;
  }
  for (const line of ps(["-wwEax", "-o", "pid=,command="]).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    const at = m ? m[2].indexOf(` ${name}=`) : -1;
    if (at < 0) continue;
    const rest = m[2].slice(at + name.length + 2);
    out.push({ pid: Number(m[1]), value: rest.split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)[0], cmd: m[2].slice(0, at).trim() });
  }
  return out;
}

/** Linux only: the process's cgroup line(s) ("" elsewhere or when gone). */
export function cgroupOf(pid) {
  if (darwin) return "";
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The pid owning the TCP client socket 127.0.0.1:`clientPort` connected to our `serverPort` (0 if
 * unknown). Linux: /proc/net/tcp{,6} for the socket's inode, then a scan of /proc/<pid>/fd. darwin:
 * lsof.
 */
export function socketOwner(clientPort, serverPort) {
  if (darwin) {
    let out = "";
    try {
      out = execFileSync("lsof", ["-nP", `-iTCP@127.0.0.1:${clientPort}`, "-sTCP:ESTABLISHED", "-Fpn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return 0;
    }
    // -F output: a "p<pid>" line, then its "n<local>-><remote>" lines. The owner names our port as local.
    let pid = 0;
    for (const l of out.split("\n")) {
      if (l.startsWith("p")) pid = Number(l.slice(1));
      else if (l.startsWith("n") && l.includes(`:${clientPort}->`) && l.endsWith(`:${serverPort}`)) return pid;
    }
    return 0;
  }
  const hex = (p) => p.toString(16).toUpperCase().padStart(4, "0");
  let inode = "";
  for (const t of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const line of readFileSync(t, "utf8").split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length > 9 && f[1].endsWith(`:${hex(clientPort)}`) && f[2].endsWith(`:${hex(serverPort)}`)) inode = f[9];
      }
    } catch {}
    if (inode) break;
  }
  if (!inode) return 0;
  const want = `socket:[${inode}]`;
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let fds = [];
    try {
      fds = readdirSync(`/proc/${d}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${d}/fd/${fd}`) === want) return Number(d);
      } catch {}
    }
  }
  return 0;
}
