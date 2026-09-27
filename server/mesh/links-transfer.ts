// The bytes of a file offer (§mesh.links/offers, §mesh.links/transfer): listing what the sender
// offers, packing it once into a spool, serving the spool with Range, and on the receiving host
// downloading it to a `.part` file with resume, verifying it and extracting it. Nothing here knows
// links, members or rows: server/mesh/links.ts owns the offer records and calls these, and the
// sandbox checks come in as functions (server/link-sandbox.ts; tests fake them).
//
// Files: the sender's spool is `<stateRoot>/mesh-links/spool/<of>.tar.zst` (`.part` while packing),
// the receiver's download `<stateRoot>/mesh-links/incoming/<of>.tar.zst.part`. Never under /tmp.
// The archive is one tar per offered root, concatenated, through zstd: every root has its own
// parent (`tar -T` ignores `-C` lines), so the receiver extracts with `--ignore-zeros`.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { lstat, open, opendir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import type { LinkOfferRoot, LinkOfferWarning, OfferRefusal } from "../../shared/mesh-links";
import { type TarMember, tarMembers } from "./tar-list";

/** A refusal or failure with its reason and the sentence the agent reads. */
export class TransferError extends Error {
  constructor(
    readonly reason: OfferRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** A pull ended by `Pulls.cancel` (the offer expired, was cancelled, or its link ended). */
export class PullCancelled extends Error {
  constructor(readonly offerId: string) {
    super(`The pull of ${offerId} was cancelled.`);
  }
}

/** Sender sandbox checks, on canonical paths; null = sandbox off. */
export interface SandboxRead {
  readDenial(canonical: string): string | undefined;
  hiddenBelow(canonicalRoot: string): string[];
}
/** Receiver sandbox check; null = sandbox off. */
export interface SandboxWrite {
  writeDenial(canonical: string, opts?: { creating?: boolean }): string | undefined;
}

const MiB = 1024 * 1024;
const mib = (n: number) => (n >= 10 * MiB ? `${Math.round(n / MiB)} MiB` : n >= MiB ? `${(n / MiB).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);
const tail = (s: string, n = 2048) => (s.length > n ? `…${s.slice(-n)}` : s).trim();

export const spoolDir = (root: string) => join(root, "mesh-links", "spool");
export const incomingDir = (root: string) => join(root, "mesh-links", "incoming");
export const spoolFile = (root: string, offerId: string) => join(spoolDir(root), `${offerId}.tar.zst`);
export const partFile = (root: string, offerId: string) => join(incomingDir(root), `${offerId}.tar.zst.part`);

/** The deepest existing ancestor with its symlinks resolved, the rest appended (the sandbox's rule). */
export function canonical(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(path);
      rest.push(basename(head));
      head = up;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// ---- tar on this host -----------------------------------------------------------------------------

let tarProbe: Promise<boolean> | null = null;
/** Whether `tar` runs on this host; probed once. */
export function tarAvailable(): Promise<boolean> {
  tarProbe ??= new Promise((ok) => execFile("tar", ["--version"], { timeout: 10_000 }, (err) => ok(!err)));
  return tarProbe;
}

const tarEnv = () => ({ ...process.env, LC_ALL: "C" });

// ---- listing (the sender) ---------------------------------------------------------------------------

/** One root as tar packs it: `-C parent`, the member names (relative to parent) in walk order. */
interface PackRoot {
  parent: string;
  members: string[];
}

export interface OfferListing {
  roots: LinkOfferRoot[];
  files: number;
  bytes: number;
  warnings: LinkOfferWarning[];
  /** What pack() hands tar: opaque to callers, and only valid in this process. */
  readonly packList: readonly PackRoot[];
}

/** A glob as a regex: `*` and `?` within a component, `**` across them, `[…]` a class. */
function globRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * The offer's exclude rule as a test on a member name (`proj/src/x.log`). A pattern without `/`
 * matches any one component (`node_modules`, `*.log`); a pattern with `/` matches the member name
 * from the root (`proj/dist`). A member under an excluded directory is excluded with it.
 */
export function excludeMatcher(patterns: readonly string[] = []): (member: string) => boolean {
  const comp: RegExp[] = [];
  const path: RegExp[] = [];
  for (const raw of patterns) {
    const p = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) continue;
    (p.includes("/") ? path : comp).push(globRe(p));
  }
  if (!comp.length && !path.length) return () => false;
  return (member) => {
    const parts = member.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (comp.some((r) => r.test(parts[i]!))) return true;
      if (path.length && path.some((r) => r.test(parts.slice(0, i + 1).join("/")))) return true;
    }
    return false;
  };
}

function expandHome(p: string, home: string): string | null {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p.startsWith("~")) return null; // ~user
  return p;
}

/**
 * link_offer's listing: each path resolved against the sender's cwd (`~` expanded), each landing
 * at dest/<its name>. Walked without following a symlink, directories included, so the counts are
 * exactly what tar packs (it gets this list, never a directory to recurse). Refused: a missing
 * path or `/` (no-path), two roots with one name (same-name), and with the sandbox on, a root it
 * can't read or a hidden path below one that `exclude` doesn't drop (hidden).
 */
export async function listOffer(req: { cwd: string; home: string; paths: readonly string[]; exclude?: readonly string[]; sandbox: SandboxRead | null }): Promise<OfferListing> {
  if (!req.paths.length) throw new TransferError("no-path", "Name at least one path to offer.");
  const excluded = excludeMatcher(req.exclude);
  const abs: string[] = [];
  const names = new Map<string, string>();
  for (const p of req.paths) {
    if (typeof p !== "string" || !p.trim() || p.includes("\0")) throw new TransferError("no-path", `${JSON.stringify(p)} is not a path.`);
    const e = expandHome(p.trim(), req.home);
    if (e === null) throw new TransferError("no-path", `${p}: only ~ and ~/… are expanded.`);
    const a = resolve(req.cwd, e);
    if (dirname(a) === a) throw new TransferError("no-path", `${p} is the filesystem root, which has no name to land under.`);
    try {
      lstatSync(a);
    } catch {
      throw new TransferError("no-path", `${p} does not exist (as ${a}).`);
    }
    const name = basename(a);
    const had = names.get(name);
    if (had !== undefined) throw new TransferError("same-name", `${had} and ${p} would both land at dest/${name}; offer them separately.`);
    names.set(name, p);
    abs.push(a);
  }

  const roots: LinkOfferRoot[] = [];
  const packList: PackRoot[] = [];
  const warnings: LinkOfferWarning[] = [];
  let files = 0;
  let bytes = 0;
  for (const a of abs) {
    const name = basename(a);
    const parent = dirname(a);
    if (req.sandbox) {
      // The root as the link itself when it is one: it travels as a link, never followed.
      const canonRoot = join(canonical(parent), name);
      const why = req.sandbox.readDenial(canonRoot);
      if (why) throw new TransferError("hidden", `${a} can't be offered: ${why}.`);
      for (const h of req.sandbox.hiddenBelow(canonRoot)) {
        const member = `${name}/${relative(canonRoot, h).split(sep).join("/")}`;
        if (!excluded(member))
          throw new TransferError("hidden", `${join(a, relative(canonRoot, h))} is hidden by this session's sandbox; exclude it ("${member}"), or offer less.`);
      }
    }
    const root = await walk(a, name, excluded, abs, warnings);
    roots.push(root.root);
    packList.push({ parent, members: root.members });
    files += root.root.files;
    bytes += root.root.bytes;
  }
  return { roots, files, bytes, warnings, packList };
}

