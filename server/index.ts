// The server's startup: builds the app (server/app.ts), listens, and boots everything that runs
// in the background (mesh, share listener, loops, the usage helper child). `bun server/index.ts`.
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { buildApp, SERVER_RUNTIME } from "./app";
import { readBranch } from "./harness/pi/reader";
import { extensionEntries } from "./harness/pi/state";
import { markShutdown } from "./wrapup-recovery";
import { runLedger } from "./auto-resume";
import { startBudgetRecount } from "./baton-recount";
import { openRegisteredProjects } from "./projects/spaces";
import { reconcileProjectServices } from "./project-services/routes";
import { startProjectOverseerLoop } from "./project-overseer";
import { attachedWorkspaces, openAttachedOrgs } from "./orgs";
import { finishImports, rollForwardCopies } from "./project-import";
import { closeAllOrgHosts } from "./org-engine";
import { flushWorkspaces } from "./workspace-commits";
import { stopVoice } from "./voice/service";
import { startStaticPreviews } from "./project-previews";
import { startOutreach } from "./outreach/core";
import { startShareRuntime, stopShareRuntime } from "./share/runtime";
import { flushOpenVisits } from "./visits";
import { pruneVisitorLogs } from "./visitor-identity";
import { acquireChat, disposeAllChats, getModelRuntime, heldChat, heldChats, onAgentSettled, onReceiverIdle, warmClaudeCodeProvider } from "./chat-manager";
import { receiverSpecial, startTopicDelivery } from "./topic-delivery";
import { projectOverseerOfPath } from "./project-overseer-store";
import { LIVE_DIR } from "./paths";
import { agentRoot, stateRoot } from "./state-root";
import { cappedWebSocket } from "./runtime-quirks";
import { decodeWorkers, teamDuties, invalidateUsageMemo, recordUsage, usageRefreshBusy } from "./insights";
import { startUsagePoller } from "./usage-poll";
import { usageHistory } from "./usage-history";
import { readCache } from "../pi-config/extensions/usage-status/fetch.ts";
import { startSharedUsageHelper, stopSharedUsageHelper } from "./usage-helper/client";
import { cachedTitleOf, getSessionSummary, lastReplyOf, listSessions, onSessionArchived, onSummaryLineChanged } from "./sessions-index";
import { startScheduleKeeper } from "./schedule-routes";
import { attachWebSockets, upgradeSovaSocket, upgradeSovaStreamSocket } from "./ws";
import { meshApi, startMesh, stopMesh } from "./mesh";
import { captureBootBuild } from "./mesh/build-id";
import { meshLinks } from "./mesh/links";
import { setLinkOrigin } from "./link-delivery";
import { setOverseerDispatch, startAutoResume, startOverseerLoop } from "./overseer";
import { setSovaPort } from "./extensions";
import { decisionRuntime, decisions, decisionSettings, decisionsReady } from "./decide-runtime";
import { AttentionSignals } from "./attention-signals";
import { initRestartWindow, markServerStop } from "./server-stop";
import { configureSessionFeed, nudgeMarks, publishFeed } from "./session-feed";
import { configureLlmInflight } from "./llm-inflight";
import { snapshot as llmSnapshot, subscribe as onLlmChange } from "../pi-config/extensions/llm-inflight/tracker.ts";
import { readUnadoptedWorkers } from "../pi-config/extensions/llm-inflight/hosted.ts";
import { verifiedPeerSocket } from "./mesh/peer-address";
import { peerUrl } from "./mesh/peers";
import { onTagsChanged } from "./session-tags";
import { terminalSession } from "./decide-settings";
import { MergeFollowUps } from "./merge-followup";
import { configureReadiness } from "./merge-readiness";
import { startSessionTags } from "./tags-backfill";
import { readLiveRecords } from "./live";
import { startResourceMonitor, stopResourceMonitor } from "./resource-monitor";
import { defaultAdapters } from "./worker-adapters";
import { serverRedactor } from "./overseer-redact";
import { serverAuthEnabled, setAuthHosts, setAuthPort, initAuthToken } from "./auth";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4800; // PORT=0: an ephemeral port (tests)
// Loopback by default; set HOST=0.0.0.0 to deliberately expose on the LAN.
const HOST = process.env.HOST || "127.0.0.1";

