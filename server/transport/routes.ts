// Transport's routes and its wiring into the server (§app/transport). The page's routes answer only
// this host's own listener, and every act takes only your click on this device's page
// (§app.access/your-click). The peer routes: every one but the package's is a sessions route on the
// destination (server/mesh/access.ts); the package's belongs to no grant and checks the one-time
// ticket itself (§mesh.peers/transport-ticket), comparing in constant time and never logging it.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { rename, rm as rmAsync } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ENTRY_FINAL } from "../../shared/merge-queue";
import { chatJobs, stopJobsOf } from "../background-jobs";
import { emitChatNews } from "../chat-home-events";
import { acquireChatHandle, closeChat, setChatStartGuard } from "../chat-handle";
import { adoptArrivedHome, forgetWorkerChats, parkWorkerChat, steerWorkerChat, workerMembersOf, workersWorkingOf } from "../chat-host";
import { chatHome, homesRoot } from "../chat-homes/root";
import { cancelChatWakes } from "../wake-keeper-live";
import { readBranch } from "../harness/pi/reader";
import { sessionsChanged } from "../list-generation";
import { mintClickProof } from "../mesh/click-proof";
import type { MeshApi } from "../mesh/index";
import { serveTar } from "../mesh/links-transfer";
import { localRequest } from "../mesh/proxy";
import { isArchived, setArchived } from "../archived-sessions";
import { pageOnlyRefusal } from "../page-only";
import { hostVars, readRegistry, setHostVars } from "../project-services/store";
import { carriedSettingsOf, type CarryDeps, registerArrived } from "./project-carry";
import { resolveSessionPath } from "../paths";
import { archiveSession, cleanupSessions, getSessionSummary, listSessions, markArchived } from "../sessions-index";
import { stateRoot } from "../state-root";
import { cutChatUsage, importChatUsage } from "../usage-export";
import { worktreesOf } from "../worktrees-state";
import * as dest from "./destination";
import { AGENT_CARD_NOTE } from "./destination";
import { cleanSetupDef } from "./setup-def";
import { git, publishTrees, rebuildWorktrees } from "./git-snapshot";
import { isTransportAgent, needsAnswer, setAfterArrival, setBringHelpersToRest, setInterruptWaiting, setIsTransportAgent, setNeedsAnswer, setPrepareDestination, setPreviewExtras, interruptWaiting, releasePause, type ProjectRef } from "./hooks";
import { allMoved, markMoved, MOVE_BACK_MS, movedOf, unmarkMoved } from "./moved";
import type { PackageManifest } from "./package";
import { extractKeeping, keepAndRemoveTree, restoreKept, type TreeUser, treesToRetire, unzstd } from "./retire";
import { cancelTransport, previewTransport, REFUSALS, resumeSources, retryTransport, servedPackage, setSourceDeps, startTransport } from "./source";
import { activeTransportOf, listTransports, publicView, readTransport, type TransportRecord, updateTransport } from "./store";
import { type AgentView, agentViewOf, peerPath, PROOF_HEADER, TICKET_HEADER } from "./wire";
import { setTransportSetupRun } from "./agent-tool";

const small = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const log = (line: string) => console.log(`[transport] ${line}`);

/** Every caller but your page here is told where to click, and nothing happens. */
const YOUR_CLICK = { overseer: REFUSALS.notYou, local: REFUSALS.notYou, chat: REFUSALS.notYou, script: REFUSALS.notYou, extension: REFUSALS.notYou };

/** A special chat's kind, in the refusal's words ("{kind} can't be transported."), as Fork refuses them. */
function specialKind(s: { id: string; overseer?: true; baton?: unknown; projectOverseer?: unknown; org?: unknown; workerSession?: true; target?: string }): string | null {
  if (s.overseer) return "The Overseer";
  if (s.projectOverseer) return "A project overseer";
  if (s.baton) return "A hand-off session";
  if (s.org) return "An organization session";
  if (s.workerSession) return "A helper's own chat";
  if (s.target) return "A chat whose tools run on a remote target";
  if (isTransportAgent(s.id)) return "A transport's own agent";
  return null;
}

const digest = (body: string) => createHash("sha256").update(body).digest("hex");

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Mesh = Pick<MeshApi, "enabled" | "requestPeer" | "peerFetch" | "peers" | "self" | "updateNeeded">;

/** The chats here (not archived, not moved away, not in `exclude`) that work in one of `trees`: their folder is in it,
    or, for a chat whose folder is elsewhere in the same repository, its worktree list tracks it. */
async function liveTreeUsers(trees: readonly string[], exclude: ReadonlySet<string>): Promise<TreeUser[]> {
  if (!trees.length) return [];
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const within = (p: string, t: string) => p === t || p.startsWith(`${t}/`);
  // The repository's every worktree: a chat in one of them may track the packed ones.
  const repoTrees = new Set<string>(trees.map(real));
  for (const t of trees) for (const l of (await git(t, ["worktree", "list", "--porcelain"])).stdout.split("\n")) if (l.startsWith("worktree ")) repoTrees.add(real(l.slice(9)));
  const out: TreeUser[] = [];
  for (const s of await listSessions()) {
    if (exclude.has(s.id) || isArchived(s.id) || s.moved || !s.cwd) continue;
    const cwd = real(s.cwd);
    if (![...repoTrees].some((t) => within(cwd, t))) continue;
    const tracked = trees.some((t) => within(cwd, real(t))) ? [] : (worktreesOf((await readBranch(s.path).catch(() => null)) ?? [])?.trees ?? []).filter((x) => x.status === "active").map((x) => x.path);
    out.push({ id: s.id, cwd: s.cwd, trees: tracked });
  }
  return out;
}