async function walk(abs: string, name: string, excluded: (m: string) => boolean, offered: readonly string[], warnings: LinkOfferWarning[]) {
  const st = await lstat(abs);
  const kind: LinkOfferRoot["kind"] = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other";
  const root: LinkOfferRoot = { name, kind, files: st.isFile() ? 1 : 0, bytes: st.isFile() ? st.size : 0 };
  const members = [name];
  if (kind !== "dir") return { root, members };
  // Pre-order, so every directory comes before what is in it (tar recreates it before its members).
  const stack: Array<{ dir: string; member: string }> = [{ dir: abs, member: name }];
  while (stack.length) {
    const { dir, member } = stack.pop()!;
    const subdirs: Array<{ dir: string; member: string }> = [];
    let d;
    try {
      d = await opendir(dir);
    } catch (err) {
      throw new TransferError("no-path", `${dir} can't be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}).`);
    }
    for await (const e of d) {
      const m = `${member}/${e.name}`;
      if (excluded(m) || e.isSocket()) continue;
      const p = join(dir, e.name);
      members.push(m);
      if (e.isDirectory()) subdirs.push({ dir: p, member: m });
      else if (e.isFile()) {
        root.files++;
        root.bytes += (await lstat(p)).size;
        if (e.name === ".git") await gitlink(p, m, name, offered, warnings);
      }
    }
    // Reversed onto the stack, so directories are walked in the order they were listed.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  return { root, members };
}

/** A `.git` file whose gitdir is absolute, or relative but outside every offered root: no history travels. */
async function gitlink(file: string, member: string, rootName: string, offered: readonly string[], warnings: LinkOfferWarning[]): Promise<void> {
  let text: string;
  try {
    text = (await readFile(file, "utf8")).slice(0, 4096);
  } catch {
    return;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return;
  const gitdir = m[1]!;
  if (!isAbsolute(gitdir) && offered.some((r) => isWithin(resolve(dirname(file), gitdir), r))) return;
  warnings.push({ kind: "gitlink", root: rootName, path: member, gitdir });
}

// ---- the spool (the sender) -----------------------------------------------------------------------

export interface SpoolStatus {
  state: "packing" | "ready" | "failed";
  /** Compressed bytes written so far. */
  written: number;
  error?: string;
}

export interface PackResult {
  sha256: string;
  size: number;
  packedAt: number;
  /** GNU tar's exit 1: a file changed while it was read. The archive is still whole. */
  warning?: LinkOfferWarning;
}

/**
 * The sender's spools, packed one at a time on this host. `status` is in memory: after a restart
 * a spool on disk is ready (it was renamed into place only when complete) and a `.part` is not.
 */
export class Spools {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly state = new Map<string, SpoolStatus>();
  private readonly running = new Map<string, { kill(): void }>();
  private readonly removed = new Set<string>();

  constructor(private readonly deps: { root(): string; now?(): number; log?(line: string): void }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private log(line: string): void {
    (this.deps.log ?? console.log)(`[links] ${line}`);
  }

  file(offerId: string): string {
    return spoolFile(this.deps.root(), offerId);
  }

  status(offerId: string): SpoolStatus | null {
    const s = this.state.get(offerId);
    if (s) return s;
    try {
      return { state: "ready", written: statSync(this.file(offerId)).size };
    } catch {
      return null;
    }
  }

  /**
   * Pack `listing` into the offer's spool (queued behind any other pack on this host). Resolves
   * with the snapshot; rejects with a TransferError: no-space (the disk filled), tar-failed, or
   * internal (the pack was removed while it ran).
   */
  pack(offerId: string, listing: OfferListing, onWritten?: (written: number) => void): Promise<PackResult> {
    this.removed.delete(offerId);
    this.state.set(offerId, { state: "packing", written: 0 });
    const run = () => this.packNow(offerId, listing, onWritten);
    const job = this.chain.then(run, run);
    this.chain = job.catch(() => undefined);
    return job;
  }

  private async packNow(offerId: string, listing: OfferListing, onWritten?: (written: number) => void): Promise<PackResult> {
    const st = this.state.get(offerId)!;
    const final = this.file(offerId);
    const part = `${final}.part`;
    const fail = (reason: OfferRefusal, message: string): never => {
      rmSync(part, { force: true });
      st.state = "failed";
      st.error = message;
      throw new TransferError(reason, message);
    };
    if (this.removed.has(offerId)) fail("internal", "The offer was withdrawn before it was packed.");
    mkdirSync(spoolDir(this.deps.root()), { recursive: true, mode: 0o700 });
    const z = createZstdCompress();
    const hash = createHash("sha256");
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        st.written += chunk.length;
        onWritten?.(st.written);
        cb(null, chunk);
      },
    });
    const out = createWriteStream(part, { mode: 0o600 });
    let sinkError: Error | null = null;
    const sink = pipeline(z, counter, out).catch((err: Error) => {
      sinkError = err;
      throw err;
    });
    sink.catch(() => undefined);
    let changed = "";
    let child: ReturnType<typeof spawn> | null = null;
    this.running.set(offerId, { kill: () => child?.kill("SIGKILL") });
    try {
      for (const root of listing.packList) {
        if (this.removed.has(offerId)) break;
        const c = spawn("tar", ["-C", root.parent, "--null", "--no-recursion", "-T", "-", "-cf", "-"], { env: tarEnv(), stdio: ["pipe", "pipe", "pipe"] });
        child = c;
        let stderr = "";
        c.stderr!.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-4096)));
        c.stdin!.on("error", () => undefined); // tar died early: its exit code says why
        c.stdin!.end(Buffer.from(`${root.members.join("\0")}\0`));
        c.stdout!.pipe(z, { end: false });
        const code = await new Promise<number | null>((ok) => {
          c.on("close", (n) => ok(n));
          c.on("error", () => ok(-1));
          void sink.catch(() => c.kill("SIGKILL"));
        });
        child = null;
        c.stdout!.unpipe(z);
        if (sinkError) break;
        if (this.removed.has(offerId)) break;
        if (code === 1) changed = tail(stderr, 512) || "a file changed while it was packed";
        else if (code !== 0) fail("tar-failed", `tar couldn't pack ${root.members[0]} (exit ${code}): ${tail(stderr) || "no message"}`);
      }
      z.end();
      await sink.catch(() => undefined);
    } finally {
      this.running.delete(offerId);
      if (!z.writableEnded) z.destroy();
    }
    if (this.removed.has(offerId)) fail("internal", "The offer was withdrawn while it was packed.");
    if (sinkError) {
      const e = sinkError as NodeJS.ErrnoException;
      if (e.code === "ENOSPC" || e.code === "EDQUOT") fail("no-space", `No room to pack ${mib(listing.bytes)} on this host: its disk filled after ${mib(st.written)} of the spool.`);
      fail("internal", `Packing failed: ${e.message}`);
    }
    renameSync(part, final);
    const size = statSync(final).size;
    st.state = "ready";
    st.written = size;
    this.log(`spool ${offerId} packed: ${mib(size)} for ${listing.files} files (${mib(listing.bytes)})`);
    return { sha256: hash.digest("hex"), size, packedAt: this.now(), ...(changed ? { warning: { kind: "changed" as const, message: changed } } : {}) };
  }

  /** Delete an offer's spool (and stop its pack if it runs). */
  remove(offerId: string): void {
    this.removed.add(offerId);
    this.running.get(offerId)?.kill();
    this.state.delete(offerId);
    for (const f of [this.file(offerId), `${this.file(offerId)}.part`]) removeLogged(f, (l) => this.log(l));
  }

  /** Delete spools and `.part` downloads of offers not in `open` (the caller's open offers). */
  sweep(open: ReadonlySet<string>): void {
    const root = this.deps.root();
    for (const dir of [spoolDir(root), incomingDir(root)]) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const id = n.split(".")[0]!;
        if (open.has(id) || this.running.has(id)) continue;
        removeLogged(join(dir, n), (l) => this.log(l));
      }
    }
  }
}