// Embedded pi runtimes / extensions must never take the server down.
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));

const { app, autoTitleSweep, claudeAccounts, meshResync } = buildApp({
  extensionEntriesOf: async (path) => extensionEntries(heldChat(path)?.harness.branch() ?? (await readBranch(path))),
});

// The build this process runs, recorded once now: commit, tracked-files dirty state and protocol
// together (server/mesh/build-id.ts), so the details and the hello name it however the checkout moves.
void captureBootBuild();
// Topic queues (§chat.topics/delivery): batches to a topic's receiver when it is idle or settles.
// An org's ordinary sessions (a project's coding sessions, unregistered workspace files) get their
// batches; only what the runtime opens as special, and workers, are refused (receiverSpecial).
startTopicDelivery({
  async summary(path) {
    const s = await getSessionSummary(path);
    if (!s) return null;
    return { archived: s.archived, live: s.live, special: receiverSpecial(s, projectOverseerOfPath(path)) };
  },
  acquire: (path) => acquireChat(path),
  onIdle: onReceiverIdle,
  onArchived: onSessionArchived,
});
// Outreach (§app/outreach): receipts of earlier sends find their log lines once the sender replays them.
startOutreach();
// Folder previews (§mesh.public/preview-serve): rebound on their recorded ports, stopped when they end.
startStaticPreviews();
// Visitor logs (§mesh.public/visitor-log): identity and preview-visit lines older than 120 days
// are dropped at startup and once a day.
const pruneVisitors = () => {
  try {
    pruneVisitorLogs();
  } catch (err) {
    console.warn(`[visits] prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
pruneVisitors();
setInterval(pruneVisitors, 24 * 60 * 60_000).unref();

// The app, for whoever imports the server (routes in-process through app.request()).
export { app };

/** Where the link extension's tools call this server back: loopback for a wildcard bind. */
const linkOrigin = (port: number) => `http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST}:${port}`;
// Known before listen when the port is fixed, so no runtime opened meanwhile misses the flag.
if (PORT) setLinkOrigin(linkOrigin(PORT));

// Initialize before the first request: mint if missing; a damaged file is logged once and leaves
// the shell reachable, with token checks refused until the file is deleted and we restart.
initAuthToken();
if (process.env.SOVA_AUTH === "off")
  console.warn(serverAuthEnabled() ? `[auth] SOVA_AUTH=off ignored: ${HOST} is not a loopback bind` : "[auth] SOVA_AUTH=off: the token is not asked for");
// What the gate knows from the mesh (server/auth.ts): this host's MagicDNS name, its front door and
// serve URL (names it answers to, and pages it is served from), and the peers' serve URLs.
setAuthHosts(() => {
  const config = meshApi.config();
  return { magicDns: meshApi.selfNode().dnsName, own: [config?.self.serveUrl, config?.frontDoor], peers: config?.peers.map((p) => p.serveUrl) ?? [] };
});

// Every attached org's engine opens before the first request (its pages and share links read it).
// An import a stop cut off finishes (§app.projects/import): its copy before the orgs open, the rest after.
rollForwardCopies();
await openAttachedOrgs();
await openRegisteredProjects();
await finishImports();

export const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  setSovaPort(info.port);
  setAuthPort(info.port);
  // The link extension's tools call this server back here: the real bound port (PORT=0 in tests).
  setLinkOrigin(linkOrigin(info.port));
  console.log(`sova server on http://${HOST}:${info.port} (${SERVER_RUNTIME.name} ${SERVER_RUNTIME.version})`);
  startMesh({ fetch: app.fetch, upgrade: upgradeSovaSocket, streamUpgrade: upgradeSovaStreamSocket });
  // Public links: the share listener, a gateway's router, a routed host's ingress (server/share/runtime.ts).
  void startShareRuntime();
  // Project instances back to their desired state (server/project-services/routes.ts).
  void reconcileProjectServices();
}) as Server;
server.on("error", (err) => {
  // e.g. EADDRINUSE: don't linger half-alive behind the uncaughtException handler
  console.error("[server] listen failed:", err.message);
  process.exit(1);
});
attachWebSockets(server);

