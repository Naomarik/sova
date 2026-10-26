import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTRACT_FILE, parseDefinition, type ProjectDef } from "../../shared/project-contract";
import type { LeftoverReason } from "../../shared/protocol";
import { numberedPorts, slotLayoutOf } from "../../shared/project-slots";
import type { PortOwner } from "../port-owner";
import { limitInForce } from "./copy-limit";
import { hostPortOwner, hostProcTable } from "./proctable";
import { locksDir, readRegistry, tryLock, type Registry } from "./store";

/**
 * Leftover processes (§app.overseer/copies): a process that listens on one of a project's copy ports
 * (slots 1 to 16, as the main checkout's definition numbers them) and that no copy of Sova's owns. One
 * whose folder is deleted or missing, that runs outside any git checkout, or that runs in a worktree of
 * the project whose commit the main checkout's branch already holds is safe to stop; anything else is in
 * use. Never offered, whatever its folder: Sova's own server and its children, `sova-runtime.service`, a
 * chat process, a copy's or shared service's unit (this state root's or another's), slot 0's adopted unit,
 * and a listener this user can't read. Linux only (/proc). Everything the host gives is injected, so the
 * rules are tested over fakes.
 */

export const LEFTOVER_UNSUPPORTED = "Sova can't tell which process holds a port on this computer.";
export const LEFTOVER_CHANGED = "It is no longer the process your card listed: nothing was stopped.";

/** One process holding a copy port, and Sova's verdict on it. */
export interface LeftoverView {
  project: string;
  slot: number;
  port: number;
  pid: number;
  /** Its start time (with the pid, it tells it from a later process that reused the pid). */
  start: string;
  /** Its command line, redacted, at most 120 characters ("" when unreadable). */
  command: string;
  /** Its working folder, as /proc says it (a deleted one ends " (deleted)"). */
  folder: string;
  /** The systemd unit it runs in, when it is one of the user's own services (not Sova's). */
  unit?: string;
  verdict: { safe: true; reason: LeftoverReason } | { safe: false; why: string };
}

/** A port nobody can read: listed in use, never offered. */
export type UnreadablePort = { project: string; slot: number; port: number; why: string };

type GitOut = { code: number; stdout: string };

/** What the finder reads from the host. */
export interface LeftoverHost {
  platform: NodeJS.Platform;
  portOwner(port: number): PortOwner;
  startOf(pid: number): string | null;
  /** /proc/<pid>/cgroup's text, or null. */
  cgroup(pid: number): string | null;
  /** /proc/<pid>/cmdline's text (NUL-separated), or null. */
  cmdline(pid: number): string | null;
  ppid(pid: number): number | null;
  exists(path: string): boolean;
  git(cwd: string, args: string[]): Promise<GitOut>;
  /** Whether the pid runs a chat process (its command line, so never a pid reused by another program). */
  isChatProcess(pid: number): boolean;
  /** Whether the pid runs inside a unit of a registered copy or shared service (the supervisor's own records). */
  ownedByCopy(pid: number): boolean;
  selfPid: number;
  redact(text: string): string;
  registry(): Registry;
  /** Stop a user service unit (systemctl --user stop). */
  stopUnit(unit: string): Promise<{ code: number; stderr: string }>;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const gitRun = (cwd: string, args: string[]): Promise<GitOut> =>
  new Promise((done) =>
    execFile("git", args, { cwd, timeout: 5_000, encoding: "utf8" }, (err, stdout) => done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout ?? "") })),
  );

