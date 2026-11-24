// Transport's routes and its wiring into the server (§app/transport). The page's routes answer only
// this host's own listener, and every act takes only your click on this device's page
// (§app.access/your-click). The peer routes: every one but the package's is a sessions route on the
// destination (server/mesh/access.ts); the package's belongs to no grant and checks the one-time
// ticket itself (§mesh.peers/transport-ticket), comparing in constant time and never logging it.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ENTRY_FINAL } from "../../shared/merge-queue";
import { chatJobs, stopJobsOf } from "../background-jobs";
import { emitChatNews } from "../chat-home-events";
import { acquireChatHandle, closeChat } from "../chat-handle";
import { adoptArrivedHome, forgetWorkerChats, parkWorkerChat, steerWorkerChat, workerMembersOf, workersWorkingOf } from "../chat-host";
import { chatHome } from "../chat-homes/root";
import { readBranch } from "../harness/pi/reader";
import { sessionsChanged } from "../list-generation";
import { mintClickProof } from "../mesh/click-proof";
import type { MeshApi } from "../mesh/index";
import { serveTar } from "../mesh/links-transfer";
import { localRequest } from "../mesh/proxy";
import { pageOnlyRefusal } from "../page-only";
import { resolveSessionPath } from "../paths";
import { archiveSession, getSessionSummary } from "../sessions-index";
import { stateRoot } from "../state-root";
import { worktreesOf } from "../worktrees-state";
import * as dest from "./destination";
import { git } from "./git-snapshot";
import { isTransportAgent, needsAnswer, setAfterArrival, setBringHelpersToRest, setInterruptWaiting, setIsTransportAgent, setNeedsAnswer, setPrepareDestination, setPreviewExtras, interruptWaiting, releasePause, type ProjectRef } from "./hooks";
import { markMoved } from "./moved";
import type { PackageManifest } from "./package";
import { cancelTransport, previewTransport, REFUSALS, resumeSources, retryTransport, servedPackage, setSourceDeps, startTransport } from "./source";
import { listTransports, publicView, readTransport, type TransportRecord, updateTransport } from "./store";
import { PROOF_HEADER, TICKET_HEADER } from "./wire";

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