/** Once the destination confirmed a Move: the Moved row, the safety copy, the worktrees here removed. */
async function moved(r: TransportRecord): Promise<void> {
  const ext = (r.ext ?? {}) as { packedTrees?: { name: string; path: string; main: boolean }[] };
  // The package carried the wakes; here they are cancelled, the lead's and every helper's at any depth, so nothing
  // wakes the copy left behind. Then the team leaves this server's memory: archiving must not end their records.
  const team = workerMembersOf(r.chatId).map((m) => m.sid);
  for (const id of [r.chatId, ...team]) cancelChatWakes(id, Date.now(), undefined, () => []);
  forgetWorkerChats(team);
  const arrivedPath = ((r.ext ?? {}) as { arrivedPath?: string }).arrivedPath;
  markMoved(r.chatId, { tid: r.tid, peer: r.peer, to: r.peerLabel, at: new Date().toISOString(), arrivedId: r.arrivedId ?? r.chatId, ...(arrivedPath ? { arrivedPath } : {}) });
  // The Moved row is archived as every archive is (markArchived: the mark, the quiet close, its links), never through
  // Archive's own path, which would take a chat with no message yet for an empty husk and delete it, safety copy and
  // all. A home's shared folder is kept by an archive.
  await markArchived(r.chatId, r.path);
  // The safety copy keeps the package: the code exactly as it left, every commit and change.
  const home = chatHome(r.chatId);
  const spool = join(stateRoot(), "transport", "spool", `${r.tid}.tar.zst`);
  if (existsSync(spool)) {
    mkdirSync(join(home, "transport"), { recursive: true, mode: 0o700 });
    await rename(spool, join(home, "transport", `${r.tid}.tar.zst`)).catch((err) => log(`${r.tid}: package not kept in the safety copy: ${err.message}`));
  }
  // Every worktree that travelled goes, so the branch can't be landed from two devices, whoever made it (the chat,
  // its team, a script, you), but never before the folder is in the safety copy whole (ignored files, build output,
  // what was left unticked or written since): nothing is deleted that isn't kept. The main checkout (the project
  // itself) and a worktree another chat here still works in stay, each with a line saying why.
  const packed = (ext.packedTrees ?? []).filter((t) => existsSync(t.path));
  const helpers = ((r.ext ?? {}) as { helperIds?: string[] }).helperIds ?? [];
  const users = await liveTreeUsers(packed.filter((t) => !t.main).map((t) => t.path), new Set([r.chatId, ...team, ...helpers]));
  for (const c of treesToRetire(packed, users)) {
    if (!c.retire) {
      if (!packed.find((t) => t.path === c.path)?.main) log(`${r.tid}: ${c.path} stays here: ${c.why}`);
      continue;
    }
    const p = c.path;
    // Kept whole (its submodules' git data too), read back, then removed; one that can't be kept whole stays.
    const done = await keepAndRemoveTree(p, join(home, "transport"), r.tid, c.name);
    if (!done.removed) {
      log(`${r.tid}: ${p} stays: ${done.why}`);
      continue;
    }
    log(`${r.tid}: ${p} kept in the safety copy (${done.entries} entries, ${Math.round(done.size / 1024)} KB) and removed`);
    const common = done.common;
    updateTransport(r.tid, (cur) => ({ ext: { removedTrees: [...(((cur.ext ?? {}) as { removedTrees?: unknown[] }).removedTrees ?? []), { name: c.name, path: p, common }] } }));
  }
  emitChatNews({ name: "chat.removed", chat: r.chatId, home });
  sessionsChanged();
}

/** Whether a Moved row can come back, and how (§app.transport/moved-row): Move Back for 7 days while nothing happened there, then Copy Back. */
export async function backState(r: TransportRecord, mesh: Pick<Mesh, "peerFetch">): Promise<{ can: "move" | "copy" | null; reason?: string; peer: string; to: string; path?: string }> {
  const m = movedOf(r.chatId);
  const base = { peer: r.peer, to: r.peerLabel, ...(m?.arrivedPath ? { path: m.arrivedPath } : {}) };
  if (!m || m.tid !== r.tid) return { ...base, can: null, reason: "This chat runs here." };
  const ext = (r.ext ?? {}) as { compressedAt?: string };
  if (Date.now() - Date.parse(m.at) > MOVE_BACK_MS || ext.compressedAt) return { ...base, can: "copy" };
  try {
    const res = await mesh.peerFetch(r.peer, peerPath.status(r.tid), { signal: AbortSignal.timeout(8_000) });
    if (res.status === 403) return { ...base, can: null, reason: REFUSALS.noGrant(r.peerLabel) };
    if (!res.ok) return { ...base, can: null, reason: REFUSALS.offline(r.peerLabel) };
    const s = (await res.json()) as { turned?: boolean; movedBack?: boolean };
    // Already stopped there for a Move Back that stopped partway here: it runs nowhere, so Move Back again finishes it.
    return { ...base, can: s.movedBack === true || s.turned === false ? "move" : "copy" };
  } catch {
    return { ...base, can: null, reason: REFUSALS.offline(r.peerLabel) };
  }
}