const readOr = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** The host as it is. `ownedByCopy` and `isChatProcess` come from the engine's driver and the chat supervisor. */
export function realLeftoverHost(o: { ownedByCopy: (pid: number) => boolean; isChatProcess: (pid: number) => boolean; redact: (t: string) => string; stopUnit: LeftoverHost["stopUnit"] }): LeftoverHost {
  const table = hostProcTable();
  return {
    platform: process.platform,
    portOwner: (p) => hostPortOwner(p),
    startOf: (pid) => table.startOf(pid),
    cgroup: (pid) => readOr(`/proc/${pid}/cgroup`),
    cmdline: (pid) => readOr(`/proc/${pid}/cmdline`),
    ppid: (pid) => table.get(pid)?.ppid ?? null,
    exists: (p) => existsSync(p),
    git: gitRun,
    isChatProcess: o.isChatProcess,
    ownedByCopy: o.ownedByCopy,
    selfPid: process.pid,
    redact: o.redact,
    registry: () => readRegistry(),
    stopUnit: o.stopUnit,
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
      } catch {
        // gone already
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/** The unit a cgroup line names: its last `.service` or `.scope` path part ("0::/user.slice/…/app.slice/foo.service"). */
export function unitOfCgroup(text: string | null): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const path = line.split(":").slice(2).join(":").trim();
    if (!path) continue;
    const parts = path.split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) if (/\.(service|scope)$/.test(parts[i]!)) return parts[i]!;
  }
  return null;
}

/** Why a pid is never offered, or null. */
export function protectedWhy(pid: number, h: Pick<LeftoverHost, "selfPid" | "ppid" | "cgroup" | "isChatProcess" | "ownedByCopy">, adoptedUnits: readonly string[] = []): string | null {
  for (let p: number | null = pid, n = 0; p && p > 1 && n < 64; p = h.ppid(p), n++) if (p === h.selfPid) return "Sova's own server";
  const cg = h.cgroup(pid) ?? "";
  if (cg.includes("/sova-runtime.service")) return "Sova's own server (sova-runtime.service)";
  const own = h.cgroup(h.selfPid);
  const ownUnit = unitOfCgroup(own);
  if (ownUnit && unitOfCgroup(cg) === ownUnit && ownUnit.endsWith(".service")) return "Sova's own server's unit";
  if (h.isChatProcess(pid)) return "a chat process";
  if (/\/sova-(svc|hook)-/.test(cg) || h.ownedByCopy(pid)) return "a copy's own process";
  for (const u of adoptedUnits) if (cg.includes(`/${u.endsWith(".service") ? u : `${u}.service`}`)) return `slot 0's adopted unit ${u}`;
  return null;
}

/** Each copy port of `project` (its usable slots of 1 to 16, ports declared fixed left out), from the main checkout's
    saved definition; null when it has none or it is invalid. */
