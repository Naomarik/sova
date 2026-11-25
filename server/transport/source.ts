// The source's side of a transport (§app.transport/start, /package, /switch, /copy, /moved-row): the
// device the chat is on decides every step. Your click mints the ticket and sends the offer; then it
// follows the destination until it is ready, packs (a Move first brings the chat and its team to
// rest), says the package is ready, and once the destination has verified it, burns the ticket and
// sends the one commit. Only the destination's answer that the chat opened there moves it; until
// then the chat is this device's. A Move leaves a Moved row and a safety copy here.
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { agentRoot, stateRoot } from "../state-root";
import { chatHome, hasHome } from "../chat-homes/root";
import { git, historyBytes, type LooseFile, LARGE_FILE, looseBytes, submodulesOf, surveyWorktree, type WorktreeSurvey } from "./git-snapshot";
import { bringHelpersToRest, knob, previewExtras } from "./hooks";
import { movedOf } from "./moved";
import { buildPackage } from "./package";
import { readSetupDef, type SetupDef } from "./setup-def";
import { type CarriedSettings, hostCarry } from "./project-carry";
import { activeTransportOf, createTransport, logName, newTicket, newTid, readTransport, type RunningCopy, stepDone, type TransportRecord, updateTransport } from "./store";
import type { AgentView, OfferBody, OfferTree, StatusBody } from "./wire";
import { agentViewOf, peerPath, PROOF_HEADER } from "./wire";

const log = (line: string) => console.log(`[transport] ${line}`);
const spoolDir = () => join(stateRoot(), "transport", "spool");

/** A chat as the source sees it (from the session list's summary). */
export interface ChatFacts {
  id: string;
  path: string;
  title: string;
  cwd: string;
  /** The kind that refuses it, in the dialog's words ("{kind} can't be transported."), or null. */
  specialKind: string | null;
  inTerminal: boolean;
  /** Archive compression packed it (§app.session-list/archive-compression). */
  compressed?: boolean;
  /** Its model, "provider/model", when known. */
  model?: string | null;
}

export interface PeerFacts {
  id: string;
  label: string;
}

/** What the source needs from the rest of the server (the real ones in routes.ts; tests swap them). */
export interface SourceDeps {
  peers(): PeerFacts[];
  selfLabel(): string;
  peerFetch(peerId: string, path: string, init?: RequestInit): Promise<Response>;
  /** Why this host won't talk to that peer now (it reads Update needed), or null. */
  updateNeeded(peerId: string): Promise<string | null>;
  chat(path: string): Promise<ChatFacts | null>;
  /** The worktrees the chat tracks (active ones), canonical paths, and which of them it made itself. */
  trackedTrees(path: string): Promise<{ path: string; own: boolean }[]>;
  /** Whether the branch of the tree at `treePath` waits in a merge queue. */
  inMergeQueue(chatPath: string, treePath: string, branch: string): Promise<boolean>;
  mintProof(peerId: string, body: string): string;
  /** The chat's helpers at every depth (their chat session ids), and whether each is working. */
  helpers(chatId: string): { chatId: string; working: boolean }[];
  /** Stop a helper's process, its record idle. */
  park(chatId: string): Promise<boolean>;
  /** Stop the chat's own process (it reopens on demand). */
  closeChat(path: string, message: string): Promise<void>;
  /** Stop the chat's and its helpers' background jobs: their names. */
  stopJobs(chatIds: string[]): Promise<string[]>;
  /** The chat's background jobs and its helpers', by name (the dialog's Stays here). */
  jobs(chatId: string): string[];
  /** The running copies (project-services instances) on these worktrees: id and name (the dialog's Stays here), and
      the checkout each runs and the services wanted running in it (what the destination starts again). */
  copies(treePaths: string[]): { id: string; name: string; checkout?: string; services?: string[] }[];
  /** Stop these running copies (a Move's switch, the ones your click saw): the names of those stopped. */
  stopCopies(ids: string[]): Promise<string[]>;
  /** The chat's usage and time records, cut from this device's stores for the package (null: none to carry). */
  usageCut(chatId: string, helpers: readonly string[]): Promise<Buffer | null>;
  /** After the destination confirmed: the Moved row, the safety copy, the old code folders. */
  moved(r: TransportRecord): Promise<void>;
  /** Put the Transport agent's card in the chat here (a note that starts no turn). */
  noteAgentCard?(path: string, text: string, card: { tid: string; title: string; device: string }): Promise<boolean>;
  /** This device's host values for the project at `root` (its host.json; read only, never logged). */
  hostValues?(root: string): Record<string, string>;
  /** This device's Sova settings for the project at `root` as they travel (project-carry.ts); null: not a project here. */
  projectSettings?(root: string): Promise<CarriedSettings | null>;
}