function removeLogged(file: string, log: (l: string) => void): void {
  let size: number;
  try {
    size = lstatSync(file).size;
  } catch {
    return;
  }
  rmSync(file, { force: true });
  log(`removed ${basename(file)} (${mib(size)})`);
}

// ---- serving the spool ------------------------------------------------------------------------------

/**
 * GET …/offers/:offer/tar once the caller has checked the offer, the caller and the spool
 * (403/404/410/503 are its). `Range: bytes=N-` (or N-M) is honoured when `If-Range` is absent or
 * names this spool's sha256; else the whole spool (200). A client that goes away cancels the web
 * stream, which closes the file. `onServed` gets the highest offset read for this caller.
 */
export function serveTar(o: { file: string; sha256: string; size: number; range?: string | null; ifRange?: string | null; onServed?(maxOffset: number): void }): Response {
  const etag = `"${o.sha256}"`;
  const base = { "Content-Type": "application/zstd", ETag: etag, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  let start = 0;
  let end = o.size - 1;
  let partial = false;
  const m = o.range ? /^bytes=(\d+)-(\d*)$/.exec(o.range.trim()) : null;
  if (m && (!o.ifRange || o.ifRange.trim() === etag)) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(end, Number(m[2]));
    if (start >= o.size || start > end)
      return new Response(JSON.stringify({ error: `Range past the end (${o.size} bytes).` }), { status: 416, headers: { "Content-Type": "application/json", "Content-Range": `bytes */${o.size}`, ETag: etag } });
    partial = true;
  }
  const stream = createReadStream(o.file, { start, end });
  let at = start;
  stream.on("data", (c) => {
    at += c.length;
    o.onServed?.(at);
  });
  const headers: Record<string, string> = { ...base, "Content-Length": String(end - start + 1) };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${o.size}`;
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: partial ? 206 : 200, headers });
}

// ---- the destination (the receiver) ---------------------------------------------------------------

/**
 * `dest` as the receiving host reads it, canonical: `~` and `~/…` from its home, relative from the
 * member's cwd, `..` normalised. Always a directory (each root lands at dest/<its name>).
 */
export function resolveDest(dest: string, o: { cwd: string; home: string }): string {
  if (typeof dest !== "string" || !dest.trim() || dest.includes("\0")) throw new TransferError("bad-dest", "dest must name a directory.");
  const e = expandHome(dest.trim(), o.home);
  if (e === null) throw new TransferError("bad-dest", `dest ${dest}: only ~ and ~/… are expanded, not ~user.`);
  return canonical(resolve(o.cwd, e));
}

/**
 * The checks before anything is pulled. Refused: dest inside Sova's state root or sessions dir,
 * or one of those under dest where an offered root would land on it (protected); dest an existing
 * non-directory (bad-dest); with the sandbox on, dest or a root under it not writable
 * (not-writable). `scan`: the downloaded archive must be pre-scanned before extraction (the
 * sandbox is on, or a protected root lies under dest).
 */
export function checkDest(o: { resolvedDest: string; rootNames: readonly string[]; protectedRoots: readonly string[]; sandbox: SandboxWrite | null }): { scan: boolean } {
  const dest = o.resolvedDest;
  // Root names come from the sender: each must be one plain path component.
  for (const n of o.rootNames)
    if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\0")) throw new TransferError("bad-dest", `The offer names a root ${JSON.stringify(n)} that is not a plain name; nothing was pulled.`);
  const prot = [...new Set(o.protectedRoots.map(canonical))];
  let under = false;
  for (const p of prot) {
    if (isWithin(dest, p)) throw new TransferError("protected", `${dest} is inside Sova's own state (${p}), which a transfer never writes.`);
    if (isWithin(p, dest)) {
      under = true;
      const first = relative(dest, p).split(sep)[0]!;
      if (o.rootNames.includes(first)) throw new TransferError("protected", `${join(dest, first)} would reach into Sova's own state (${p}); choose another dest.`);
    }
  }
  let exists = false;
  try {
    exists = true;
    if (!statSync(dest).isDirectory()) throw new TransferError("bad-dest", `${dest} exists and is not a directory.`);
  } catch (err) {
    if (err instanceof TransferError) throw err;
    exists = false;
  }
  if (o.sandbox) {
    const why = o.sandbox.writeDenial(dest, { creating: !exists });
    if (why) throw new TransferError("not-writable", `${dest} is not writable for this session in its sandbox (${why}).`);
    for (const n of o.rootNames) {
      const at = join(dest, n);
      const w = o.sandbox.writeDenial(at, { creating: true });
      if (w) throw new TransferError("not-writable", `${at} is not writable for this session in its sandbox (${w}).`);
    }
  }
  return { scan: !!o.sandbox || under };
}