/** Move Back on this device (the chat's first one): the other device stops it, then it runs here again from its safety copy. */
export async function moveBackToHere(r: TransportRecord, mesh: Pick<Mesh, "peerFetch">): Promise<{ ok: boolean; error?: string }> {
  const st = await backState(r, mesh);
  if (st.can !== "move") return { ok: false, error: st.reason ?? `It has changed on ${r.peerLabel}, so this copies it back as a new chat.` };
  // Your click here, proven to the other device over this very request (as an offer's is).
  const body = JSON.stringify({ path: r.path });
  const res = await mesh.peerFetch(r.peer, peerPath.moveBack(r.tid), { method: "POST", headers: { "content-type": "application/json", [PROOF_HEADER]: mintClickProof(r.peer, body) }, body, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!res) return { ok: false, error: REFUSALS.offline(r.peerLabel) };
  if (!res.ok) return { ok: false, error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${r.peerLabel} answered ${res.status}` };
  // From here the chat runs nowhere until it is restored: a failure is retried (the other side answers "again").
  const home = chatHome(r.chatId);
  const removed = ((r.ext ?? {}) as { removedTrees?: { name: string; path: string; common: string }[] }).removedTrees ?? [];
  const at = join(dest.incomingRoot(), `${r.tid}-back`);
  try {
    if (removed.length) {
      await rmAsync(at, { recursive: true, force: true });
      mkdirSync(at, { recursive: true, mode: 0o700 });
      const pkg = join(home, "transport", `${r.tid}.tar.zst`);
      await unzstd(pkg, join(at, "pkg.tar"));
      await extractKeeping(join(at, "pkg.tar"), at);
      const manifest = JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as PackageManifest;
      const metas = manifest.worktrees.filter((w) => removed.some((x) => x.name === w.name)).map((w) => w.meta);
      const targets = Object.fromEntries(removed.map((x) => [x.name, x.path]));
      const repo = removed[0] ? dirname(removed[0].common) : null;
      const staged = await rebuildWorktrees({ repo, codeDir: join(at, "code"), tid: r.tid, metas, targets });
      await publishTrees(staged, r.tid);
      // What never travelled (build output, unticked files, its submodules' own git data) comes back from what was
      // kept; nothing is replaced.
      for (const x of removed) await restoreKept(join(home, "transport"), r.tid, x.name, x.path, at);
    }
    unmarkMoved(r.chatId);
    const a = await archiveSession(r.path, false);
    if (!a.ok) log(`${r.tid}: unarchive after Move Back: ${a.error}`);
    adoptArrivedHome(r.chatId);
    sessionsChanged();
    emitChatNews({ name: "chat.created", chat: r.chatId, home });
    updateTransport(r.tid, { ext: { movedBack: new Date().toISOString(), removedTrees: [] } });
    log(`${r.tid}: moved back from ${r.peerLabel}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${r.tid}: Move Back stopped: ${msg}`);
    return { ok: false, error: `Move Back from ${r.peerLabel} stopped: ${msg}. Press Move Back again to continue.` };
  } finally {
    await rmAsync(at, { recursive: true, force: true }).catch(() => {});
  }
}

/** The safety copy of a Move older than 7 days is compressed, never removed (§app.transport/moved-row). */
async function compressOldSafetyCopies(): Promise<void> {
  const now = Date.now();
  const paths: string[] = [];
  const tids: string[] = [];
  for (const [, m] of Object.entries(allMoved())) {
    if (now - Date.parse(m.at) <= MOVE_BACK_MS) continue;
    const r = readTransport(m.tid);
    if (!r || r.side !== "source" || ((r.ext ?? {}) as { compressedAt?: string }).compressedAt) continue;
    paths.push(r.path);
    tids.push(r.tid);
  }
  if (!paths.length) return;
  const res = await cleanupSessions({ mode: "paths", paths, dryRun: false, action: "compress", by: "auto" } as never);
  const done = new Set((res as { compressedIds?: string[] }).compressedIds ?? []);
  for (const tid of tids) {
    const r = readTransport(tid);
    if (r && done.has(r.chatId)) updateTransport(tid, { ext: { compressedAt: new Date().toISOString() } });
  }
  log(`compressed ${done.size} safety copies older than 7 days`);
}

/** Why a query or body has a key the route doesn't take, or null. */
/** The running copies (instances wanting a service running) on these worktrees, named as Running Copies names
    them: the branch, else the folder. A project's main copy (slot 0) isn't the chat's to stop: it stays. */
function runningCopiesOn(paths: string[] | null): { id: string; name: string }[] {
  const at = new Set((paths ?? []).map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  }));
  try {
    return readRegistry()
      .instances.filter((i) => i.slot !== 0 && (paths === null || at.has(i.checkout)) && Object.values(i.desired ?? {}).includes("running"))
      .map((i) => ({ id: i.id, name: i.branch ?? basename(i.checkout) }));
  } catch {
    return [];
  }
}

function unknownKeys(keys: Iterable<string>, allowed: readonly string[]): string | null {
  for (const k of keys) if (!allowed.includes(k)) return `This route doesn't take ${JSON.stringify(k.slice(0, 40))}.`;
  return null;
}

/** POST /api/transport's body, each field refused for itself. */
function startBodyRefusal(b: unknown): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "Expected a JSON body { path, peer, mode, folder }.";
  const o = b as Record<string, unknown>;
  const extra = unknownKeys(Object.keys(o), ["path", "peer", "mode", "folder", "untick", "include", "busyChoice", "agentModel"]);
  if (extra) return extra;
  if (typeof o.path !== "string" || !o.path) return "path must be the chat's conversation file.";
  if (typeof o.peer !== "string" || !o.peer || o.peer.length > 200) return "peer must name one of your devices.";
  if (o.mode !== "move" && o.mode !== "copy") return "mode must be move or copy.";
  if (typeof o.folder !== "string" || !o.folder.trim() || o.folder.length > 4096) return "folder must name the folder on that device.";
  for (const k of ["untick", "include"] as const)
    if (o[k] !== undefined && (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === "string"))) return `${k} must be a list of files, as tree/path.`;
  if (o.busyChoice !== undefined && o.busyChoice !== "safe" && o.busyChoice !== "interrupt") return "busyChoice must be safe or interrupt.";
  if (o.agentModel !== undefined && typeof o.agentModel !== "string") return "agentModel must be a model's name.";
  return null;
}