let deps: SourceDeps | null = null;
export const setSourceDeps = (d: SourceDeps): void => void (deps = d);
const need = (): SourceDeps => {
  if (!deps) throw new Error("Transport isn't wired on this server.");
  return deps;
};

/** The dialog's refusal words (§design.copy-deck/transport). */
export const REFUSALS = {
  notYou: "Only you start a transport, from this device's page. Nothing was sent.",
  queue: "Its branch is in the merge queue. Transport it once it leaves the queue.",
  noHome: "This chat is from before chat homes, so it can't be transported.",
  update: (d: string) => `${d} needs an update first.`,
  offline: (d: string) => `${d} is offline.`,
  noGrant: (d: string) => `${d} doesn't let this device start chats there.`,
  already: "This chat is already being transported.",
  kind: (k: string) => `${k} can't be transported.`,
  terminal: "A chat open in a terminal can't be transported.",
  moved: (d: string) => `This chat moved to ${d}; it runs there now. Transport it from there.`,
  compressed: "A compressed chat can't be transported.",
};

export interface Trees {
  trees: WorktreeSurvey[];
  /** The tree holding the chat's folder: it goes to the folder chosen there. */
  own: WorktreeSurvey | null;
  owned: Set<string>;
}

/** The chat's worktrees: the one holding its folder, and every one it tracks. */
export async function chatTrees(c: ChatFacts): Promise<Trees> {
  const top = (await git(c.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const tracked = await need().trackedTrees(c.path);
  const paths: string[] = [];
  if (top) paths.push(top);
  for (const t of tracked) if (!paths.includes(t.path) && existsSync(t.path)) paths.push(t.path);
  const names = new Set<string>();
  const trees: WorktreeSurvey[] = [];
  for (const p of paths) {
    let name = basename(p) || "tree";
    for (let i = 2; names.has(name); i++) name = `${basename(p)}-${i}`;
    names.add(name);
    trees.push(await surveyWorktree(name, p));
  }
  // All of one repository: another repository's worktree isn't this chat's code (it stays).
  const own = trees.find((t) => t.path === top) ?? null;
  const keep = own ? trees.filter((t) => t.roots.some((r) => own.roots.includes(r))) : trees;
  return { trees: keep, own, owned: new Set(tracked.filter((t) => t.own).map((t) => t.path)) };
}

export interface Preview {
  chat: { id: string; title: string; path: string };
  refusal: string | null;
  devices: { id: string; label: string; state: "ready" | "offline" | "update" | "no-grant" }[];
  folder: string;
  travels: { conversationBytes: number; code: { branch: string | null; bytes: number }[]; helpers: number; scratch: { dir: string; size: number }[] };
  privateFiles: { tree: string; path: string; size: number }[];
  large: { tree: string; path: string; size: number }[];
  staysHere: { left: string[]; leftBytes: number; jobs: string[]; copies: string[] };
  busyHelpers: { id: string; name: string; role?: string }[];
  needs: string[];
  /** That device lacks the project and can't clone it: it comes from this device, about this many bytes of history. */
  projectFromHere?: { bytes: number };
  /** With the project from here: what its setup definition says that device lacks, set up after it arrives. */
  afterArrival?: string[];
  agentModels: string[];
  agentModelDefault: string | null;
}

async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += await dirBytes(p);
    else if (e.isFile()) n += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return n;
}

const stripCredentials = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");

/** Why chat `c` can't be transported now (before any device is picked), or null. */
async function chatRefusal(c: ChatFacts, t: Trees): Promise<string | null> {
  const moved = movedOf(c.id);
  if (moved) return REFUSALS.moved(moved.to);
  if (c.compressed) return REFUSALS.compressed;
  if (c.specialKind) return REFUSALS.kind(c.specialKind);
  if (c.inTerminal) return REFUSALS.terminal;
  if (!hasHome(c.id)) return REFUSALS.noHome;
  if (activeTransportOf(c.id)) return REFUSALS.already;
  for (const tree of t.trees) {
    if (tree.refusal) return tree.refusal;
    if (tree.branch && (await need().inMergeQueue(c.path, tree.path, tree.branch))) return REFUSALS.queue;
  }
  return null;
}

/** How a device answers this one now: ready, offline, Update needed, or no sessions grant. */
async function deviceState(peerId: string): Promise<{ state: Preview["devices"][number]["state"]; needs?: { needs: string[]; models: string[]; modelDefault: string | null } }> {
  if (await need().updateNeeded(peerId)) return { state: "update" };
  try {
    const res = await need().peerFetch(peerId, peerPath.offer.replace(/offer$/, "hello"), { signal: AbortSignal.timeout(5_000) });
    if (res.status === 403) return { state: "no-grant" };
    if (!res.ok) return { state: "offline" };
    return { state: "ready" };
  } catch {
    return { state: "offline" };
  }
}

/** The dialog's contents for chat `path` (and, with `peerId`, that device's answer). */
export async function previewTransport(path: string, peerId?: string): Promise<Preview> {
  const c = await need().chat(path);
  if (!c) throw new Error("Session file not found");
  const t = await chatTrees(c);
  let refusal = await chatRefusal(c, t);
  const peers = need().peers();
  const devices: Preview["devices"] = [];
  let needs: string[] = [];
  let fromHere = false;
  let after: string[] = [];
  let agentModels: string[] = [];
  let agentModelDefault: string | null = null;
  for (const p of peers) {
    if (peerId && p.id !== peerId) {
      devices.push({ id: p.id, label: p.label, state: "ready" });
      continue;
    }
    const d = await deviceState(p.id);
    devices.push({ id: p.id, label: p.label, state: d.state });
    if (peerId && d.state === "ready") {
      try {
        const res = await need().peerFetch(p.id, "/api/peer/transport/needs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...projectRef(c, t, await projectFolderFor(c, t)), ...(c.model ? { chatModel: c.model } : {}), ...setupOf(c, t) }), signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const a = (await res.json()) as { needs?: string[]; models?: string[]; modelDefault?: string | null; fromSource?: boolean; afterArrival?: string[] };
          needs = a.needs ?? [];
          fromHere = a.fromSource === true;
          after = Array.isArray(a.afterArrival) ? a.afterArrival.filter((x) => typeof x === "string").slice(0, 40) : [];
          agentModels = a.models ?? [];
          agentModelDefault = a.modelDefault ?? null;
        }
      } catch {
        // no answer: nothing listed
      }
    }
    if (peerId && !refusal) {
      if (d.state === "update") refusal = REFUSALS.update(p.label);
      else if (d.state === "offline") refusal = REFUSALS.offline(p.label);
      else if (d.state === "no-grant") refusal = REFUSALS.noGrant(p.label);
    }
  }
  const home = chatHome(c.id);
  const helpers = need().helpers(c.id);
  const extras = await previewExtras(c.id);
  return {
    chat: { id: c.id, title: c.title, path: c.path },
    refusal,
    devices,
    folder: folderFor(c, t),
    travels: {
      conversationBytes: existsSync(home) ? await dirBytes(home) : 0,
      code: t.trees.map((x) => ({ branch: x.branch, bytes: looseBytes(x, ["untracked"]) })),
      helpers: helpers.length,
      scratch: t.trees.flatMap((x) => x.scratch),
    },
    privateFiles: t.trees.flatMap((x) => x.loose.filter((f) => f.kind === "private").map((f) => ({ tree: x.name, path: f.path, size: f.size }))),
    large: t.trees.flatMap((x) => x.loose.filter((f) => f.kind !== "private" && f.size > LARGE_FILE).map((f) => ({ tree: x.name, path: f.path, size: f.size }))),
    staysHere: {
      left: [...new Set(t.trees.flatMap((x) => x.left))],
      leftBytes: (await Promise.all(t.trees.flatMap((x) => x.left.map((d) => dirBytes(join(x.path, d)))))).reduce((n, b) => n + b, 0),
      jobs: need().jobs(c.id),
      copies: need().copies(t.trees.map((x) => x.path)).map((x) => x.name),
    },
    busyHelpers: extras.busyHelpers,
    needs,
    ...(fromHere ? { projectFromHere: { bytes: await historyBytes(t.trees).catch(() => 0) } } : {}),
    ...(fromHere && after.length ? { afterArrival: after } : {}),
    agentModels,
    agentModelDefault,
  };
}

/** The folder there, prefilled: the same path under that device's home. */
function folderFor(c: ChatFacts, t: Trees): string {
  const own = t.own?.path ?? c.cwd;
  const rel = relative(homedir(), own);
  return rel.startsWith("..") ? own : `~/${rel}`;
}

/** The folder that device prepares for the project, as its preparation picks it (destination.ts
    repoPathOf): the repository beside the chat's folder when its tree is a linked worktree, else that folder. */
async function projectFolderFor(c: ChatFacts, t: Trees): Promise<string> {
  const folder = folderFor(c, t);
  const own = t.own;
  if (!own || own.main || t.trees.some((x) => x.main)) return folder;
  const common = (await git(own.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  if (!common) return folder;
  const repo = dirname(common);
  const rel = relative(homedir(), repo);
  return rel.startsWith("..") ? repo : `~/${rel}`;
}

/** The project's own setup definition, read here from the chat's tree (read only), for that device to check against
    itself before the project is there (§app.transport/dialog). */
function setupOf(c: ChatFacts, t: Trees): { setup?: SetupDef } {
  const def = readSetupDef(t.own?.path ?? t.trees[0]?.path ?? c.cwd);
  return def ? { setup: def } : {};
}

function projectRef(c: ChatFacts, t: Trees, folder: string): { remotes: string[]; firstCommit?: string; path: string } {
  const own = t.own ?? t.trees[0];
  return { remotes: (own?.remotes ?? []).map(stripCredentials), ...(own?.roots[0] ? { firstCommit: own.roots[0] } : {}), path: folder };
}

export interface StartBody {
  path: string;
  peer: string;
  mode: "move" | "copy";
  /** Absolute there, or `~/…` (that device's home). */
  folder: string;
  /** Private files left here, as "<tree>/<path>". */
  untick?: string[];
  /** Large files sent anyway, as "<tree>/<path>". */
  include?: string[];
  busyChoice?: "safe" | "interrupt";
  agentModel?: string;
}

/** Your click (the route checked it): mint the ticket, send the offer, follow the destination. */
export async function startTransport(b: StartBody): Promise<{ ok: true; tid: string } | { ok: false; status: number; error: string }> {
  const d = need();
  const c = await d.chat(b.path);
  if (!c) return { ok: false, status: 404, error: "Session file not found" };
  if (b.mode !== "move" && b.mode !== "copy") return { ok: false, status: 400, error: "mode is move or copy" };
  const peer = d.peers().find((p) => p.id === b.peer);
  if (!peer) return { ok: false, status: 400, error: "Pick one of your devices." };
  const t = await chatTrees(c);
  const why = (await chatRefusal(c, t)) ?? ((await d.updateNeeded(peer.id)) ? REFUSALS.update(peer.label) : null);
  if (why) return { ok: false, status: 409, error: why };
  // The folder there: `~/…` is that device's home, which only it knows; it is sent as the source's own spelling.
  const folderThere = typeof b.folder === "string" && b.folder.trim() ? b.folder.trim() : folderFor(c, t);
  const tid = newTid();
  const ticket = newTicket();
  const own = t.own;
  const base = own ? dirname(own.path) : dirname(c.cwd);
  const trees: OfferTree[] = t.trees.map((x) => {
    const rel = x === own ? "" : relative(base, x.path);
    return { name: x.name, branch: x.branch, main: x.main, rel: rel.startsWith("..") ? basename(x.path) : rel, ...(x.head ? { head: x.head } : {}) };
  });
  let repoRel: string | null = null;
  if (own && !own.main) {
    const common = (await git(own.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    repoRel = relative(base, dirname(common));
  }
  createTransport({
    tid,
    side: "source",
    mode: b.mode,
    chatId: c.id,
    sourceChatId: c.id,
    title: c.title,
    peer: peer.id,
    peerLabel: peer.label,
    path: c.path,
    folder: folderThere,
    state: "preparing",
    ticket,
    // The running copies your click saw: only these does the switch stop with your word (a later one asks you).
    choices: { untick: b.untick ?? [], include: b.include ?? [], copies: b.mode === "move" ? d.copies(t.trees.map((x) => x.path)).map((x) => x.id) : [], ...(b.busyChoice ? { busyChoice: b.busyChoice } : {}), ...(b.agentModel ? { agentModel: b.agentModel } : {}) },
    ext: { offerTrees: trees, repoRel },
  });
  const sent = await sendOffer(tid);
  if (!sent.ok) {
    updateTransport(tid, { state: "cancelled", ticket: undefined, ticketBurnt: true });
    return { ok: false, status: 502, error: sent.error };
  }
  log(`${tid}: ${b.mode} of ${c.id} to ${peer.label} started by your click`);
  drive(tid);
  return { ok: true, tid };
}

/** The repository's own folder here for a tree: itself when it is the main checkout, else its common dir's parent. */
async function repoRootOf(tree: { path: string; main: boolean }): Promise<string> {
  if (tree.main) return tree.path;
  const common = (await git(tree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  return common ? dirname(common) : tree.path;
}

/** What the offer carries of the project besides its code: the host values its definition declares with this
    device's values for them (only those names), and this device's Sova settings for it (project-carry.ts). */
async function carriedOf(own: { path: string; main: boolean }): Promise<Pick<OfferBody, "host" | "projectSettings">> {
  const d = need();
  const root = await repoRootOf(own).catch(() => own.path);
  const names = readSetupDef(own.path)?.host ?? [];
  const host = names.length ? hostCarry(names, d.hostValues?.(root) ?? {}) : null;
  let settings: CarriedSettings | null = null;
  try {
    settings = (await d.projectSettings?.(root)) ?? null;
  } catch {
    settings = null;
  }
  return { ...(host ? { host } : {}), ...(settings ? { projectSettings: settings } : {}) };
}

async function sendOffer(tid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = need();
  const r = readTransport(tid)!;
  const ext = (r.ext ?? {}) as { offerTrees?: OfferTree[]; repoRel?: string | null };
  const c = await d.chat(r.path);
  const t = c ? await chatTrees(c) : null;
  const own = t?.own ?? t?.trees[0];
  const folder = r.folder;
  const offer: OfferBody = {
    v: 1,
    tid,
    ticket: r.ticket!,
    mode: r.mode,
    chat: { id: r.chatId, title: r.title },
    folder,
    repoRel: ext.repoRel ?? null,
    project: { remotes: (own?.remotes ?? []).map(stripCredentials), roots: own?.roots ?? [], ...(t && submodulesOf(t.trees).length ? { submodules: submodulesOf(t.trees) } : {}) },
    trees: ext.offerTrees ?? [],
    sourceLabel: d.selfLabel(),
    ...(r.choices?.agentModel ? { model: r.choices.agentModel } : {}),
    ...(c?.model ? { chatModel: c.model } : {}),
    ...(own ? await carriedOf(own) : {}),
  };
  const body = JSON.stringify(offer);
  const proof = d.mintProof(r.peer, body);
  try {
    const res = await d.peerFetch(r.peer, peerPath.offer, { method: "POST", headers: { "content-type": "application/json", [PROOF_HEADER]: proof }, body, signal: AbortSignal.timeout(30_000) });
    if (res.status === 403 && !(await res.clone().json().catch(() => null))?.error) return { ok: false, error: REFUSALS.noGrant(r.peerLabel) };
    if (!res.ok) return { ok: false, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${r.peerLabel} answered ${res.status}` };
    stepDone(tid, "offered");
    return { ok: true };
  } catch {
    return { ok: false, error: REFUSALS.offline(r.peerLabel) };
  }
}

// ---- following the destination ------------------------------------------------------------------

const driving = new Set<string>();
const POLL_MS = 1_500;

/** Follow transport `tid` until it is done, cancelled or needs you (a retry starts it again). */
export function drive(tid: string): void {
  if (driving.has(tid)) return;
  driving.add(tid);
  void (async () => {
    try {
      for (;;) {
        const r = readTransport(tid);
        if (!r || r.side !== "source" || r.state === "done" || r.state === "cancelled" || r.state === "needs-you") return;
        const next = await step(r).catch((err: unknown) => {
          needsYou(tid, err instanceof Error ? err.message : String(err));
          return "stop" as const;
        });
        if (next === "stop") return;
        if (next === "wait") await new Promise((ok) => setTimeout(ok, POLL_MS).unref?.());
      }
    } finally {
      driving.delete(tid);
    }
  })();
}

function needsYou(tid: string, reason: string): void {
  const r = readTransport(tid);
  log(`${tid}: needs you: ${reason}`);
  // Once decided the chat is no longer here: it waits to open there.
  const after = r?.decided ? "The chat opens there once it is finished: press Retry." : "The chat carries on here.";
  updateTransport(tid, { state: "needs-you", needsYou: { reason: `Transport to ${r?.peerLabel ?? "that device"} stopped: ${reason.replace(/\.$/, "")}. ${after}`, at: new Date().toISOString() } });
}

async function statusThere(r: TransportRecord): Promise<StatusBody | null> {
  try {
    const res = await need().peerFetch(r.peer, peerPath.status(r.tid), { signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as StatusBody) : null;
  } catch {
    return null;
  }
}

async function post(r: TransportRecord, path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await need().peerFetch(r.peer, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(120_000) });
  return { ok: res.ok, status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

/** One step of the source's part: "wait" to ask again shortly, "again" at once, "stop" when it ended. */
async function step(r: TransportRecord): Promise<"wait" | "again" | "stop"> {
  const s = await statusThere(r);
  if (!s) return "wait"; // that device is unreachable: ask again (settled at the next contact)
  if (s.state === "unknown") {
    if (r.decided) return needsYou(r.tid, `${r.peerLabel} doesn't know this transport any more`), "stop";
    const sent = await sendOffer(r.tid);
    return sent.ok ? "wait" : (needsYou(r.tid, sent.error), "stop");
  }
  if (s.agent) await followAgent(r, s.agent);
  if (s.state === "needs-you") return needsYou(r.tid, s.needsYou ?? "it stopped there"), "stop";
  if (s.steps.opened) return finish(r, s);
  if (s.steps.verified) {
    if (!r.decided) {
      // The destination verified the package: the ticket is burnt, and the switch decided here.
      if (r.mode === "move" && !(await unchangedSincePack(r))) {
        needsYou(r.tid, "the chat changed here during the switch, so nothing moved; retry to send it again");
        return "stop";
      }
      updateTransport(r.tid, { ticket: undefined, ticketBurnt: true, decided: true, state: "switching" });
      await knob(r.tid, "decided");
      stepDone(r.tid, "decided");
    }
    const cur = readTransport(r.tid)!;
    // Decided: an unreachable destination is asked again at the next contact, never a failure here.
    const running = cur.stopped?.running ?? ((cur.ext ?? {}) as { running?: RunningCopy[] }).running ?? [];
    const res = await post(cur, peerPath.commit(r.tid), { stopped: cur.stopped ?? { jobs: [], copies: [] }, running, interrupted: cur.interrupted ?? [], wrapped: cur.wrapped ?? [] }).catch(() => null);
    if (!res) return "wait";
    if (!res.ok) return res.status >= 500 ? "wait" : (needsYou(r.tid, String(res.body.error ?? `${r.peerLabel} answered ${res.status}`)), "stop");
    return "again";
  }
  if (s.steps.prepared && !r.steps.packed) {
    // That device lacks the project and can't clone it: the package carries the repository too.
    updateTransport(r.tid, { haves: s.haves ?? [], ext: { fromSource: s.fromSource === true, subsFetch: Array.isArray(s.subsFetch) ? s.subsFetch.filter((k) => typeof k === "string").slice(0, 200) : [] } });
    await pack(readTransport(r.tid)!);
    return "again";
  }
  if (r.steps.packed && !s.steps.pulled && s.state === "preparing") {
    const res = await post(r, peerPath.ready(r.tid), r.pkg);
    if (!res.ok) return needsYou(r.tid, String(res.body.error ?? `${r.peerLabel} answered ${res.status}`)), "stop";
    updateTransport(r.tid, { state: "sending" });
    return "wait";
  }
  updateTransport(r.tid, { ...(s.received !== undefined ? { received: s.received } : {}), state: s.steps.pulled ? "checking" : s.steps.prepared ? r.state : "preparing" });
  return "wait";
}

/** The sizes of the chat's conversations as packed: a Move's switch refuses if any grew since. */
async function conversationSizes(home: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const n of await readdir(join(home, "sessions")).catch(() => [] as string[])) out[n] = (await stat(join(home, "sessions", n)).catch(() => ({ size: -1 }))).size;
  return out;
}

async function unchangedSincePack(r: TransportRecord): Promise<boolean> {
  const was = ((r.ext ?? {}) as { sizes?: Record<string, number> }).sizes;
  if (!was) return true;
  const now = await conversationSizes(chatHome(r.chatId));
  return Object.keys(now).length === Object.keys(was).length && Object.entries(now).every(([k, v]) => was[k] === v);
}

const realOf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The running copies on the chat's trees (only `ids` when given), each by the tree it runs, its name and the services
    wanted running in it: what the destination starts again once the chat is there. */
export function runningOn(d: Pick<SourceDeps, "copies">, trees: readonly { name: string; path: string }[], ids: ReadonlySet<string> | null): RunningCopy[] {
  const byPath = new Map(trees.map((t) => [realOf(t.path), t.name]));
  return d
    .copies(trees.map((t) => t.path))
    .filter((x) => ids === null || ids.has(x.id))
    .flatMap((x) => {
      const tree = x.checkout ? byPath.get(realOf(x.checkout)) : undefined;
      return tree ? [{ tree, name: x.name, services: [...(x.services ?? [])] }] : [];
    });
}

/** A Move's switch, then the package (a Copy packs as it is). */
async function pack(r: TransportRecord): Promise<void> {
  const d = need();
  const c = await d.chat(r.path);
  if (!c) throw new Error("The chat's file is gone here.");
  if (r.mode === "move") {
    // A running copy started after your click wasn't in what you agreed to stop: it is yours to stop first.
    const seen = new Set(r.choices?.copies ?? []);
    const later = d.copies((await chatTrees(c)).trees.map((x) => x.path)).filter((x) => !seen.has(x.id));
    if (later.length) throw new Error(`${later.length === 1 ? `Running copy ${later[0]!.name} started` : `Running copies ${later.map((x) => x.name).join(", ")} started`} after you pressed Move; stop ${later.length === 1 ? "it" : "them"}, then Retry`);
    updateTransport(r.tid, { state: "waiting-helpers" });
    const ctl = new AbortController();
    const helpers = d.helpers(c.id);
    // Every helper there was before the switch, for the usage cut (an interrupted one may not be listed after).
    updateTransport(r.tid, { ext: { helperIds: helpers.map((h) => h.chatId) } });
    let interrupted: string[] = [];
    let wrapped: string[] = [];
    const rest = bringHelpersToRest(c.id, r.choices?.busyChoice ?? "safe", (waiting) => void updateTransport(r.tid, { ext: { waiting } }), { signal: ctl.signal });
    if (rest) {
      const got = await rest;
      interrupted = got.interrupted;
      wrapped = got.wrapped;
    } else interrupted = helpers.filter((h) => h.working).map((h) => h.chatId);
    updateTransport(r.tid, { state: "switching" });
    // Deepest first: a helper's helpers stop before it.
    for (const h of [...helpers].reverse()) await d.park(h.chatId);
    const jobs = await d.stopJobs([c.id, ...helpers.map((h) => h.chatId)]);
    // Which services ran on which tree, read before they stop: the destination starts the same ones (§app.transport/agent).
    const before = runningOn(d, (await chatTrees(c)).trees, new Set(r.choices?.copies ?? []));
    const copies = await d.stopCopies(r.choices?.copies ?? []);
    const running = before.filter((x) => copies.includes(x.name));
    await d.closeChat(c.path, `This chat is moving to ${r.peerLabel}.`);
    await knob(r.tid, "stopped");
    stepDone(r.tid, "stopped", { stopped: { jobs, copies, ...(running.length ? { running } : {}) }, interrupted, wrapped });
  } else {
    // A Copy stops nothing here: what runs for the chat now is what the copy there starts too.
    const running = runningOn(d, (await chatTrees(c)).trees, null);
    if (running.length) updateTransport(r.tid, { ext: { running } });
  }
  updateTransport(r.tid, { state: "packing" });
  const t = await chatTrees(c);
  const untick = new Set(r.choices?.untick ?? []);
  const include = new Set(r.choices?.include ?? []);
  const skip = (name: string, f: LooseFile) => untick.has(`${name}/${f.path}`) || (f.kind !== "private" && f.size > LARGE_FILE && !include.has(`${name}/${f.path}`));
  await mkdir(spoolDir(), { recursive: true, mode: 0o700 });
  const home = chatHome(c.id);
  const sizes = await conversationSizes(home);
  const cur = readTransport(r.tid)!;
  // A Move's cost goes with it, marked there as spent here; a Copy is a new chat, its past cost stays this chat's.
  const usage = r.mode === "move" ? await d.usageCut(c.id, ((readTransport(r.tid)?.ext ?? {}) as { helperIds?: string[] }).helperIds ?? []).catch((err: unknown) => (log(`${logName(r)}: its usage records stay here: ${err instanceof Error ? err.message : String(err)}`), null)) : null;
  const packed = await buildPackage({
    tid: r.tid,
    spool: spoolDir(),
    mode: r.mode,
    chat: { id: c.id, title: c.title, cwd: c.cwd, file: basename(c.path) },
    source: { nodeLabel: d.selfLabel(), stateRoot: stateRoot(), agentDir: agentRoot(), home, homeDir: homedir(), codeRoot: resolve(import.meta.dirname, "..", "..") },
    trees: t.trees,
    haves: cur.haves ?? [],
    skip,
    ...(cur.stopped ? { stopped: cur.stopped } : {}),
    interrupted: cur.interrupted ?? [],
    wrapped: cur.wrapped ?? [],
    usage,
    ...(((cur.ext ?? {}) as { fromSource?: boolean }).fromSource ? { repo: true } : {}),
    subsFetch: ((cur.ext ?? {}) as { subsFetch?: string[] }).subsFetch ?? [],
  });
  await knob(r.tid, "packed");
  stepDone(r.tid, "packed", {
    pkg: { sha256: packed.sha256, size: packed.size },
    ext: { sizes, ownedTrees: [...t.owned], packedTrees: t.trees.map((x) => ({ name: x.name, path: x.path, main: x.main })), statusOf: Object.fromEntries(packed.manifest.worktrees.map((w) => [w.path, w.meta.statusSha])) },
  });
  log(`${logName(r)}: packed ${Math.round(packed.size / 1024)} KB`);
}

/**
 * The Transport agent there, as that device reports it: kept on the record (the agent's card here reads it) and,
 * the first time, its card put in the chat (§app.transport/agent), only before the switch stops the chat: a card
 * put then would change what was packed.
 */
async function followAgent(r: TransportRecord, a: AgentView): Promise<void> {
  const ext = (r.ext ?? {}) as { agentCard?: string; agent?: AgentView };
  const view = agentViewOf(a);
  if (JSON.stringify(ext.agent) !== JSON.stringify(view)) updateTransport(r.tid, { ext: { agent: view } });
  if (ext.agentCard === a.sessionId || r.steps.stopped || r.decided || r.steps.packed || !need().noteAgentCard) return;
  const device = a.device ?? r.peerLabel;
  // Mid-turn the chat takes no note: the next look puts it in.
  const put = await need()
    .noteAgentCard!(r.path, `The Transport agent "${a.title}" is getting ${device} ready for this chat.`, { tid: r.tid, title: a.title, device })
    .catch((err: unknown) => (log(`${r.tid}: its agent's card wasn't put in the chat: ${err instanceof Error ? err.message : String(err)}`), false));
  if (put) updateTransport(r.tid, { ext: { agentCard: a.sessionId } });
}

/** The destination said the chat opened there: the Move is done here (the Copy too). */
async function finish(r: TransportRecord, s: StatusBody): Promise<"stop"> {
  if (!r.decided) updateTransport(r.tid, { ticket: undefined, ticketBurnt: true, decided: true });
  if (r.mode === "move" && !r.steps.confirmed) {
    if (s.path) updateTransport(r.tid, { ext: { arrivedPath: s.path }, ...(s.arrivedId ? { arrivedId: s.arrivedId } : {}) });
    await need().moved(readTransport(r.tid)!);
  }
  // What the Transport agent sets up there after arrival: the done line says so (§design.copy-deck/transport).
  const settingUp = Array.isArray(s.settingUp) ? s.settingUp.filter((x) => typeof x === "string").slice(0, 20) : [];
  stepDone(r.tid, "confirmed", { state: "done", ...(s.arrivedId ? { arrivedId: s.arrivedId } : {}), ...(s.renamed ? { renamed: s.renamed } : {}), ...(s.path || settingUp.length ? { ext: { ...(s.path ? { arrivedPath: s.path } : {}), ...(settingUp.length ? { settingUp } : {}) } } : {}) });
  log(`${logName(r)}: ${r.mode === "move" ? "moved" : "copied"} to ${r.peerLabel}`);
  return "stop";
}

/** The package, for the ticket's route: its file, hash and size; null when it isn't served (any doubt is no). */
export function servedPackage(tid: string): { file: string; sha256: string; size: number } | null {
  const r = readTransport(tid);
  if (!r?.pkg || r.side !== "source" || r.ticketBurnt) return null;
  const file = join(spoolDir(), `${tid}.tar.zst`);
  return existsSync(file) ? { file, ...r.pkg } : null;
}

/** Retry (the page's button): ask again from what arrived. */
export async function retryTransport(tid: string): Promise<{ ok: boolean; error?: string }> {
  const r = readTransport(tid);
  if (!r || r.side !== "source") return { ok: false, error: "No such transport" };
  if (r.state === "done" || r.state === "cancelled") return { ok: true };
  // A switch that changed here meanwhile is packed again; one the destination already holds goes on.
  const repack = r.mode === "move" && !r.decided && r.steps.packed && !(await unchangedSincePack(r));
  updateTransport(tid, { state: "preparing", needsYou: undefined, attempt: r.attempt + 1, ...(repack ? { steps: { offered: r.steps.offered } } : {}) });
  const res = await post(r, peerPath.retry(tid), {}).catch(() => null);
  // That device dropped a package it couldn't build on (a submodule's remote didn't give its commits): packed again,
  // with what it now asks for (that submodule's whole history).
  if (res?.body.repack === true && !r.decided) updateTransport(tid, { steps: { offered: r.steps.offered } });
  drive(tid);
  return { ok: true };
}

/** Cancel: what arrived there is removed; refused once the chat was published there. */
export async function cancelTransport(tid: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const r = readTransport(tid);
  if (!r || r.side !== "source") return { ok: false, status: 404, error: "No such transport" };
  if (r.state === "done") return { ok: false, status: 409, error: "It already moved." };
  let res: Awaited<ReturnType<typeof post>> | null = null;
  try {
    res = await post(r, peerPath.cancel(tid), {});
  } catch {
    if (r.decided) return { ok: false, status: 409, error: `${r.peerLabel} is offline; it may hold the chat already. Try again once it is back.` };
  }
  if (res && res.status === 409 && res.body.published) {
    drive(tid);
    return { ok: false, status: 409, error: "It already arrived there." };
  }
  updateTransport(tid, { state: "cancelled", ticket: undefined, ticketBurnt: true });
  await rm(join(spoolDir(), `${tid}.tar.zst`), { force: true });
  return { ok: true, status: 200 };
}

/** At start: transports this server was following go on. */
export function resumeSources(list: readonly TransportRecord[]): void {
  for (const r of list) if (r.side === "source" && r.state !== "done" && r.state !== "cancelled" && r.state !== "needs-you") drive(r.tid);
}

