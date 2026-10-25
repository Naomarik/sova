import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { StateView } from "../../shared/harness";
import { normalizeTourSourceRequest, tourSourceProblem, type TourSource, type TourSourceRequest } from "../../shared/tour";
import { branchOf, readPi } from "../harness/pi/reader";
import { stateView } from "../harness/state-view";
import { SANDBOX, WORKER_SESSION, WORKTREES } from "../harness/state-kinds";
import { agentRoot, stateRoot } from "../state-root";
import { isStarting } from "../../pi-config/extensions/sandbox/state.ts";
import { readRegistry, type Registry } from "../project-services/store";
import type { TourToolCaller } from "./tools";
import type { TourRecordingContext } from "./sandbox";

/** The sandbox the chat process holding this chat reports for it now: the same in-memory branch its own tools run under. */
export interface TourHeldSandbox { on: boolean; enforcement: string; starting?: boolean }
export interface TourContextSnapshot {
  sessionId: string; sessionFile: string; cwd: string; state: StateView; agentDir: string;
  /** undefined: this server holds no process for the chat; null: its runtime has no sandbox (or did not answer). */
  held?: TourHeldSandbox | null;
  /** The cwd is the home folder standing in for the chat's folder, which is gone: never a writable root (§app.shell/missing-folder-home). */
  cwdStandIn?: boolean;
}
export interface TourContextDeps {
  snapshot?: (caller: TourToolCaller) => Promise<TourContextSnapshot>;
  registry?: () => Registry;
  projects?: () => Promise<readonly { id: string; root: string }[]>;
  canonical?: (path: string) => string;
}
/** Re-read the server-owned file, never a session id, cwd or sandbox declaration in tool input. */
async function snapshot(caller: TourToolCaller): Promise<TourContextSnapshot> {
  const currentFile = async () => { try { return await readPi(caller.sessionFile); } catch { throw new Error("Recording refused: the owning chat cannot be read."); } };
  let file = await currentFile();
  if (file.header?.id !== caller.sessionId) throw new Error("Recording refused: the owning chat identity changed.");
  const { rememberTourOwner } = await import("./ownership");
  if (!await rememberTourOwner(caller.sessionId, caller.sessionFile)) throw new Error("Recording refused: the owning chat's private recovery identity could not be retained.");
  file = await currentFile();
  const { isTourSessionDeleted } = await import("./deleted");
  if (file.header?.id !== caller.sessionId || isTourSessionDeleted(stateRoot(), caller.sessionId)) throw new Error("Recording refused: the owning chat identity is no longer active.");
  const { chatHandle, cwdOverride } = await import("../chat-handle");
  const cwd = chatHandle(caller.sessionFile)?.mirror.cwd || cwdOverride(caller.sessionFile) || file.header?.cwd;
  if (!cwd) throw new Error("Recording refused: the owning chat's working folder is unavailable.");
  // The chat's own sandbox as the process holding it reports it now (in its own process, or here).
  const info = (i: { on: boolean; enforcement: string; starting?: true } | null): TourHeldSandbox | null => i ? { on: i.on, enforcement: i.enforcement, ...(i.starting ? { starting: true } : {}) } : null;
  const handle = chatHandle(caller.sessionFile);
  let held: TourHeldSandbox | null | undefined;
  let cwdStandIn = !!handle?.mirror.cwdFallback;
  if (handle) held = await handle.sandboxInfo().then(info, () => null);
  else {
    const local = (await import("../chat-manager")).heldChat(caller.sessionFile);
    if (local) { try { held = info(local.sandboxInfo()); } catch { held = null; } cwdStandIn = !!local.cwdFallback; }
  }
  return { sessionId: file.header.id, sessionFile: caller.sessionFile, cwd, state: stateView(branchOf(file.entries)), agentDir: agentRoot(), held, ...(cwdStandIn ? { cwdStandIn } : {}) };
}
export async function resolveTourContext(caller: TourToolCaller, deps: TourContextDeps = {}): Promise<TourRecordingContext> {
  const value = await (deps.snapshot ?? snapshot)(caller);
  if (value.sessionId !== caller.sessionId || value.sessionFile !== caller.sessionFile || !isAbsolute(value.cwd) || !isAbsolute(value.agentDir)) throw new Error("Recording refused: the owning chat context cannot be established.");
  // A worker marker cannot establish inherited policy, including write-only scope when on=false.
  if (value.state.has(WORKER_SESSION)) throw new Error("Recording refused: the worker's parent sandbox scope is unavailable. Ask the owning chat to record this tour.");
  const active = effectiveSandbox(value.state.latest(SANDBOX)?.data, value.held);
  if (!active) throw new Error("Recording refused: this chat's sandbox state can't be established. Open this chat in Sova so its sandbox is running, then retry. Recording never changes or bypasses the chat's sandbox.");
  if (active.starting) throw new Error("Recording refused: this chat's sandbox is still turning on. Retry in a moment.");
  if (active.on && !["full", "partial"].includes(active.enforcement)) throw new Error("Recording refused: the chat's sandbox is unavailable or not enforced locally.");
  const canonical = deps.canonical ?? realpathSync;
  const cwd = canonical(value.cwd);
  const worktreeRoots = value.state.latest(WORKTREES)?.data.trees.filter(t => t.status === "active").map(t => canonical(t.path)) ?? [];
  return { sessionId: value.sessionId, sessionFile: value.sessionFile, cwd, agentDir: value.agentDir, sandbox: { on: active.on, worktreeRoots, ...(value.cwdStandIn ? { cwdWritable: false as const } : {}) } };
}
/**
 * The state the chat's own tools run under. A recorded On entry always confines. Otherwise only the
 * process holding the chat may say what its tools run under now (On or Off): nothing runs unconfined
 * without a live process vouching for it, and the policy's default is never read.
 */