/** Why a chat at `path` doesn't start here: it moved away, or a Move's switch has it (from the stop until it opens there,
    and after the decision even while that waits for a Retry). A chat here again after Move Back starts as before. */
export function startRefusal(path: string): string | null {
  const sessions = dirname(path);
  if (basename(sessions) !== "sessions") return null;
  const home = dirname(sessions);
  if (dirname(home) !== homesRoot()) return null;
  const id = basename(home);
  const m = movedOf(id);
  if (m) return `This chat moved to ${m.to}; it runs there now.`;
  const r = activeTransportOf(id);
  if (r && r.side === "source" && r.mode === "move" && r.steps.stopped && (r.decided || r.state !== "needs-you"))
    return r.decided ? `This chat is moving to ${r.peerLabel} and opens there once that finishes: press Retry on its transport if it stopped. Nothing was sent.` : `This chat is moving to ${r.peerLabel}. Nothing was sent.`;
  return null;
}

/**
 * The arrival opens the chat to write its note, and an archived chat opens for nothing: one that arrived archived
 * (archived where it came from) is opened with its mark held off, then archived again (`rearchive`, which sets the
 * mark before anything else): the chat stays archived as it came.
 */
export async function openKeepingArchive(path: string, open: () => Promise<void>, rearchive: () => Promise<void>): Promise<void> {
  const id = basename(dirname(dirname(path)));
  const was = isArchived(id);
  if (was) setArchived(id, false);
  try {
    await open();
  } finally {
    if (was) await rearchive().catch((err: unknown) => log(`${id}: archiving it again after the arrival note failed (${err instanceof Error ? err.message : String(err)})`));
  }
}

/** An archived arrival, its note written: archived again as every archive is (markArchived: its mark first, then the
    quiet close), never through Archive's own path, which would take a chat with no message yet for an empty husk and
    delete it with its home. An arrival never deletes anything. */
export async function closeArrivedArchived(path: string): Promise<void> {
  await markArchived(basename(dirname(dirname(path))), path);
}

/** Whether the arrived home says its chat is archived (the mark travels in `<home>/chat/meta.json`). */
function homeArchived(id: string): boolean {
  try {
    const v = JSON.parse(readFileSync(join(chatHome(id), "chat", "meta.json"), "utf8")) as Record<string, unknown>;
    const m = v["archived-sessions.json"];
    return Array.isArray(m) && m.includes(id);
  } catch {
    return false;
  }
}

/**
 * The chat's home has just arrived here: this server's marks follow what it came with. A chat coming home to a device
 * it once moved away from drops its old Moved row's mark here, and the archive mark is the arrived home's own (an old
 * Moved row's archive goes; one the chat came with is kept and shown at once, not only after a restart).
 */
export function cameBack(id: string): void {
  if (movedOf(id)) {
    unmarkMoved(id);
    log(`${id}: came back here; its old Moved mark is cleared`);
  }
  const want = homeArchived(id);
  if (isArchived(id) !== want) setArchived(id, want);
}

/** The project registry and its settings stores, as a transport reads and fills them (project-carry.ts). */
async function liveCarryDeps(): Promise<CarryDeps> {
  const [{ listProjects, registerProjectIn }, po, approvals] = await Promise.all([import("../projects/spaces"), import("../project-overseer-store"), import("../project-skills-store")]);
  return {
    projects: () => listProjects().map((p) => ({ id: p.id, name: p.name, root: p.root })),
    canonical: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return resolve(p);
      }
    },
    readOverseer: (id) => {
      try {
        const j = JSON.parse(readFileSync(po.projectOverseerPaths(id).settings, "utf8")) as unknown;
        return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    readApprovals: (id) => approvals.readApprovalStore().folders[approvals.projectFolderKey(id)] ?? null,
    // The same registration as adding a project (§app/projects), a folder's.
    register: async (root, name) => (await registerProjectIn("standalone", root, { ...(name ? { name } : {}), origin: "folder" })).project.id,
    writeOverseer: (id, raw) => void po.writePoSettings(po.projectOverseerPaths(id), po.parsePoSettings(raw)),
    writeApprovals: (id, d) =>
      void approvals.updateApprovalStore((st) => {
        st.folders[approvals.projectFolderKey(id)] = { context: d.context, skills: d.skills };
      }),
  };
}