// The previous server's stop mark: the workers its stop ended are no errors (server/server-stop.ts).
initRestartWindow();

// Needs you's Later is gone (§app.overseer/attention-digest): the store an earlier version kept its
// choices in is deleted, so none of them keeps anything hidden. A no-op once it is gone.
try {
  rmSync(join(stateRoot(), "needs-you-later.json"), { force: true });
} catch (err) {
  console.warn(`[server] needs-you-later.json not deleted: ${err instanceof Error ? err.message : String(err)}`);
}

// The Overseer's tools call these same routes in-process (no socket, every guard applies).
setOverseerDispatch((path, init) => app.request(path, init));
startOverseerLoop();
startProjectOverseerLoop();
// The runs the last stop cut off get one "continue" each (§app.overseer/auto-resume).
startAutoResume();
startScheduleKeeper((path, init) => app.request(path, init));
// Samples CPU and memory in the background from startup, open modal or not (§app.resource-monitor/sampling-and-history).
startResourceMonitor({
  logDir: join(stateRoot(), "monitor"),
  liveDir: LIVE_DIR,
  held: () => heldChats().map((c) => ({ path: c.path, sessionId: c.harness.id, cwd: c.harness.cwd })),
  titleOf: cachedTitleOf,
});
// Every attached org's workspace repo: its residence statechart commits whatever changed at most hourly, then pushes.
// Messages a crash or kill lost stop counting against their session's limit.
startBudgetRecount();
// The automatic session namer's sweep (off until Settings turns it on), nudged by summary lines.
autoTitleSweep.start();
onSummaryLineChanged(() => autoTitleSweep.nudge());

// Decisions (Settings → Decisions; both features off by default, and then nothing is ever sent).
// The list's decision overlays are pushed on /ws/watch?feed=sessions (server/session-feed.ts);
// attention signals classify finished turns and long-running workers; session tags tag sessions.
configureSessionFeed({ list: listSessions });
// The LLM calls in flight, pushed on the same feed (server/llm-inflight.ts): this process's own
// counter, the other processes' live records, and each peer's own count while a browser listens.
configureLlmInflight({
  own: { snapshot: llmSnapshot, subscribe: onLlmChange },
  liveDir: LIVE_DIR,
  workers: () => readUnadoptedWorkers(),
  mesh: {
    // A dial-out pairing has no URL to open a feed to (§mesh/lan): its count isn't shown here.
    // `url` names the peer's entry; the feed opens at its verified address (§mesh/peers).
    peers: () => (meshApi.enabled() ? meshApi.peers().filter((p) => !p.lan).map((p) => ({ id: p.id, url: peerUrl(p) })) : []),
    selfId: () => meshApi.self().id,
    connect: (url) => {
      const peer = meshApi.peers().find((p) => !p.lan && peerUrl(p) === url);
      if (!peer) throw new Error("no such peer");
      return verifiedPeerSocket(peer, (base) => cappedWebSocket(`${base.replace(/^http/, "ws")}/ws/watch?feed=llm`, undefined, { handshakeTimeout: 10_000, maxPayload: 16 * 1024 }));
    },
  },
});
const attentionSignals = new AttentionSignals({
  settings: decisionSettings,
  provider: () => (decisionsReady() ? decisions() : null),
  list: listSessions,
  summary: (path) => getSessionSummary(path),
  lastReply: lastReplyOf,
  held: (path) => !!heldChat(path),
  liveRecords: () => readLiveRecords({ includeOwn: true }),
  decodeWorkers: (presence) => decodeWorkers(presence),
  duties: teamDuties,
  adapters: defaultAdapters,
  redact: (value) => serverRedactor().redactDeep(value),
  changed: nudgeMarks,
});
attentionSignals.start();
onAgentSettled((path) => attentionSignals.turnSettled(path));
startSessionTags({
  list: listSessions,
  onAgentSettled,
  held: (path) => !!heldChat(path),
  provider: decisions,
  settings: decisionSettings,
  ready: () => {
    const s = decisionRuntime().chain.status();
    return { ready: s.ready, ...(s.reason ? { reason: s.reason } : {}) };
  },
  publish: (progress) => publishFeed({ type: "tags_backfill", progress }),
});
onTagsChanged(() => nudgeMarks());
// Merge readiness (§chat.worktrees/readiness) is git and the file; its one follow-up check per
// merge (§app.decisions/merge-followup) goes through the same seam, only with attention signals on.
configureReadiness({
  followUps: new MergeFollowUps({ provider: decisions, settings: decisionSettings, ready: decisionsReady }),
  terminal: (s) => terminalSession(s, !!heldChat(s.path)),
});