// ---- pulling (the receiver) -------------------------------------------------------------------------

export interface PullTimings {
  /** No byte for this long: abort and resume from the `.part`. */
  idleMs: number;
  /** A sender that can't be reached is tried again after this, or at its kick. */
  downWaitMs: number;
  /** The longest wait on a `503 packing`. */
  maxBackoffMs: number;
  /** A 403 (the sender hasn't recorded the accept yet) is retried this many times. */
  forbiddenRetries: number;
}
const DEFAULT_TIMINGS: PullTimings = { idleMs: 60_000, downWaitMs: 60_000, maxBackoffMs: 30_000, forbiddenRetries: 6 };
export const MAX_PULLS = 2;

export interface PullSnapshot {
  sha256: string;
  size: number;
}

export interface PullJob {
  offerId: string;
  linkId: string;
  /** The sender's nodeId. */
  from: string;
  /** Known when the offer came with one; else learnt from the first answer (onSnapshot). */
  snapshot?: PullSnapshot;
  resolvedDest: string;
  rootNames: readonly string[];
  /** The spool's hash and size as the sender first answered them: persist it, so a resume after a restart sends If-Range. */
  onSnapshot?(s: PullSnapshot): void;
  /** Bytes on disk now; `retries` counts resumed attempts. */
  onProgress?(p: { received: number; retries: number; lastByteAt: number }): void;
  /** Verified: the pre-scan and tar start now. */
  onExtracting?(): void;
  /** Throws a TransferError (not-writable | protected | bad-dest) to refuse the archive. */
  prescan?(members: AsyncIterable<TarMember>): Promise<void>;
}