function effectiveSandbox(recorded: { on?: unknown; enforcement?: unknown; reasons?: unknown } | undefined, held: TourHeldSandbox | null | undefined): { on: boolean; enforcement: string; starting: boolean } | undefined {
  // A held runtime that reports no sandbox state cannot vouch for anything, whatever the file says.
  if (held === null) return undefined;
  // Turning on (the extension's provisional entry, from either source): On, nothing enforced yet.
  const recordedStarting = recorded?.on === true && isStarting({ on: true, enforcement: String(recorded.enforcement) as "unavailable", reasons: Array.isArray(recorded.reasons) ? recorded.reasons.filter((r): r is string => typeof r === "string") : undefined });
  const starting = recordedStarting || held?.starting === true;
  if (recorded?.on === true) return { on: true, enforcement: String(recorded.enforcement ?? "none"), starting };
  if (held && typeof held.on === "boolean") return { on: held.on, enforcement: String(held.enforcement), starting };
  return undefined;
}
/**
 * A project source names only the running copy (instanceId) and its endpoint; Sova fills in the rest
 * from server-held state: the registry record, which must be the chat's own checkout or an active
 * tracked worktree, and the registered project whose root is that record's project. A supplied
 * projectId or checkout is only compared with what Sova derived, never used to find anything, and a
 * mismatch is refused naming the field. Refusals never echo a supplied path.
 */
export async function resolveTourSource(context: TourRecordingContext, requested: TourSourceRequest, deps: TourContextDeps = {}): Promise<TourSource> {
  const source = normalizeTourSourceRequest(requested);
  if (!source) throw new Error(tourSourceProblem(requested) ?? "Recording refused: invalid source identity.");
  if (source.kind === "site") return source;
  const canonical = deps.canonical ?? realpathSync;
  const allowed = [context.cwd, ...(context.sandbox.worktreeRoots ?? [])].map(p => canonical(p));
  const record = (deps.registry ?? readRegistry)().instances.find(r => r.id === source.instanceId);
  // Before anything of the record's project is read: another project's copy is never this chat's.
  const checkout = record ? canonical(record.checkout) : undefined;
  if (!record || !checkout || !allowed.includes(checkout)) throw new Error("Recording refused: source.instanceId is not a running copy of this chat's project (its checkout or an active tracked worktree).");
  const ports = record.ports[source.serviceId];
  if (!ports || !Number.isInteger(ports[source.endpoint])) {
    const declared = Object.entries(record.ports).flatMap(([service, eps]) => Object.keys(eps).map(ep => `serviceId "${service}", endpoint "${ep}"`));
    throw new Error(`Recording refused: source.serviceId and source.endpoint must name a declared port of that copy, the port name alone: ${declared.join("; ") || "it declares none"}.`);
  }
  const projects = await (deps.projects ?? (async () => (await import("../projects/spaces")).listProjects()))();
  const project = projects.find(p => { try { return canonical(p.root) === canonical(record.project); } catch { return false; } });
  if (!project) throw new Error("Recording refused: this running copy's project isn't registered here.");
  if (source.projectId !== undefined && source.projectId !== project.id) throw new Error(`source.projectId doesn't match this running copy's project (${project.id}). Omit it and Sova fills it in.`);
  if (source.checkout !== undefined) {
    let supplied: string | undefined;
    try { supplied = canonical(source.checkout); } catch { supplied = undefined; }
    if (supplied !== checkout) throw new Error(`source.checkout doesn't match this running copy's checkout (${checkout}). Omit it and Sova fills it in.`);
  }
  return { kind: "project", projectId: project.id, instanceId: record.id, checkout, serviceId: source.serviceId, endpoint: source.endpoint };
}
/** Used by operator HTTP actions; no path or policy is accepted in their bodies. */
export async function tourCallerBySession(sessionId: string): Promise<TourToolCaller> {
  const { indexedSessionPaths, listSessions } = await import("../sessions-index");
  let path = indexedSessionPaths().get(sessionId);
  if (!path) { await listSessions(); path = indexedSessionPaths().get(sessionId); }
  const { resolveSessionPath } = await import("../paths");
  const file = path ? resolveSessionPath(path) : null;
  if (!file) throw new Error("The owning chat is unavailable.");
  const parsed = await readPi(file);
  if (parsed.header?.id !== sessionId) throw new Error("The owning chat identity changed.");
  return { sessionId, sessionFile: file, cwd: parsed.header.cwd ?? "", state: stateView(branchOf(parsed.entries)) };
}