// Register the Claude Code provider now rather than when the user first opens a session, so its
// models are in GET /api/models for the picker straight away (§app.claude-code-provider/always-on).
// Never fatal, with or without a `claude` CLI: see warmClaudeCodeProvider.
void (async () => {
  try {
    await warmClaudeCodeProvider(await getModelRuntime(), agentRoot());
  } catch (err) {
    console.warn("[server] claude-code warm-up skipped:", err instanceof Error ? err.message : String(err));
  }
})();

// Keeps the shared usage cache fresh without an open TUI (SOVA_USAGE_POLL=off switches it off).
const usagePoller = startUsagePoller({ busy: usageRefreshBusy, onFetched: invalidateUsageMemo, onCache: recordUsage });
// The usage history also takes the cache as it is at start: a reading taken while this server was
// down still counts (§app.insights/usage-burn).
void readCache().then((cache) => cache && recordUsage(cache), () => {});
// The usage helper child: reads the usage ledger, keeps its rollup, pulls models.dev prices every
// 6 hours and answers every spend query off this loop (§app.insights/usage-ledger).
startSharedUsageHelper();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  // First: the workers this stop ends die on the same signal (server/server-stop.ts).
  markServerStop();
  // Whatever a step below waits on, the process ends.
  setTimeout(() => {
    console.error("[server] shutdown took over 20 s; exiting");
    process.exit(1);
  }, 20_000).unref();
  // Hosted subagent workers (PI_WORKER_TRANSPORT=host) outlive this process: the
  // subagents extension's session_shutdown detaches them instead of killing them.
  // No-op for the default inline transport. See pi-config/extensions/subagents/hosting.ts.
  (globalThis as Record<symbol, unknown>)[Symbol.for("sova:detach-workers")] = true;
  claudeAccounts.dispose();
  meshResync.dispose();
  // Stop every turn first: a turn still streaming keeps the CPU busy through every await below.
  // Marked first, so a run that records how it ended says the shutdown cut it off.
  markShutdown();
  // The aborts below settle every run: the ledger keeps them as cut off (§app.overseer/auto-resume).
  runLedger.freeze();
  for (const chat of heldChats()) if (chat.harness.isRunning()) chat.harness.abort().catch(() => {});
  usagePoller.stop();
  // A plateau's held-back last reading is written, so the next start knows how long it lasted.
  try {
    usageHistory().flush();
  } catch (err) {
    console.warn("[usage-history] flush on shutdown failed:", err instanceof Error ? err.message : String(err));
  }
  void stopSharedUsageHelper();
  autoTitleSweep.stop();
  stopResourceMonitor();
  meshLinks.stop();
  stopMesh();
  stopShareRuntime();
  await stopVoice();
  await Promise.race([disposeAllChats(), new Promise((r) => setTimeout(r, 3000))]);
  // Every visit with an open share socket is seen now, so the commit below carries it.
  try {
    flushOpenVisits();
  } catch (err) {
    console.warn(`[server] visit flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // After the runtimes' last writes: whatever changed in a workspace repo since its last commit.
  await closeAllOrgHosts().catch(() => {});
  await Promise.race([flushWorkspaces(attachedWorkspaces(), "shutdown").catch(() => []), new Promise((r) => setTimeout(r, 10_000))]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