export interface PullDeps {
  root(): string;
  /** GET `path` on the sender's host; throws when it can't be reached. */
  fetchTar(o: { offerId: string; linkId: string; senderNodeId: string; path: string; headers: Record<string, string>; signal: AbortSignal }): Promise<Response>;
  now?(): number;
  timings?: Partial<PullTimings>;
  log?(line: string): void;
}

/** Waiting for a moment that `kick` or `cancel` can end early. */
class Waiter {
  private readonly waits = new Set<{ node: string; offer: string; done(): void }>();
  wait(node: string, offer: string, ms: number): Promise<void> {
    return new Promise((ok) => {
      const w = {
        node,
        offer,
        done: () => {
          clearTimeout(t);
          this.waits.delete(w);
          ok();
        },
      };
      const t = setTimeout(w.done, ms);
      t.unref?.();
      this.waits.add(w);
    });
  }
  wake(pred: (w: { node: string; offer: string }) => boolean): void {
    for (const w of [...this.waits]) if (pred(w)) w.done();
  }
}

/**
 * The receiver's downloads: at most MAX_PULLS moving bytes at once. Each pull appends to its
 * `.part` with `Range` from the bytes already there, aborts after `idleMs` without a byte and
 * resumes, waits out a `503 packing`, and waits for a down sender (kick or `downWaitMs`); then
 * verifies sha256 (a mismatch restarts once from 0), runs the pre-scan, and extracts with
 * `tar -x --ignore-zeros`. Only then is the `.part` deleted.
 */