export function copyPortsOf(project: string, read: (file: string) => string | null = readOr): { def: ProjectDef; ports: { slot: number; port: number }[] } | null {
  const text = read(join(project, CONTRACT_FILE));
  if (text === null) return null;
  let def: ProjectDef;
  try {
    def = parseDefinition(text);
  } catch {
    return null;
  }
  const numbering = limitInForce(project, def).numbering;
  const layout = slotLayoutOf(def, numbering);
  const ports: { slot: number; port: number }[] = [];
  for (const slot of layout.ordinary) {
    const all = numberedPorts(def, numbering, slot);
    for (const s of def.services) {
      if (s.scope !== "checkout") continue;
      for (const [k, decl] of Object.entries(s.ports)) {
        const theirs = numbering?.services.find((x) => x.name === s.name)?.ports[k] ?? decl;
        if ("fixed" in theirs) continue;
        const port = all[s.name]?.[k];
        if (port !== undefined) ports.push({ slot, port });
      }
    }
  }
  return { def, ports };
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Whether a process in `folder` is a leftover of `project`, and why; or why it is in use. */
export async function judgeFolder(project: string, folder: string, h: Pick<LeftoverHost, "exists" | "git" | "registry">): Promise<LeftoverView["verdict"]> {
  if (folder.endsWith(" (deleted)") || !h.exists(folder)) return { safe: true, reason: "folder-gone" };
  const top = await h.git(folder, ["rev-parse", "--show-toplevel"]);
  // git's own "not a git repository" (exit 128); a git that could not run says nothing about the folder.
  if (top.code === 128) return { safe: true, reason: "not-a-checkout" };
  if (top.code !== 0 || !top.stdout.trim()) return { safe: false, why: "its folder can't be read with git" };
  const checkout = canonical(top.stdout.trim());
  const root = canonical(project);
  if (checkout === root) return { safe: false, why: "it runs in the project's main checkout" };
  const copy = h.registry().instances.find((i) => canonical(i.checkout) === checkout);
  if (copy) return { safe: false, why: `it runs in the folder of copy ${copy.id}` };
  const [theirs, ours] = await Promise.all([h.git(checkout, ["rev-parse", "--git-common-dir"]), h.git(root, ["rev-parse", "--git-common-dir"])]);
  const common = (o: GitOut, cwd: string) => (o.code === 0 && o.stdout.trim() ? canonical(resolve(cwd, o.stdout.trim())) : null);
  if (!common(theirs, checkout) || common(theirs, checkout) !== common(ours, root)) return { safe: false, why: "it runs in a checkout of another repository" };
  const dirty = await h.git(checkout, ["status", "--porcelain"]);
  if (dirty.code !== 0) return { safe: false, why: "its checkout can't be read" };
  if (dirty.stdout.trim()) return { safe: false, why: "its worktree has uncommitted edits" };
  const head = await h.git(checkout, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !head.stdout.trim()) return { safe: false, why: "its worktree has no commit yet" };
  const merged = await h.git(root, ["merge-base", "--is-ancestor", head.stdout.trim(), "HEAD"]);
  return merged.code === 0 ? { safe: true, reason: "branch-on-main" } : { safe: false, why: "its branch has commits not on the main checkout's branch" };
}

/** The process on `port` (one of `slot`'s), judged; null when nothing listens there; a copy's own process is left out. */
export async function judgePort(project: string, slot: number, port: number, h: LeftoverHost, adoptedUnits: readonly string[] = []): Promise<LeftoverView | UnreadablePort | null> {
  const o = h.portOwner(port);
  if (o === "none") return null;
  if (o === "unknown") return { project, slot, port, why: "a process this user can't read" };
  const start = h.startOf(o.pid);
  if (!start) return { project, slot, port, why: "a process this user can't read" };
  const prot = protectedWhy(o.pid, h, adoptedUnits);
  if (prot === "a copy's own process") return null;
  const unit = unitOfCgroup(h.cgroup(o.pid));
  const command = cut(h.redact((h.cmdline(o.pid) ?? "").replace(/\0+$/, "").replace(/\0/g, " ").trim()), 120);
  const base = { project, slot, port, pid: o.pid, start, command, folder: o.cwd, ...(unit && userService(unit) ? { unit } : {}) };
  if (prot) return { ...base, verdict: { safe: false, why: prot } };
  return { ...base, verdict: await judgeFolder(project, o.cwd, h) };
}

/** A user service of its own, stopped whole: a `.service` that is not Sova's (sova-…) nor the user manager. */
const userService = (unit: string): boolean => unit.endsWith(".service") && !unit.startsWith("sova-") && !unit.startsWith("user@") && unit !== "init.scope";

/** Every process holding one of `project`'s copy ports, judged (§app.overseer/copies). */
export async function findLeftovers(project: string, h: LeftoverHost, read?: (file: string) => string | null): Promise<{ rows: LeftoverView[]; unreadable: UnreadablePort[] } | { error: string }> {
  if (h.platform !== "linux") return { error: LEFTOVER_UNSUPPORTED };
  const ports = copyPortsOf(project, read);
  if (!ports) return { error: `no valid ${CONTRACT_FILE} in ${project}: its copy ports are unknown` };
  const adopted = ports.def.services.flatMap((s) => (s.adopt ? [s.adopt.unit] : []));
  const rows: LeftoverView[] = [];
  const unreadable: UnreadablePort[] = [];
  for (const { slot, port } of ports.ports) {
    const r = await judgePort(project, slot, port, h, adopted);
    if (!r) continue;
    if ("verdict" in r) rows.push(r);
    else unreadable.push(r);
  }
  return { rows, unreadable };
}

/** The one process on `port` of `project`, judged; or why it can't be listed. For a card's row. */
export async function leftoverOn(project: string, port: number, h: LeftoverHost, read?: (file: string) => string | null): Promise<LeftoverView | { error: string }> {
  if (h.platform !== "linux") return { error: LEFTOVER_UNSUPPORTED };
  const ports = copyPortsOf(project, read);
  if (!ports) return { error: `no valid ${CONTRACT_FILE} in ${project}: its copy ports are unknown` };
  const at = ports.ports.find((p) => p.port === port);
  if (!at) return { error: `port ${port} is not one of ${project}'s copy ports (slots 1 to 16)` };
  const r = await judgePort(project, at.slot, port, h, ports.def.services.flatMap((s) => (s.adopt ? [s.adopt.unit] : [])));
  if (!r) return { error: `nothing that is not a copy's own process listens on port ${port}` };
  if (!("verdict" in r)) return { error: `port ${port} is held by ${r.why}` };
  return r;
}

/** Stop the process a card listed on `port`, after checking it is still that process (pid and start) and still safe. */
export async function stopLeftover(q: { project: string; port: number; pid: number; start: string }, h: LeftoverHost, read?: (file: string) => string | null): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  if (h.platform !== "linux") return { ok: false, text: LEFTOVER_UNSUPPORTED };
  const lock = tryLock(join(locksDir(), `leftover-${q.port}`));
  if ("heldBy" in lock) return { ok: false, text: `another stop of port ${q.port} is running (pid ${lock.heldBy}); try again when it ends` };
  try {
    const now = await leftoverOn(q.project, q.port, h, read);
    if ("error" in now || now.pid !== q.pid || now.start !== q.start) return { ok: false, text: LEFTOVER_CHANGED };
    if (!now.verdict.safe) return { ok: false, text: `It is no longer safe to stop: ${now.verdict.why}. Nothing was stopped.` };
    const freed = () => h.portOwner(q.port) === "none";
    const waitFree = async (ms: number) => {
      for (const until = h.now() + ms; !freed() && h.now() < until; ) await h.sleep(100);
      return freed();
    };
    if (now.unit) {
      const r = await h.stopUnit(now.unit);
      if (r.code !== 0) return { ok: false, text: `stopping its unit ${now.unit} failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      if (await waitFree(5_000)) return { ok: true, text: `Stopped ${now.unit} (pid ${q.pid}): port ${q.port} of slot ${now.slot} is free.` };
      return { ok: false, text: `Stopped ${now.unit}, but port ${q.port} is still held.` };
    }
    h.signal(q.pid, "SIGTERM");
    if (await waitFree(5_000)) return { ok: true, text: `Stopped pid ${q.pid}: port ${q.port} of slot ${now.slot} is free.` };
    // Still the same process? Only then the hard stop.
    if (h.startOf(q.pid) === q.start) h.signal(q.pid, "SIGKILL");
    if (await waitFree(2_000)) return { ok: true, text: `Stopped pid ${q.pid} (killed after 5 s): port ${q.port} of slot ${now.slot} is free.` };
    return { ok: false, text: `Sent pid ${q.pid} SIGTERM and SIGKILL, but port ${q.port} is still held.` };
  } finally {
    lock.release();
  }
}

/** One row as the model reads it. */
export function leftoverLine(r: LeftoverView): string {
  const what = `port ${r.port} (slot ${r.slot}): pid ${r.pid}${r.command ? `, "${r.command}"` : ""}, in ${r.folder}${r.unit ? `, unit ${r.unit}` : ""}`;
  return r.verdict.safe ? `${what} — safe to stop: ${REASON_WORDS[r.verdict.reason]}` : `${what} — in use: ${r.verdict.why}`;
}

export const REASON_WORDS: Record<LeftoverReason, string> = {
  "folder-gone": "its folder was deleted",
  "not-a-checkout": "it runs outside any git checkout",
  "branch-on-main": "its branch is already merged into the main checkout's",
};