/** What the card asks you, answered where the agent works (agent.ts allowDownloads / markAdminDone, from agent-wire). */
type AskAnswerFn = (tid: string, id: unknown) => Promise<{ ok: true; agent: AgentView; handed: Promise<void> } | { ok: false; status: 404 | 409 | 500; error: string }>;
const askAnswers: { downloads: AskAnswerFn | null; admin: AskAnswerFn | null } = { downloads: null, admin: null };

/** Why `id` isn't a download list's id (dl_…) or a command's (ad_…), or null. */
function askIdRefusal(kind: "downloads" | "admin", id: unknown): string | null {
  const [key, what, pattern] = kind === "downloads" ? (["plan", "download list", /^dl_[0-9a-f]{12}$/] as const) : (["step", "command", /^ad_[0-9a-f]{12}$/] as const);
  if (typeof id !== "string") return `${key} must be a string: the ${what}'s id.`;
  return pattern.test(id) ? null : `${JSON.stringify(id.slice(0, 40))} isn't a ${what}'s id (${kind === "downloads" ? "dl_" : "ad_"} and 12 hex digits).`;
}

/**
 * Your Allow Downloads or Done on the Transport card (§app.transport/agent), after the page-only check: on the device the
 * agent works on it is answered here; on the device the chat comes from it goes to that device with your click proven
 * over that very request (as Move Back's is), and the card's view of the agent takes its answer.
 */
