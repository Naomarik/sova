// A file the project needs that lives outside the project on the device the chat came from (§app.transport/agent
// "A file outside the project"): the Transport agent names it (a path in that device's home, as `~/…`) and why; it
// never reads the other device itself. Only your Bring From {device} on the card reads it there, that one path, once:
// never a folder, never one over OUTSIDE_FILE_MAX, never one in the sandbox's hidden list (~/.ssh, ~/.aws, ~/.gnupg and
// the like) or Sova's own folders. Here it goes to the same path under this device's home, never over a file already
// there. Pure but for the one read, the one write, and the source's record of what it sent.
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readTransport, updateTransport } from "./store";

/** The most one file may be (a config file, a key file the project reads; never a data set). */
export const OUTSIDE_FILE_MAX = 1024 * 1024;
const MAX_PATH = 1024;

const within = (child: string, parent: string): boolean => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
};

const real = (p: string): string => {
  let at = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(p);
      rest.push(basename(at));
      at = up;
    }
  }
};

/**
 * The agent's path, checked: a file in that device's home, written `~/…` (an absolute path under `sourceHome`, the
 * other device's home as the arrival knows it, is taken as the same), with no `.` or `..` part. Returns it relative to
 * the home, or why not. Pure.
 */
export function cleanOutsidePath(raw: unknown, sourceHome?: string): { rel: string } | { error: string } {
  let p = typeof raw === "string" ? raw.trim() : "";
  if (!p) return { error: "path must name the file, as ~/… (a file in the user's home on the device the chat came from)." };
  if (p.length > MAX_PATH || p.includes("\0")) return { error: "That path is too long or holds a NUL." };
  if (sourceHome && isAbsolute(p) && within(p, sourceHome) && resolve(p) !== resolve(sourceHome)) p = `~/${resolve(p).slice(resolve(sourceHome).length + 1)}`;
  if (!p.startsWith("~/")) return { error: `${JSON.stringify(p.slice(0, 80))} isn't in the user's home there: the card brings only a file in the home (~/…). Ask the user with align for anything else.` };
  const parts = p.slice(2).split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) return { error: `${JSON.stringify(p.slice(0, 80))} isn't a plain path to one file: no empty, . or .. parts.` };
  return { rel: parts.join("/") };
}

/** Why a file at `abs` is never read or written (it is in the hidden list or in one of `refused`, read through its
    symlinks), or null. `hidden` and `refused` are absolute. */
export function outsideRefusal(abs: string, home: string, hidden: readonly string[], refused: readonly string[]): string | null {
  const r = real(abs);
  if (!within(r, real(home)) || r === real(home)) return `${abs} isn't a file inside the home folder`;
  for (const h of hidden) if (h && (within(abs, h) || within(r, real(h)))) return `${abs} is in the sandbox's hidden list (${h}): private settings never travel`;
  for (const f of refused) if (f && (within(abs, f) || within(r, real(f)))) return `${abs} is in Sova's own folders`;
  return null;
}

/** The home-relative path as the card shows it, and its folder. Pure. */
export const outsideShown = (rel: string): { path: string; folder: string } => ({ path: `~/${rel}`, folder: rel.includes("/") ? `~/${dirname(rel)}` : "~" });

/**
 * The device the chat came from reads the one file `rel` under its `home`: a regular file (a symlink only to one
 * still inside the home and outside the hidden list), at most OUTSIDE_FILE_MAX bytes. Never a folder. Only the route
 * your click reaches calls it.
 */
export function readOutside(rel: string, home: string, hidden: readonly string[], refused: readonly string[]): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  const abs = join(home, rel);
  const why = outsideRefusal(abs, home, hidden, refused);
  if (why) return { ok: false, error: why };
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { ok: false, error: `~/${rel} isn't on this device` };
  }
  if (st.isDirectory()) return { ok: false, error: `~/${rel} is a folder: the card brings one file` };
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch (err) {
    return { ok: false, error: `~/${rel} can't be read here: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const f = fstatSync(fd);
    if (f.isDirectory()) return { ok: false, error: `~/${rel} is a folder: the card brings one file` };
    if (!f.isFile()) return { ok: false, error: `~/${rel} isn't a regular file` };
    if (f.size > OUTSIDE_FILE_MAX) return { ok: false, error: `~/${rel} is ${Math.ceil(f.size / 1024)} KB, over the ${OUTSIDE_FILE_MAX / 1024} KB the card brings: place it yourself` };
    const buf = Buffer.alloc(f.size);
    let at = 0;
    while (at < f.size) {
      const n = readSync(fd, buf, at, f.size - at, at);
      if (n <= 0) break;
      at += n;
    }
    return { ok: true, bytes: buf.subarray(0, at) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Here: the file goes to `rel` under this device's `home`, its folders made, readable only by the user. A file (or
 * anything) already at that path is kept as it is: nothing is overwritten.
 */
export function writeOutside(rel: string, home: string, bytes: Buffer, hidden: readonly string[], refused: readonly string[]): { written: string } | { kept: string } | { error: string } {
  const abs = join(home, rel);
  const why = outsideRefusal(abs, home, hidden, refused);
  if (why) return { error: why };
  if (bytes.length > OUTSIDE_FILE_MAX) return { error: `It is over the ${OUTSIDE_FILE_MAX / 1024} KB the card brings` };
  if (existsSync(abs) || isLink(abs)) return { kept: abs };
  try {
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, bytes, { flag: "wx", mode: 0o600 });
    return { written: abs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { kept: abs };
    return { error: `It couldn't be written at ${abs}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const isLink = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The device a transport came from, asked for one file the agent there named (§app.transport/agent "A file outside
 * the project"), after that device proved your click on its card over this very request: that one path in this
 * device's home, once per transport, never a folder, one over the cap, one in the sandbox's hidden list or Sova's own
 * folders. Sent as base64; never logged.
 */
export function serveOutsideFile(tid: string, from: string, rawPath: unknown, opts: { home: string; hidden: string[]; refused: string[] }): { status: number; body: Record<string, unknown> } {
  const r = readTransport(tid);
  if (!r || r.side !== "source" || r.peer !== from) return { status: 404, body: { error: "No such transport" } };
  const p = cleanOutsidePath(rawPath);
  if ("error" in p) return { status: 400, body: { error: p.error } };
  const sent = ((r.ext ?? {}) as { outsideSent?: string[] }).outsideSent ?? [];
  if (sent.includes(p.rel)) return { status: 409, body: { error: `~/${p.rel} was already sent once for this transport` } };
  const got = readOutside(p.rel, opts.home, opts.hidden, opts.refused);
  if (!got.ok) return { status: 409, body: { error: got.error } };
  updateTransport(tid, (cur) => ({ ext: { outsideSent: [...(((cur.ext ?? {}) as { outsideSent?: string[] }).outsideSent ?? []), p.rel] } }));
  console.log(`[transport] ${tid}: one file from this home sent to ${r.peerLabel} by your click there (${got.bytes.length} bytes)`);
  return { status: 200, body: { ok: true, size: got.bytes.length, data: got.bytes.toString("base64") } };
}
