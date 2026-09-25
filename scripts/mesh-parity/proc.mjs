// Process-level evidence from one side's strace log: what it bound, connected to, executed and
// touched, split by harness phase, plus event-loop wakeups while idle (a new timer shows up there).

import { readFileSync } from "node:fs";

const TOUCH_CALLS = new Set(["connect", "bind", "sendto", "sendmsg", "openat", "newfstatat", "statx", "access", "execve"]);
const CGNAT = /inet_addr\("100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+"\)|"::ffff:100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const LINE = /^(\d+)\s+(\d+\.\d+)\s+(?:<\.\.\. )?(\w+)(?:\(| resumed>)(.*)$/;

/** @param marks [{phase, t}] sorted by t (epoch seconds) — a syscall belongs to the last mark before it. */
export function analyzeStrace(file, { marks, idleWindow, port, mainPid }) {
  const text = readFileSync(file, "utf8");
  const phaseAt = (t) => {
    let p = "startup";
    for (const m of marks) if (t >= m.t) p = m.phase;
    return p;
  };
  const out = { binds: new Set(), listens: 0, connects: {}, unix: new Set(), execs: new Set(), tailscale: [], idleWakeups: 0, lines: 0 };
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    out.lines++;
    const [, pid, ts, call, rest] = m;
    const t = Number(ts);
    // A tailscale touch: a tailscale path opened, stat'ed, executed or connected to (the LocalAPI
    // socket is /run/tailscale/tailscaled.sock or /var/run/…), or any packet to the tailnet's
    // CGNAT range 100.64.0.0/10 (100.100.100.100 included). NOT the kernel's netlink address dumps,
    // which name the host's tailscale0 interface whenever anything resolves a hostname.
    if ((TOUCH_CALLS.has(call) && /tailscale/i.test(rest)) || (/^(connect|sendto|sendmsg|bind)$/.test(call) && CGNAT.test(rest))) out.tailscale.push(raw.slice(0, 300));
    if (call === "bind") {
      const a = inetAddr(rest);
      if (a) out.binds.add(a.replace(`:${port}`, ":<PORT>"));
    } else if (call === "listen") {
      out.listens++;
    } else if (call === "connect") {
      const a = inetAddr(rest);
      const phase = phaseAt(t);
      if (a) {
        const [host, p] = splitHostPort(a);
        const cls = /^(127\.|::1$|::ffff:127\.)/.test(host) ? `loopback:${p === String(port) ? "<PORT>" : p}` : `remote:${p}`;
        (out.connects[phase] ??= {})[cls] = ((out.connects[phase] ?? {})[cls] ?? 0) + 1;
      } else {
        const path = /sun_path=("(?:[^"\\]|\\.)*")/.exec(rest)?.[1];
        if (path) out.unix.add(JSON.parse(path).replace(/\/tsx-\d+\/\d+\.pipe$/, "/tsx-<uid>/<pid>.pipe"));
      }
    } else if (call === "execve") {
      const exe = /^"([^"]+)"/.exec(rest)?.[1];
      if (exe) out.execs.add(exe);
    } else if ((call === "epoll_wait" || call === "epoll_pwait" || call === "epoll_pwait2") && Number(pid) === mainPid && idleWindow && t >= idleWindow[0] && t <= idleWindow[1]) {
      out.idleWakeups++;
    }
  }
  return {
    ...out,
    binds: [...out.binds].sort(),
    unix: [...out.unix].sort(),
    execs: [...out.execs].sort(),
  };
}

function inetAddr(rest) {
  let m = /sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)/.exec(rest);
  if (m) return `${m[2]}:${m[1]}`;
  m = /sa_family=AF_INET6, sin6_port=htons\((\d+)\),.*?inet_pton\(AF_INET6, "([^"]+)"/.exec(rest);
  if (m) return `[${m[2]}]:${m[1]}`;
  return null;
}
const splitHostPort = (a) => {
  const i = a.lastIndexOf(":");
  return [a.slice(0, i).replace(/^\[|\]$/g, ""), a.slice(i + 1)];
};

/** Listening sockets owned by any of `pids`, from ss (the kernel's view, independent of strace). */
export function listeningSockets(ssOutput, pids, port) {
  const set = new Set();
  for (const line of ssOutput.split("\n")) {
    const pidsInLine = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (!pidsInLine.some((p) => pids.includes(p))) continue;
    const cols = line.trim().split(/\s+/);
    set.add(`${cols[0]} ${cols[4]}`.replace(`:${port}`, ":<PORT>"));
  }
  return [...set].sort();
}