/** Once the destination confirmed a Move: the Moved row, the safety copy, the worktrees here removed. */
async function moved(r: TransportRecord): Promise<void> {
  const ext = (r.ext ?? {}) as { ownedTrees?: string[]; packedTrees?: { name: string; path: string; main: boolean }[] };
  // The team leaves this server's memory first: archiving must not end their records (the safety copy keeps them idle).
  forgetWorkerChats(workerMembersOf(r.chatId).map((m) => m.sid));
  markMoved(r.chatId, { tid: r.tid, peer: r.peer, to: r.peerLabel, at: new Date().toISOString(), arrivedId: r.arrivedId ?? r.chatId });
  const a = await archiveSession(r.path, true);
  if (!a.ok) log(`${r.tid}: the Moved row's archive mark failed: ${a.error}`);
  // The safety copy keeps the package: the code exactly as it left, every commit and change.
  const home = chatHome(r.chatId);
  const spool = join(stateRoot(), "transport", "spool", `${r.tid}.tar.zst`);
  if (existsSync(spool)) {
    mkdirSync(join(home, "transport"), { recursive: true, mode: 0o700 });
    await rename(spool, join(home, "transport", `${r.tid}.tar.zst`)).catch((err) => log(`${r.tid}: package not kept in the safety copy: ${err.message}`));
  }
  // The chat's own worktrees go, so the branch can't be landed from two devices; a main checkout (the
  // project itself) and a tree another chat made stay. One that changed since it was packed stays too.
  const manifestTrees = new Map((ext.packedTrees ?? []).map((t) => [t.path, t]));
  for (const p of ext.ownedTrees ?? []) {
    const t = manifestTrees.get(p);
    if (!t || t.main || !existsSync(p)) continue;
    const status = await git(p, ["status", "--porcelain=v1", "-z", "-uno"]);
    const want = ((r.ext ?? {}) as { statusOf?: Record<string, string> }).statusOf?.[p];
    if (want && digest(status.stdout) !== want) {
      log(`${r.tid}: ${p} changed since it was packed; it stays`);
      continue;
    }
    const common = (await git(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    const rm = await git(common || p, ["worktree", "remove", "--force", p]);
    if (rm.code !== 0) log(`${r.tid}: ${p} was not removed: ${rm.stderr.trim()}`);
  }
  emitChatNews({ name: "chat.removed", chat: r.chatId, home });
  sessionsChanged();
}

export function mountTransport(app: Hono, mesh: Mesh): void {
  const local = (c: Context) => mesh.enabled() && localRequest(c);

  setSourceDeps({
    peers: () => mesh.peers().map((p) => ({ id: p.id, label: p.label })),
    selfLabel: () => mesh.self().label,
    peerFetch: mesh.peerFetch,
    updateNeeded: mesh.updateNeeded,
    chat: async (path) => {
      const s = await getSessionSummary(path);
      return s ? { id: s.id, path: s.path, title: s.title || s.id, cwd: s.cwd, specialKind: specialKind(s), inTerminal: !!s.live } : null;
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
    moved,
  });

  dest.setDestinationDeps({
    peerFetch: mesh.peerFetch,
    clickProven: async (peerId, proof, body) => {
      try {
        const res = await mesh.peerFetch(peerId, "/api/peer/click-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof, digest: digest(body) }), signal: AbortSignal.timeout(10_000) });
        return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
      } catch {
        return false;
      }
    },
    adopt: (homeId) => {
      const n = adoptArrivedHome(homeId);
      log(`home ${homeId} arrived: ${n} helper records tracked`);
      sessionsChanged();
      emitChatNews({ name: "chat.created", chat: homeId, home: chatHome(homeId) });
    },
    openWithNote: async (path, text) => {
      const h = await acquireChatHandle(path);
      if (!(await h.appendNote("sova-transport-arrival", text))) log(`the arrival note for ${path} could not be written`);
    },
    tellHelper: steerWorkerChat,
    helperNote: (device, interrupted) =>
      interrupted
        ? `This chat moved from ${device} while you were working, and your turn was interrupted. Folders and ports may differ here. Continue where you stopped.`
        : `This chat moved from ${device}. Folders and ports may differ here. Continue where you left off.`,
  });

  // The Transport agent and Safe Transport, when this build has them (server/transport/agent-wire.ts).
  void import("./agent-wire")
    .then((m) => {
      const h = m.transportHelpers(app, (tid, a) => void updateTransport(tid, { ext: { agent: a } }));
      // Their worktree branch is a name; a detached HEAD's is "".
      const named = <T extends { worktrees: { name: string; branch: string | null }[] }>(req: T) => ({ ...req, worktrees: req.worktrees.map((w) => ({ name: w.name, branch: w.branch ?? "" })) });
      setPrepareDestination((req, o) => h.prepareDestination(named(req), o));
      setAfterArrival((req) => void h.afterArrival(named(req)));
      setNeedsAnswer((p) => h.needsAnswer(p));
      setBringHelpersToRest((chatId, mode, onProgress, o) => h.bringHelpersToRest(chatId, mode, onProgress, o));
      setInterruptWaiting((chatId) => h.interruptWaiting(chatId));
      setIsTransportAgent((id) => h.isTransportAgent(id));
      setPreviewExtras(async (chatId) => ({ busyHelpers: await h.busyHelpers(chatId) }));
    })
    .catch((err) => log(`no Transport agent in this build: ${err instanceof Error ? err.message : String(err)}`));

  // Transports this server was in the middle of go on (settled at the next contact).
  const all = listTransports();
  resumeSources(all);
  dest.resumeDestinations(all);

  // ---- the page (this host's own listener) ------------------------------------------------------

  app.get("/api/transport/preview", async (c) => {
    if (!local(c)) return notFound(c);
    const path = resolveSessionPath(c.req.query("path") ?? null);
    if (!path) return c.json({ error: "Invalid or missing path" }, 400);
    try {
      return c.json(await previewTransport(path, c.req.query("peer") || undefined));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  app.post("/api/transport", small, async (c) => {
    if (!local(c)) return notFound(c);
    const refused = pageOnlyRefusal(c, YOUR_CLICK);
    if (refused) return c.json({ error: refused, yourClick: true }, 403);
    const b = (await c.req.json().catch(() => null)) as Parameters<typeof startTransport>[0] | null;
    const path = resolveSessionPath(typeof b?.path === "string" ? b.path : null);
    if (!b || !path) return c.json({ error: "Invalid or missing path" }, 400);
    const r = await startTransport({ ...b, path });
    return r.ok ? c.json({ tid: r.tid, transport: publicView(readTransport(r.tid)!) }, 201) : c.json({ error: r.error }, r.status as 400);
  });

  app.get("/api/transport", (c) => {
    if (!local(c)) return notFound(c);
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

  // ---- the peer listener ------------------------------------------------------------------------

  app.get("/api/peer/transport/hello", (c) => (mesh.requestPeer(c) ? c.json({ ok: true }) : notFound(c)));

  app.post("/api/peer/transport/needs", small, async (c) => {
    if (!mesh.requestPeer(c)) return notFound(c);
    const p = (await c.req.json().catch(() => null)) as ProjectRef | null;
    if (!p || typeof p.path !== "string") return c.json({ error: "Bad project" }, 400);
    // Read only: what this device lacks for that project (nothing is made or started here).
    return c.json(await needsAnswer({ remotes: Array.isArray(p.remotes) ? p.remotes.map(String) : [], ...(typeof p.firstCommit === "string" ? { firstCommit: p.firstCommit } : {}), path: p.path }));
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

  app.get("/api/peer/transport/:tid", (c) => {
    const caller = mesh.requestPeer(c);
    return caller ? c.json(dest.statusOf(caller, c.req.param("tid"))) : notFound(c);
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