async function answerAsk(kind: "downloads" | "admin", r: TransportRecord, id: unknown, mesh: Pick<Mesh, "peerFetch">): Promise<{ status: number; body: Record<string, unknown> }> {
  const bad = askIdRefusal(kind, id);
  if (bad) return { status: 400, body: { error: bad } };
  if (r.side === "destination") {
    const fn = askAnswers[kind];
    if (!fn) return { status: 409, body: { error: "This device runs no Transport agent." } };
    const res = await fn(r.tid, id);
    if (!res.ok) return { status: res.status, body: { error: res.error } };
    void res.handed.catch((err: unknown) => log(`${r.tid}: the agent wasn't told: ${err instanceof Error ? err.message : String(err)}`));
    log(`${r.tid}: ${kind === "downloads" ? "downloads allowed" : "a command run"} by your click`);
    return { status: 200, body: { ok: true, agent: agentViewOf(res.agent) } };
  }
  const body = JSON.stringify(kind === "downloads" ? { plan: id } : { step: id });
  const path = kind === "downloads" ? peerPath.allowDownloads(r.tid) : peerPath.adminDone(r.tid);
  const res = await mesh.peerFetch(r.peer, path, { method: "POST", headers: { "content-type": "application/json", [PROOF_HEADER]: mintClickProof(r.peer, body) }, body, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res) return { status: 409, body: { error: REFUSALS.offline(r.peerLabel) } };
  const j = ((await res.json().catch(() => null)) ?? {}) as { error?: string; agent?: AgentView };
  if (!res.ok) return { status: res.status === 403 ? 403 : 409, body: { error: j.error ?? `${r.peerLabel} answered ${res.status}` } };
  if (j.agent && typeof j.agent.sessionId === "string") updateTransport(r.tid, { ext: { agent: agentViewOf(j.agent) } });
  return { status: 200, body: { ok: true, ...(j.agent ? { agent: agentViewOf(j.agent) } : {}) } };
}

export function mountTransport(app: Hono, mesh: Mesh): void {
  setChatStartGuard(startRefusal);
  // The page's routes answer this host's own page whether or not the mesh is on (no devices: none to pick).
  const local = (c: Context) => localRequest(c);

  setSourceDeps({
    peers: () => mesh.peers().map((p) => ({ id: p.id, label: p.label })),
    selfLabel: () => mesh.self().label,
    peerFetch: mesh.peerFetch,
    updateNeeded: mesh.updateNeeded,
    chat: async (path) => {
      const s = await getSessionSummary(path);
      return s ? { id: s.id, path: s.path, title: s.title || s.id, cwd: s.cwd, specialKind: specialKind(s), inTerminal: !!s.live, ...(s.compressed ? { compressed: true } : {}), model: s.model } : null;
    },
    trackedTrees: async (path) => {
      const s = await getSessionSummary(path);
      const set = worktreesOf(await readBranch(path));
      return (set?.trees ?? []).filter((t) => t.status === "active").map((t) => ({ path: t.path, own: t.session === s?.id && t.how === "created" }));
    },
    inMergeQueue: async (_chat, treePath, branch) => {
      const { branchQueueFields } = await import("../merge-queue/wire");
      const q = (await branchQueueFields(treePath, branch)).fields.queue;
      return !!q && !ENTRY_FINAL.includes(q.state);
    },
    mintProof: (peerId, body) => mintClickProof(peerId, body),
    helpers: (chatId) => workersWorkingOf(chatId).map((w) => ({ chatId: w.chatId, working: w.working })),
    park: parkWorkerChat,
    closeChat: async (path, message) => void (await closeChat(path, message, { quiet: "archived" })),
    stopJobs: async (ids) => {
      const names = ids.flatMap((id) => chatJobs(id, new Map()).map((j) => j.command));
      await stopJobsOf(ids, "archive");
      return names;
    },
    jobs: (chatId) => {
      try {
        return chatJobs(chatId, new Map(workerMembersOf(chatId).map((m) => [m.sid, m.workerId]))).map((j) => j.command);
      } catch {
        return [];
      }
    },
    copies: (paths) => runningCopiesOn(paths),
    stopCopies: async (ids) => {
      const stopped: string[] = [];
      const copies = runningCopiesOn(null).filter((c) => ids.includes(c.id));
      if (!copies.length) return stopped;
      const { projectEngine } = await import("../project-services/routes");
      const engine = projectEngine();
      for (const c of copies) {
        // Your click on Move is the operator's word for it (a copy with a share link asks for one).
        const r = await engine.run("down", { instance: c.id, confirm: true }, { kind: "operator", confirm: true }).catch((err: unknown) => ({ ok: false, error: { code: "failed", message: err instanceof Error ? err.message : String(err) } }));
        if (r.ok) stopped.push(c.name);
        else log(`running copy ${c.name} (${c.id}) didn't stop at the switch: ${r.error?.message ?? "failed"}`);
      }
      return stopped;
    },
    usageCut: (chatId, helpers) => cutChatUsage(chatId, helpers),
    moved,
    noteAgentCard: async (path, text, card) => (await acquireChatHandle(path)).appendNote(AGENT_CARD_NOTE, text, card),
    hostValues: (root) => hostVars(root),
    projectSettings: async (root) => carriedSettingsOf(root, await liveCarryDeps()),
  });

  // Whether that device really minted this click proof for this body (asked back once, burnt there).
  const clickProvenBy = async (peerId: string, proof: string, body: string): Promise<boolean> => {
    try {
      const res = await mesh.peerFetch(peerId, "/api/peer/click-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof, digest: digest(body) }), signal: AbortSignal.timeout(10_000) });
      return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
    } catch {
      return false;
    }
  };
  dest.setDestinationDeps({
    peerFetch: mesh.peerFetch,
    clickProven: clickProvenBy,
    adopt: (homeId) => {
      const n = adoptArrivedHome(homeId);
      log(`home ${homeId} arrived: ${n} helper records tracked`);
    },
    openWithNote: (path, text) =>
      openKeepingArchive(
        path,
        async () => {
          const h = await acquireChatHandle(path);
          if (!(await h.appendNote("sova-transport-arrival", text))) log(`the arrival note for ${path} could not be written`);
        },
        () => closeArrivedArchived(path),
      ),
    tellHelper: steerWorkerChat,
    helperNote: (device, interrupted) =>
      interrupted
        ? `This chat moved from ${device} while you were working, and your turn was interrupted. Folders and ports may differ here. Continue where you stopped.`
        : `This chat moved from ${device}. Folders and ports may differ here. Continue where you left off.`,
    cameBack,
    importUsage: (bytes, from) => ({ ...importChatUsage(bytes, { from }) }),
    titleOf: async (path) => (await getSessionSummary(path))?.title || null,
    noteAgentCard: async (path, text, card) => (await acquireChatHandle(path)).appendNote(AGENT_CARD_NOTE, text, card),
    registerArrived: async (root, settings) => registerArrived(root, settings, await liveCarryDeps()),
    hostHeld: (root) => new Set(Object.keys(hostVars(root))),
    writeHostValues: (root, values) => setHostVars(root, values),
  });

  // The Transport agent and Safe Transport, when this build has them (server/transport/agent-wire.ts).
  void import("./agent-wire")
    .then((m) => {
      const h = m.transportHelpers(
        app,
        (tid, a) => void updateTransport(tid, { ext: { agent: a } }),
        (tid, reason) => {
          log(`${tid}: ${reason}`);
          updateTransport(tid, { ext: { agentBlocked: reason } });
        },
      );
      // Their worktree branch is a name; a detached HEAD's is "".
      const named = <T extends { worktrees: { name: string; branch: string | null }[] }>(req: T) => ({ ...req, worktrees: req.worktrees.map((w) => ({ ...w, branch: w.branch ?? "" })) });
      setPrepareDestination((req, o) => h.prepareDestination(named(req), o));
      setAfterArrival((req) => h.afterArrival(named(req)));
      setNeedsAnswer((p, opts) => h.needsAnswer(p, opts));
      setBringHelpersToRest((chatId, mode, onProgress, o) => h.bringHelpersToRest(chatId, mode, onProgress, o));
      setInterruptWaiting((chatId) => h.interruptWaiting(chatId));
      setIsTransportAgent((id) => h.isTransportAgent(id));
      setPreviewExtras(async (chatId) => ({ busyHelpers: await h.busyHelpers(chatId) }));
      setTransportSetupRun(h.setupRun);
      askAnswers.downloads = h.allowDownloads;
      askAnswers.admin = h.adminDone;
    })
    .catch((err) => log(`no Transport agent in this build: ${err instanceof Error ? err.message : String(err)}`));

  // The device a chat moved to, asked to give it back: stop it here, park its team, and become the Moved side.
  dest.setMoveBackHere(async (r, back) => {
    const id = r.arrivedId ?? r.chatId;
    const helpers = workerMembersOf(id).map((m) => m.sid);
    for (const h of [...helpers].reverse()) await parkWorkerChat(h);
    for (const w of [id, ...helpers]) cancelChatWakes(w, Date.now(), undefined, () => []);
    await closeChat(r.path, `This chat is moving back to ${r.peerLabel}.`, { quiet: "archived" });
    forgetWorkerChats(helpers);
    markMoved(id, { tid: r.tid, peer: r.peer, to: r.peerLabel, at: new Date().toISOString(), arrivedId: r.sourceChatId, arrivedPath: back.path });
    // As at a Move's source: markArchived, never Archive's empty-husk deletion.
    await markArchived(id, r.path);
    emitChatNews({ name: "chat.removed", chat: id, home: chatHome(id) });
    sessionsChanged();
  });
  // Safety copies past their 7 days: checked 10 minutes after start, then every 6 hours.
  const pass = () => void compressOldSafetyCopies().catch((err) => log(`safety-copy compression: ${err instanceof Error ? err.message : String(err)}`));
  setTimeout(pass, 10 * 60_000).unref?.();
  setInterval(pass, 6 * 3_600_000).unref?.();

  // Transports this server was in the middle of go on (settled at the next contact).
  const all = listTransports();
  resumeSources(all);
  dest.resumeDestinations(all);

  // ---- the page (this host's own listener) ------------------------------------------------------

  app.get("/api/transport/preview", async (c) => {
    if (!local(c)) return notFound(c);
    const extra = unknownKeys(Object.keys(c.req.queries()), ["path", "peer"]);
    if (extra) return c.json({ error: extra }, 400);
    const path = resolveSessionPath(c.req.query("path") ?? null);
    if (!path) return c.json({ error: "Invalid or missing path" }, 400);
    const peer = c.req.query("peer");
    if (peer !== undefined && !mesh.peers().some((p) => p.id === peer)) return c.json({ error: "peer must name one of your devices." }, 400);
    try {
      return c.json(await previewTransport(path, peer));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/api/transport", small, async (c) => {
    if (!local(c)) return notFound(c);
    const refused = pageOnlyRefusal(c, YOUR_CLICK);
    if (refused) return c.json({ error: refused, yourClick: true }, 403);
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const bad = startBodyRefusal(raw);
    if (bad) return c.json({ error: bad }, 400);
    const b = raw as Parameters<typeof startTransport>[0];
    const path = resolveSessionPath(b.path);
    if (!path) return c.json({ error: "path must be the chat's conversation file." }, 400);
    const r = await startTransport({ ...b, path });
    return r.ok ? c.json({ tid: r.tid, transport: publicView(readTransport(r.tid)!) }, 201) : c.json({ error: r.error }, r.status as 400);
  });

  app.get("/api/transport", (c) => {
    if (!local(c)) return notFound(c);
    const extra = unknownKeys(Object.keys(c.req.queries()), ["session"]);
    if (extra) return c.json({ error: extra }, 400);
    const id = c.req.query("session");
    const list = listTransports().filter((r) => !id || r.chatId === id || r.sourceChatId === id || r.arrivedId === id);
    return c.json({ transports: list.map(publicView) });
  });

  app.get("/api/transport/:tid", (c) => {
    if (!local(c)) return notFound(c);
    const r = readTransport(c.req.param("tid"));
    return r ? c.json(publicView(r)) : notFound(c);
  });

  for (const act of ["retry", "cancel", "interrupt"] as const)
    app.post(`/api/transport/:tid/${act}`, small, async (c) => {
      if (!local(c)) return notFound(c);
      const refused = pageOnlyRefusal(c, YOUR_CLICK);
      if (refused) return c.json({ error: refused, yourClick: true }, 403);
      const tid = c.req.param("tid");
      const r = readTransport(tid);
      if (!r) return notFound(c);
      if (act === "interrupt") return c.json({ ok: interruptWaiting(r.chatId) });
      if (act === "retry") {
        if (releasePause(tid)) return c.json({ ok: true, released: true });
        const res = r.side === "source" ? await retryTransport(tid) : { ok: false, error: "Retry it on the device it comes from." };
        return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, 409);
      }
      const res = await cancelTransport(tid);
      return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, res.status as 409);
    });

  // The Transport card's Save (§app.transport/agent): the host values it asks for, by your click on this device's page.
  app.post("/api/transport/:tid/host-values", small, async (c) => {
    if (!local(c)) return notFound(c);
    const refused = pageOnlyRefusal(c, YOUR_CLICK);
    if (refused) return c.json({ error: refused, yourClick: true }, 403);
    const body = (await c.req.json().catch(() => null)) as { values?: unknown } | null;
    const extra = body && typeof body === "object" ? unknownKeys(Object.keys(body), ["values"]) : null;
    if (extra) return c.json({ error: extra }, 400);
    const res = dest.saveHostValues(c.req.param("tid"), body?.values);
    return res.ok ? c.json({ ok: true, left: res.left }) : c.json({ error: res.error }, res.status);
  });

  // The Transport card's Allow Downloads and Done (§app.transport/agent): only your click on a device's page.
  for (const [verb, kind, key] of [["allow-downloads", "downloads", "plan"], ["admin-done", "admin", "step"]] as const)
    app.post(`/api/transport/:tid/${verb}`, small, async (c) => {
      if (!local(c)) return notFound(c);
      const refused = pageOnlyRefusal(c, YOUR_CLICK);
      if (refused) return c.json({ error: refused, yourClick: true }, 403);
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const extra = body && typeof body === "object" ? unknownKeys(Object.keys(body), [key]) : null;
      if (extra) return c.json({ error: extra }, 400);
      const bad = askIdRefusal(kind, body?.[key]);
      if (bad) return c.json({ error: bad }, 400);
      const r = readTransport(c.req.param("tid"));
      if (!r) return notFound(c);
      const res = await answerAsk(kind, r, body?.[key], mesh);
      return c.json(res.body, res.status as 200);
    });

  app.get("/api/transport/:tid/back", async (c) => {
    if (!local(c)) return notFound(c);
    const r = readTransport(c.req.param("tid"));
    return r ? c.json(await backState(r, mesh)) : notFound(c);
  });

  app.post("/api/transport/:tid/move-back", small, async (c) => {
    if (!local(c)) return notFound(c);
    const refused = pageOnlyRefusal(c, YOUR_CLICK);
    if (refused) return c.json({ error: refused, yourClick: true }, 403);
    const r = readTransport(c.req.param("tid"));
    if (!r || r.side !== "source") return notFound(c);
    const res = await moveBackToHere(r, mesh);
    return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, 409);
  });

  // ---- the peer listener ------------------------------------------------------------------------

  app.post("/api/peer/transport/:tid/move-back", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = await dest.moveBack(caller, c.req.param("tid"), await c.req.text(), c.req.header(PROOF_HEADER) ?? "");
    return c.json(r.body as object, r.status as 200);
  });

  // Allow Downloads and Done pressed on the page of the device the chat comes from: that click proven back, then answered here.
  for (const [verb, kind, key] of [["allow-downloads", "downloads", "plan"], ["admin-done", "admin", "step"]] as const)
    app.post(`/api/peer/transport/:tid/${verb}`, small, async (c) => {
      const caller = mesh.requestPeer(c);
      if (!caller) return notFound(c);
      const r = readTransport(c.req.param("tid"));
      if (!r || r.side !== "destination" || r.peer !== caller.id) return c.json({ error: "No such transport" }, 404);
      const raw = await c.req.text();
      const proof = c.req.header(PROOF_HEADER) ?? "";
      if (!proof || !(await clickProvenBy(caller.id, proof, raw))) return c.json({ error: "Only you answer the Transport card, from a device's page. Nothing changed here." }, 403);
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return c.json({ error: "Bad request" }, 400);
      }
      const res = await answerAsk(kind, r, body?.[key], mesh);
      return c.json(res.body, res.status as 200);
    });

  app.get("/api/peer/transport/hello", (c) => (mesh.requestPeer(c) ? c.json({ ok: true }) : notFound(c)));

  app.post("/api/peer/transport/needs", small, async (c) => {
    if (!mesh.requestPeer(c)) return notFound(c);
    const p = (await c.req.json().catch(() => null)) as ProjectRef | null;
    if (!p || typeof p.path !== "string") return c.json({ error: "Bad project" }, 400);
    // Read only: what this device lacks for that project (nothing is made or started here).
    const chatModel = (p as { chatModel?: unknown }).chatModel;
    // The project's own setup definition as that device read it: plain names only, checked here, never run.
    const setup = cleanSetupDef((p as { setup?: unknown }).setup);
    return c.json(await needsAnswer({ remotes: Array.isArray(p.remotes) ? p.remotes.map(String) : [], ...(typeof p.firstCommit === "string" ? { firstCommit: p.firstCommit } : {}), path: p.path }, { ...(typeof chatModel === "string" && chatModel.length < 200 ? { chatModel } : {}), ...(setup ? { setup } : {}) }));
  });

  app.post("/api/peer/transport/offer", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const raw = await c.req.text();
    const r = await dest.takeOffer({ id: caller.id, label: caller.label }, raw, c.req.header(PROOF_HEADER) ?? "");
    return c.json(r.body as object, r.status as 200);
  });

  // The package (§mesh.peers/transport-ticket): the one device it was minted for, with the ticket, while it is open.
  app.get("/api/peer/transport/:tid/package", (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const tid = c.req.param("tid");
    const r = readTransport(tid);
    const presented = c.req.header(TICKET_HEADER) ?? "";
    if (!r || r.side !== "source" || r.peer !== caller.id || !r.ticket || r.ticketBurnt || !sameSecret(presented, r.ticket)) return notFound(c);
    const pkg = servedPackage(tid);
    if (!pkg) return c.json({ error: "Not packed yet" }, 503, { "Retry-After": "2" });
    return serveTar({ ...pkg, range: c.req.header("range") ?? null, ifRange: c.req.header("if-range") ?? null });
  });

  app.get("/api/peer/transport/:tid", async (c) => {
    const caller = mesh.requestPeer(c);
    return caller ? c.json(await dest.statusOf(caller, c.req.param("tid"))) : notFound(c);
  });

  app.post("/api/peer/transport/:tid/ready", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = dest.packageReady(caller, c.req.param("tid"), (await c.req.json().catch(() => null)) as never);
    return c.json(r.body as object, r.status as 200);
  });

  app.post("/api/peer/transport/:tid/commit", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = await dest.commit(caller, c.req.param("tid"), ((await c.req.json().catch(() => null)) ?? {}) as never);
    return c.json(r.body as object, r.status as 200);
  });

  app.post("/api/peer/transport/:tid/cancel", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = await dest.cancel(caller, c.req.param("tid"));
    return c.json(r.body as object, r.status as 200);
  });

  app.post("/api/peer/transport/:tid/retry", small, (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = dest.retry(caller, c.req.param("tid"));
    return c.json(r.body as object, r.status as 200);
  });
}

export type { PackageManifest };