export class Pulls {
  private readonly t: PullTimings;
  private active = 0;
  private readonly slotQueue: Array<() => void> = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly waiter = new Waiter();

  constructor(private readonly deps: PullDeps) {
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private log(line: string): void {
    (this.deps.log ?? console.log)(`[links] ${line}`);
  }

  private async slot(): Promise<() => void> {
    if (this.active >= MAX_PULLS) await new Promise<void>((ok) => this.slotQueue.push(ok));
    this.active++;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.active--;
      this.slotQueue.shift()?.();
    };
  }

  private check(offerId: string): void {
    if (this.cancelled.has(offerId)) throw new PullCancelled(offerId);
  }

  /** A sender's host came back: pulls waiting on it try at once. */
  kick(nodeId: string): void {
    this.waiter.wake((w) => w.node === nodeId);
  }

  /** Stop a pull (it rejects with PullCancelled) and delete its `.part`. */
  cancel(offerId: string): void {
    this.cancelled.add(offerId);
    this.controllers.get(offerId)?.abort(new PullCancelled(offerId));
    this.waiter.wake((w) => w.offer === offerId);
    rmSync(partFile(this.deps.root(), offerId), { force: true });
  }

  /** Whether a pull of this offer runs here now. */
  running(offerId: string): boolean {
    return this.controllers.has(offerId);
  }

