import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Which process listens on a TCP port of this host, and the folder it runs from
 * (§app.project-overseer/previews): the overseer may preview only a port a process of one of the
 * project's coding sessions' worktrees serves, and a preview with no recorded session is matched to
 * one by it. Linux only, from /proc (this user's own processes: another user's fds can't be read,
 * so such a listener reads as unknown). Elsewhere every answer is `unknown`.
 */

export type PortOwner = { pid: number; cwd: string } | "none" | "unknown";

const LISTEN = "0A";
/** A local address that accepts loopback connections: 127.0.0.0/8, ::1, or any address (IPv4-mapped ones too, below). */
const LOOPBACK_OR_ANY = new Set(["00000000", "00000000000000000000000000000000", "00000000000000000000000001000000"]);
/** The first 96 bits of an IPv4-mapped IPv6 address (::ffff:a.b.c.d) as /proc writes them. */
const V4_MAPPED = "0000000000000000FFFF0000";

/** The socket inodes listening on `port` whose address the preview can reach (loopback or any), from /proc/net/tcp{,6} text. Pure. */
export function listeningInodes(tables: string[], port: number): Set<string> {
  const out = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of tables)
    for (const line of table.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const [addr, p] = (f[1] ?? "").split(":");
      if (p !== hexPort || f[3] !== LISTEN || !addr) continue;
      // 127.x.x.x is little-endian in /proc: its last byte pair is 7F. A dual-stack socket (a JVM's, bound to
      // "localhost") shows it IPv4-mapped in tcp6: ::ffff:127.x.x.x, or ::ffff:0.0.0.0 for any.
      const v4 = addr.length === 32 && addr.startsWith(V4_MAPPED) ? addr.slice(24) : addr;
      if (LOOPBACK_OR_ANY.has(v4) || (v4.length === 8 && v4.endsWith("7F"))) out.add(f[9]!);
    }
  return out;
}

export interface ProcFs {
  read(path: string): string | null;
  list(path: string): string[];
  link(path: string): string | null;
}

const realFs: ProcFs = {
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  link: (p) => {
    try {
      return readlinkSync(p);
    } catch {
      return null;
    }
  },
};

/** The process listening on `port` and its cwd; "none" when nothing listens there; "unknown" when it can't be told. */
export function portOwner(port: number, fs: ProcFs = realFs, platform: NodeJS.Platform = process.platform): PortOwner {
  if (platform !== "linux") return "unknown";
  const tables = ["/proc/net/tcp", "/proc/net/tcp6"].map((p) => fs.read(p)).filter((t): t is string => t !== null);
  if (!tables.length) return "unknown";
  const inodes = listeningInodes(tables, port);
  if (!inodes.size) return "none";
  const wanted = new Set([...inodes].map((i) => `socket:[${i}]`));
  for (const pid of fs.list("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const dir = join("/proc", pid, "fd");
    for (const fd of fs.list(dir)) {
      const target = fs.link(join(dir, fd));
      if (target && wanted.has(target)) {
        const cwd = fs.link(join("/proc", pid, "cwd"));
        return cwd ? { pid: Number(pid), cwd } : "unknown";
      }
    }
  }
  // Someone listens, but not a process this user may read.
  return "unknown";
}