  async pull(job: PullJob): Promise<{ received: number; took: number }> {
    this.cancelled.delete(job.offerId);
    const part = partFile(this.deps.root(), job.offerId);
    mkdirSync(incomingDir(this.deps.root()), { recursive: true, mode: 0o700 });
    const started = this.now();
    let snap = job.snapshot;
    let retries = 0;
    let restarted = false;
    let forbidden = 0;
    let backoff = 5_000;
    const path = `/api/peer/links/${job.linkId}/offers/${job.offerId}/tar`;
    try {
      for (;;) {
        this.check(job.offerId);
        let have = sizeOf(part);
        if (snap && have > snap.size) {
          rmSync(part, { force: true });
          have = 0;
        }
        if (snap && have === snap.size) {
          // Complete: verify, then scan and extract (also a restart that finds it complete).
          const got = await sha256Of(part);
          this.check(job.offerId);
          if (got !== snap.sha256) {
            rmSync(part, { force: true });
            if (restarted) throw new TransferError("bad-hash", `The download of ${job.offerId} didn't match the sender's snapshot twice; nothing was extracted.`);
            restarted = true;
            this.log(`pull ${job.offerId}: hash mismatch, starting over`);
            continue;
          }
          const release = await this.slot();
          try {
            this.check(job.offerId);
            job.onExtracting?.();
            if (job.prescan) {
              // Both streams are closed whatever the pre-scan does (it may refuse before reading).
              const src = createReadStream(part);
              const z = createZstdDecompress();
              src.on("error", (e) => z.destroy(e));
              z.on("error", () => undefined); // surfaced to the reader through its iterator
              try {
                await job.prescan(tarMembers(src.pipe(z)));
              } finally {
                src.destroy();
                z.destroy();
              }
            }
            this.check(job.offerId);
            await extract(part, job.resolvedDest);
          } finally {
            release();
          }
          rmSync(part, { force: true });
          const took = this.now() - started;
          this.log(`pull ${job.offerId}: landed in ${job.resolvedDest} (${mib(snap.size)}, ${Math.round(took / 1000)} s, ${retries} resumes)`);
          return { received: snap.size, took };
        }

        const release = await this.slot();
        let outcome: "again" | "down" | "packing" | "forbidden" = "again";
        let retryAfter = 0;
        const ctl = new AbortController();
        this.controllers.set(job.offerId, ctl);
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ctl.abort(new Error("no bytes for too long")), this.t.idleMs);
          idle.unref?.();
        };
        try {
          attempt: {
            this.check(job.offerId);
            const headers: Record<string, string> = {};
            if (have > 0 && snap) {
              headers.Range = `bytes=${have}-`;
              headers["If-Range"] = `"${snap.sha256}"`;
            }
            arm();
            let res: Response;
            try {
              res = await this.deps.fetchTar({ offerId: job.offerId, linkId: job.linkId, senderNodeId: job.from, path, headers, signal: ctl.signal });
            } catch (err) {
              this.check(job.offerId);
              if (ctl.signal.aborted) retries++;
              else {
                outcome = "down";
                this.log(`pull ${job.offerId}: sender unreachable (${(err as Error).message}); waiting`);
              }
              break attempt;
            }
            if (res.status === 503) {
              await res.body?.cancel();
              retryAfter = Math.min(this.t.maxBackoffMs, Math.max(1_000, (Number(res.headers.get("Retry-After")) || 0) * 1000, backoff));
              backoff = Math.min(this.t.maxBackoffMs, backoff * 2);
              outcome = "packing";
              break attempt;
            }
            if (res.status === 403 && forbidden < this.t.forbiddenRetries) {
              await res.body?.cancel();
              forbidden++;
              outcome = "forbidden";
              break attempt;
            }
            if (res.status === 416) {
              await res.body?.cancel();
              rmSync(part, { force: true });
              if (restarted) throw new TransferError("internal", "The sender refused every range of the spool.");
              restarted = true;
              break attempt;
            }
            if (res.status >= 500) {
              await res.body?.cancel();
              outcome = "down";
              break attempt;
            }
            if (res.status !== 200 && res.status !== 206) {
              const body = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
              const why = typeof body?.error === "string" ? body.error : `answered ${res.status}`;
              const reason = typeof body?.reason === "string" ? (body.reason as OfferRefusal) : "internal";
              throw new TransferError(reason, `The sender won't serve ${job.offerId} (${res.status}): ${why}`);
            }
            forbidden = 0;
            backoff = 5_000;
            const etag = /^"?([0-9a-f]{64})"?$/.exec(res.headers.get("ETag") ?? "")?.[1];
            const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get("Content-Range") ?? "")?.[1]) : Number(res.headers.get("Content-Length"));
            if (!etag || !Number.isFinite(total)) throw new TransferError("internal", "The sender's answer names no spool hash or size.");
            const append = res.status === 206 && have > 0 && snap?.sha256 === etag;
            if (!snap || snap.sha256 !== etag || snap.size !== total) {
              snap = { sha256: etag, size: total };
              job.onSnapshot?.(snap);
            }
            const fh = await open(part, append ? "a" : "w", 0o600);
            let received = append ? have : 0;
            try {
              for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
                arm();
                await fh.write(chunk as Buffer);
                received += (chunk as Buffer).length;
                job.onProgress?.({ received, retries, lastByteAt: this.now() });
              }
            } catch (err) {
              this.check(job.offerId);
              const code = (err as NodeJS.ErrnoException).code;
              if (code === "ENOSPC" || code === "EDQUOT") {
                await fh.close().catch(() => undefined);
                rmSync(part, { force: true });
                throw new TransferError("no-space", `No room on this host for ${mib(snap.size)} of ${job.offerId}; nothing was extracted.`);
              }
              retries++;
              this.log(`pull ${job.offerId}: cut at ${mib(received)} (${(err as Error).message}); resuming`);
            } finally {
              await fh.close().catch(() => undefined);
            }
          }
        } finally {
          clearTimeout(idle);
          this.controllers.delete(job.offerId);
          release();
        }
        if (outcome === "down") {
          retries++;
          await this.waiter.wait(job.from, job.offerId, this.t.downWaitMs);
        } else if (outcome === "packing") await this.waiter.wait("", job.offerId, retryAfter);
        else if (outcome === "forbidden") await this.waiter.wait(job.from, job.offerId, 5_000);
      }
    } catch (err) {
      if (err instanceof PullCancelled || this.cancelled.has(job.offerId)) {
        rmSync(part, { force: true });
        throw new PullCancelled(job.offerId);
      }
      if (err instanceof TransferError) {
        rmSync(part, { force: true });
        throw err;
      }
      const code = (err as NodeJS.ErrnoException).code;
      rmSync(part, { force: true });
      if (code === "ENOSPC" || code === "EDQUOT") throw new TransferError("no-space", `No room on this host to take ${job.offerId}.`);
      throw new TransferError("internal", `The pull of ${job.offerId} failed: ${(err as Error).message}`);
    } finally {
      this.cancelled.delete(job.offerId);
    }
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(file)) h.update(c as Buffer);
  return h.digest("hex");
}

/** The verified archive into dest: zstd → `tar -x --ignore-zeros`. tar-failed on any error. */
async function extract(part: string, dest: string): Promise<void> {
  try {
    mkdirSync(dest, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") throw new TransferError("no-space", `No room on this host to create ${dest}.`);
    throw new TransferError("bad-dest", `${dest} can't be created (${code ?? (err as Error).message}).`);
  }
  if (!statSync(dest).isDirectory()) throw new TransferError("bad-dest", `${dest} exists and is not a directory.`);
  const c = spawn("tar", ["-x", "--ignore-zeros", "--no-same-owner", "-C", dest, "-f", "-"], { env: tarEnv(), stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  c.stderr!.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(-4096)));
  const exited = new Promise<number | null>((ok) => {
    c.on("close", (n) => ok(n));
    c.on("error", () => ok(-1));
  });
  const fed = pipeline(createReadStream(part), createZstdDecompress(), c.stdin!).then(
    () => null,
    (err: Error) => err,
  );
  const [code, feedErr] = await Promise.all([exited, fed]);
  if (code !== 0) {
    const msg = tail(stderr) || (feedErr ? feedErr.message : "no message");
    throw new TransferError(/No space left/i.test(msg) ? "no-space" : "tar-failed", `tar couldn't extract into ${dest} (exit ${code}): ${msg}`);
  }
  if (feedErr) throw new TransferError("tar-failed", `The archive couldn't be read: ${feedErr.message}`);
}
