import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { agentRoot } from "./state-root";
import { toolCtx, toPiTool } from "./harness/pi/tools";
import { createSessionFile } from "./harness/pi/state";
import { GRANT, GRANT_USE, OVERSEER, REVOKE, RULE } from "./harness/state-kinds";
import { loadPolicyFile, policyFilePath } from "../pi-config/extensions/sandbox/policy.ts";
import {
  OVERSEER_BRIEF_PREFIX,
  OVERSEER_ENTRY,
  type AttentionDigest,
  type AttentionItem,
  type OverseerAutonomy,
  type OverseerInfo,
  type OverseerSaveResult,
  type OverseerSettings,
  type OverseerSettingsInfo,
  type SessionSummary,
  type SovaConfirmItem,
} from "../shared/protocol";
import { setArchived } from "./archived-sessions";
import { type AttentionRow, blockerCount, blockerKey, buildDigest, mergedBranch, workerErrorTime } from "./attention";
import { readIndex, stakeholderAttention } from "./orgs";
import { heldAttention } from "./project-holds";
import { conflictAttention } from "./decisions";
import { senderAttention } from "./outreach/health";
import { notSentAttention } from "./outreach/log";
import { readinessChecksOf, restartItems } from "./merge-readiness";
import {
  acquireChat,
  BusyError,
  type ChatSession,
  disposeHeldChat,
  drainQueueThenAbort,
  getModelRuntime,
  heldChat,
  isSessionBusy,
  setOverseerRuntime,
} from "./chat-manager";
import { activityOf, failedWorkersOf, readLiveRecords, workerErrorTimesOf, workingSubagents } from "./live";
import { endedByRestart, restartWindow } from "./server-stop";
import { listModels, contextWindow } from "./models";
import { modelDenial, readModelPolicy } from "./model-policy";
import { markBackground } from "../pi-config/extensions/provider-limits/gate.ts";
import { mergeMode } from "./mode-state";
import {
  DEFAULT_CAPS,
  DEFAULT_EXPLORER,
  DEFAULT_QUICK_ACTIONS,
  overseerDir,
  overseerSettingsFile,
  parseSettings,
  patchOverseerSettings,
  readNotes,
  logAction,
  readOverseerSettings,
  readOverseerState,
  rotateState,
  writeOverseerSettings,
  writeOverseerState,
  overseerTurnFile,
} from "./overseer-store";
import { promptToc, readManifest } from "./overseer-ideas";
import { promptTodos, readTodos } from "./overseer-todos";
import type { SubagentTool } from "./overseer-idea-tools";
import { workerDenial } from "./delegate";
import { BUILTIN_ALLOWED, overseerTools, type OverseerToolHost, renderTranscript, TurnLimits } from "./overseer-tools";
import { UserTurns } from "./user-turns";
import { OVERSEER_SENDER_HEADER, overseerSender, senderSecret } from "./overseer-sender";

import { onSessionPrompted, pathOfId, promptSession, sessionActivity, toolCatalogue, type PromptDelivery, type PromptResult } from "./session-prompt";
import { contactRedactor } from "./overseer-org-view";
import { CARDS_NOTE_MESSAGE, cardsNote, clickItems, foldCards, matchCardClick } from "../shared/overseer-card";
import { actsText, carriedRules, clickWrote, coveringPermit, foldPermits, type Permit, permitFromClick, RULE_ENTRY, type RuleEntry, sessionsText } from "../shared/overseer-grants";
import { readAliases, sessionName, setAlias } from "./session-names";
import { RESUME_DELAY_MS, resumeInterrupted, runLedger } from "./auto-resume";
import { schedulesForWire } from "./schedules";
import { overseerFileTools } from "./overseer-file-tools";
import { OverseerGuard } from "./overseer-deny";
import { projectOverseerOfPath } from "./project-overseer-store";
import { type Redactor, redactExtensionMessages, serverRedactor } from "./overseer-redact";
import { canonicalPath, resolveSessionPath } from "./paths";
import { isViewing, markSeen, readSeen } from "./seen";
import { UnreadReplies } from "./unread-replies";
import { cleanupSessions, getSessionSummary, idOf, indexedSessionPaths, lastReplyAtOf, listSessionFiles, listSessions } from "./sessions-index";
import { getSessionInsight } from "./insights";
import { branchLabels, cardsOnBranch, runNote, runNoteSessionIds, type SessionNow, sessionsInPlay, sessionsInPlayText, type Touched } from "./overseer-run-note";
import { changedText, openingOn, toldOn, type LivePart, type OpeningDetails } from "./overseer-opening";
import { assistantText, ID_NOTE_MESSAGE, idCheckNote } from "./overseer-id-check";
import { meshApi } from "./mesh";
import { probePeer } from "./mesh/hello";
import { meshLinks } from "./mesh/links";
import type { PeerLinkRead } from "../shared/mesh-links";
import { rowsOf } from "./transcript";
import { branchOf, joinedText, lineEntry, parsePi, readBranch } from "./harness/pi/reader";
import type { HarnessSession, HEntry } from "../shared/harness";
import { archiveWorktrees } from "./archive-worktrees";
import { markOwned } from "./write-guard";
import { signalTextOf, teamStallOf } from "./signals-store";
import { readDecisionSettings } from "./decide-settings";
import { onAttentionChanged } from "./attention-memo";
import { notifyBlockers, pushWanted, resetPushState } from "./push";
import { memoryExtension } from "./harness/pi/memory";
import { MEMORY_TOOLS } from "../shared/memory";
import { playbookReviews } from "./projects/playbook-review";
import { deployAttentionItems } from "./project-services/deploy-attention";

/**
 * The Overseer: ONE special Sova session that watches every other session and acts on them
 * (.overseer-design/DECISIONS.md). It is an ordinary webapp-owned pi session hosted here, with
 * four differences: a `sova-overseer` marker entry in its file, a fixed cwd `<stateRoot>/overseer/`,
 * a runtime loadout (its prompt, its sova_* tools, a tool allowlist, its own model), and an
 * identity that is not the file: `overseer-state.json` points at the current file, and /clear
 * rotates it. Settings, standing notes and the action log never key on the session id, so they
 * survive a clear.
 */

const PROMPT_FILE = fileURLToPath(new URL("./overseer-prompt.md", import.meta.url));

let dispatch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;


/** An in-process request to the app, as the browser makes it (no Overseer sender mark): the
    project overseer's session creation goes through the same route and guards. */
export function appRequest(path: string, init?: RequestInit): Promise<Response> {
  if (!dispatch) throw new Error("The server's routes are not wired yet.");
  return dispatch(path, init);
}

/** index.ts hands over Hono's in-process dispatch at startup, so the tools call the same routes
    the browser does and this module never imports the app (the dependency points one way). */
export function setOverseerDispatch(fn: (path: string, init?: RequestInit) => Response | Promise<Response>): void {
  dispatch = async (path, init) => fn(path, init);
}

// ---- files ---------------------------------------------------------------------------------------

/** Whether the file carries the Overseer marker, from its first 16KB (the marker is line 2). */
export function hasOverseerMarker(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(16 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes(OVERSEER_ENTRY)) continue;
      const e = lineEntry(line); // null for a torn line: keep looking
      if (e?.kind === "state" && e.key === OVERSEER_ENTRY) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}


/** An entry that says the conversation was used: a message, or a model or thinking-level change. */
const sentOrSet = (e: HEntry): boolean =>
  e.kind === "setting" ? e.what === "model" || e.what === "thinking" : e.kind === "note" || e.kind === "summary" ? e.inMessage : ["user", "assistant", "tool-result", "shell", "system"].includes(e.kind);

/** A new Overseer file: header + marker (and the rules a /clear carries, §app.overseer/approvals),
    written now (like every web session), ours. */
function createOverseerFile(carried: readonly RuleEntry[] = []): { id: string; path: string } {
  const dir = overseerDir();
  mkdirSync(dir, { recursive: true });
  // The marker (then each carried rule) is written with the header, in one whole file.
  const made = createSessionFile({ cwd: dir, seed: [[OVERSEER, { v: 1 }], ...carried.map((rule) => [RULE, rule] as const)] });
  const path = canonicalPath(made.path);
  markOwned(path);
  markSeen(made.id);
  return { id: made.id, path };
}

/** Delete history files that fell off the end (>20). Through the cleanup "paths" mode, so the same
    bookkeeping runs as for any deleted session; the archive mark is what that mode requires. */
async function dropHistory(ids: string[]): Promise<void> {
  const paths: string[] = [];
  for (const id of ids) {
    const p = await pathOfId(id);
    if (!p) continue;
    setArchived(id, true);
    paths.push(p);
  }
  if (paths.length) await cleanupSessions({ mode: "paths", paths, dryRun: false }).catch(() => {});
}

/** The Overseer always runs in the normal mode with no minor modes: Delegate would route its work to
    workers and the spec minor mode would start writing claims. Every open of its runtime brings it
    back (the `opened` hook below), so a stale mode entry on its branch never stands; a switch is
    refused (ChatSession.switchMode). A chat already normal is left untouched, so opening writes
    nothing. `strict` is Delegate's alone and is left as it is. */
async function keepNormal(chat: ChatSession): Promise<void> {
  try {
    const s = chat.modeState;
    if (s.mode !== "normal" || s.minorModes.length) await chat.applyMode(mergeMode(s, { mode: "normal", minorModes: [] }));
  } catch (err) {
    console.warn("[overseer] could not set the normal mode:", err instanceof Error ? err.message : String(err));
  }
}

/** A brand-new file (creation, /clear): open it, which makes it normal. */
async function normalMode(path: string): Promise<void> {
  try {
    await keepNormal(await acquireChat(path));
  } catch (err) {
    console.warn("[overseer] could not set the normal mode:", err instanceof Error ? err.message : String(err));
  }
}

let ensuring: Promise<{ id: string; path: string }> | null = null;

/** The current Overseer file, created when there is none (or its file is gone). Single-flight. */
export function ensureOverseer(): Promise<{ id: string; path: string }> {
  ensuring ??= (async () => {
    const st = readOverseerState();
    if (st) {
      const p = await pathOfId(st.current);
      if (p && hasOverseerMarker(p)) return { id: st.current, path: p };
    }
    const made = createOverseerFile();
    const { state, dropped } = rotateState(st, made.id);
    writeOverseerState(state);
    await dropHistory(dropped);
    await normalMode(made.path);
    return made;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/**
 * /clear: stop any running turn, close the runtime, start a new marked file and point `current` at
 * it. Never refuses. Other tabs on the old file get `reloaded` and re-resolve the route.
 */
export async function clearOverseer(): Promise<OverseerInfo> {
  const st = readOverseerState();
  const oldPath = st ? await pathOfId(st.current) : null;
  // Live standing rules outlive the conversation; approvals for later lapse (§app.overseer/approvals).
  const old = oldPath ? await overseerEntries() : null;
  const carried = old && st ? carriedRules(old.branch, old.all, st.current) : [];
  if (oldPath) {
    const chat = heldChat(oldPath);
    if (chat?.harness.isRunning()) await drainQueueThenAbort(chat.harness, (m) => chat.broadcast(m), chat.queue).catch(() => {});
    await disposeHeldChat(oldPath, "The Overseer was cleared. Opening the new conversation.");
  }
  limits.reset();
  turns.reset();
  const made = createOverseerFile(carried);
  const { state, dropped } = rotateState(readOverseerState(), made.id);
  writeOverseerState(state);
  await dropHistory(dropped);
  await normalMode(made.path);
  digestMemo = null;
  return overseerInfo();
}

// ---- info, unread ------------------------------------------------------------------------------

/** Final replies (not tool-use steps) in the Overseer's file newer than `since`: while it only
    grows, only its new lines are read (server/unread-replies). */
const unread = new UnreadReplies();
const unreadReplies = (path: string, since: number | undefined): Promise<number> => unread.count(path, since);

export async function overseerInfo(): Promise<OverseerInfo> {
  const cur = await ensureOverseer();
  const st = readOverseerState();
  const history: OverseerInfo["history"] = [];
  for (const id of st?.history ?? []) {
    const p = await pathOfId(id);
    if (!p) continue;
    const s = await getSessionSummary(p);
    if (s) history.push({ id, path: p, title: s.title, lastActiveAt: s.lastActiveAt });
  }
  const digest = await attentionDigest();
  const seenAt = readSeen()[cur.id];
  return {
    path: cur.path,
    id: cur.id,
    history,
    badge: digest.badge,
    unread: isViewing(cur.id) ? 0 : await unreadReplies(cur.path, seenAt),
    proactivity: readOverseerSettings().proactivity,
    busy: isSessionBusy(cur.path),
  };
}

// ---- attention digest ----------------------------------------------------------------------------

const DIGEST_MS = 3000;

/** Per session: its failed-worker count as last seen here, and when it was first seen or last rose.
    Stands in for error times whose worker rows were dropped from the live record for size. */
const failedRise = new Map<string, { failed: number; at: number }>();
function noteFailedRise(path: string, failed: number, now: number): number {
  const prev = failedRise.get(path);
  const at = !prev || failed > prev.failed ? now : prev.at;
  failedRise.set(path, { failed, at });
  return at;
}
let digestMemo: { at: number; value: Promise<ReturnType<typeof buildDigest>> } | null = null;
onAttentionChanged(() => (digestMemo = null));
onSessionPrompted(() => (digestMemo = null));

/** The digest, memoised ~3s (the badge rides a poll). */
export function attentionDigest(): Promise<ReturnType<typeof buildDigest>> {
  const now = Date.now();
  if (digestMemo && now - digestMemo.at < DIGEST_MS) return digestMemo.value;
  const value = (async () => {
    const sessions = await listSessions();
    const records = readLiveRecords({ includeOwn: true });
    const byPath = new Map<string, { failed: number; since: number; errorTimes: number[] }>();
    // Workers this server's own restart ended are no errors of theirs (server/server-stop.ts): only
    // rows restored in this server's runtimes, whose records carry its pid.
    const window = restartWindow();
    const restartEnded = (row: unknown) => endedByRestart(row, window);
    for (const r of records) {
      if (!r.sessionFile) continue;
      const prev = byPath.get(r.sessionFile);
      const skip = r.pid === process.pid ? restartEnded : undefined;
      const failed = failedWorkersOf(r.rec, skip);
      const since = activityOf(r.rec)?.since ?? 0;
      byPath.set(r.sessionFile, {
        failed: Math.max(failed, prev?.failed ?? 0),
        since: Math.max(since, prev?.since ?? 0),
        errorTimes: [...(prev?.errorTimes ?? []), ...workerErrorTimesOf(r.rec, skip)],
      });
    }
    const nowMs = Date.now();
    // A stalled team (§app.decisions/team-stall) shows only while attention signals are on.
    const stallsOn = readDecisionSettings().features.attention;
    for (const p of [...failedRise.keys()]) if (!byPath.get(p)?.failed) failedRise.delete(p);
    const aliases = readAliases();
    // Proposed verb playbook runs (§app.project-runtime/review), by their session file.
    const reviews = playbookReviews();
    const rows: AttentionRow[] = sessions.map((s) => {
      const chat = heldChat(s.path);
      const live = byPath.get(s.path);
      return {
        summary: s,
        dialogs: chat ? chat.pendingDialogs().map((d) => d.title || d.method) : [],
        queued: chat ? chat.queue.size : 0,
        failedWorkers: live?.failed ?? 0,
        workerErrorAt: live?.failed ? workerErrorTime(live.failed, live.errorTimes, noteFailedRise(s.path, live.failed, nowMs)) : undefined,
        viewing: isViewing(s.id),
        activitySince: live?.since ?? 0,
        lastReplyAt: lastReplyAtOf(s.path),
        ...(s.signals || s.workerSignals ? { signalText: signalTextOf(s.id, nowMs) } : {}),
        ...(stallsOn ? teamStallField(s.id) : {}),
        ...(aliases[s.id] ? { alias: aliases[s.id] } : {}),
        ...(reviews.has(s.path) ? { playbook: reviews.get(s.path)! } : {}),
      };
    });
    // Items of no session: an org project's missing stakeholder, its held acts and conflicts routed to the operator
    // (the refit), and the one restart item of the whole server (§chat.worktrees/readiness), never one per session.
    // A deploy target whose latest deploy failed, and an overseer's request to deploy (§app.project-services/deploy-status).
    const deploys = await deployAttentionItems().catch(() => []);
    // WhatsApp sending down (§app.outreach/sender-health): from the sender's last reading, no round trip.
    return buildDigest(rows, Date.now(), homedir(), [...stakeholderAttention(), ...heldAttention(), ...notSentAttention(), ...senderAttention(), ...conflictAttention(), ...restartItems(sessions), ...deploys]);
  })();
  digestMemo = { at: now, value };
  value.catch(() => {
    if (digestMemo?.value === value) digestMemo = null;
  });
  return value;
}

function teamStallField(id: string): { teamStall?: { since: number; names: string[] } } {
  const stall = teamStallOf(id);
  return stall ? { teamStall: stall } : {};
}

/** The digest as the wire has it (no badge). */
export async function attentionForWire(): Promise<AttentionDigest> {
  const { badge: _badge, ...digest } = await attentionDigest();
  return digest;
}

// ---- settings ----------------------------------------------------------------------------------

export function overseerSettingsInfo(): OverseerSettingsInfo {
  return {
    settings: readOverseerSettings(),
    defaults: { quickActions: DEFAULT_QUICK_ACTIONS.map((a) => ({ ...a })), caps: { ...DEFAULT_CAPS }, explorer: { ...DEFAULT_EXPLORER } },
    file: overseerSettingsFile(),
  };
}

/**
 * PUT /api/settings/overseer: strict parse, the model checked against the user's policy and the
 * models this server can use (a claude-code-cli model is saved with a warning when it isn't listed
 * yet: the provider may simply not be registered), then applied to the held Overseer at once when
 * it is idle, else at its next turn boundary.
 */
export async function saveOverseerSettings(body: unknown): Promise<OverseerSaveResult | { error: string }> {
  const parsed = parseSettings(body, true);
  if ("error" in parsed) return parsed;
  const warnings: string[] = [];
  if (parsed.model) {
    const denial = modelDenial(readModelPolicy(), parsed.model);
    if (denial) return { error: denial };
    const known = (await listModels().catch(() => [])).some((m) => m.ref === parsed.model);
    if (!known) {
      if (parsed.model.startsWith("claude-code-cli/")) warnings.push(`${parsed.model} is not listed right now, so it could not be verified.`);
      else return { error: `Unknown model, or no credentials configured: ${parsed.model}` };
    }
  }
  // The explorer is a subagent: the policy's subagent view decides whether it may run. Saved either
  // way (spawn enforces it), with the reason shown.
  const denied = workerDenial(readModelPolicy(), parsed.explorer.backend, parsed.explorer.model);
  if (denied) warnings.push(`Exploratory agent: ${denied}; explorers will be refused until it is allowed.`);
  writeOverseerSettings(parsed);
  pendingApply = true;
  await applySettingsNow();
  digestMemo = null;
  return { ...overseerSettingsInfo(), warnings };
}

let pendingApply = false;

/** Bring the held, idle Overseer to overseer.json's model and thinking. Leaves `pendingApply` set
    while it is mid-turn, so the next tick applies it at the turn boundary. */
async function applySettingsNow(): Promise<void> {
  if (!pendingApply) return;
  const st = readOverseerState();
  const path = st ? await pathOfId(st.current) : null;
  const chat = path ? heldChat(path) : undefined;
  if (!chat) {
    pendingApply = false; // the next open syncs from the file (chat-manager syncOverseerModel)
    return;
  }
  if (chat.harness.isRunning()) return;
  pendingApply = false;
  // A conversation that has written no model or thinking yet (nothing sent): reopen it rather than
  // switch it. A switch would first flush the open-time pi-default model/thinking entries and then
  // record the new model — three info rows before the first message. A reopen seeds the runtime
  // from overseer.json directly (chat-manager createRuntime), so the file only ever records the
  // chosen model, at the first prompt. Open tabs get "reloaded" and reconnect.
  const untouched = !chat.harness.entries().some(sentOrSet);
  if (untouched) {
    await disposeHeldChat(chat.path, "The Overseer's model changed; reopening it.");
    return;
  }
  const s = readOverseerSettings();
  const cur = chat.harness.model()?.ref ?? null;
  try {
    if (s.model && s.model !== cur) await chat.setModelRef(s.model);
    if (s.thinking && s.thinking !== chat.harness.thinking()) chat.setThinking(s.thinking);
  } catch (err) {
    console.warn("[overseer] applying settings failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---- the runtime loadout ---------------------------------------------------------------------------

/** Per-turn caps, shared by the tools and the chat runtime's `userSend` (a user message resets
    them). Kept in a file, so a restart mid-sequence doesn't renew the budget. */
const limits = new TurnLimits(overseerTurnFile());
/** Who started the turn the Overseer is in: the caps' reset and the unattended read-only rule both
    read it, so they can never disagree. Starts unattended (fail closed), so does a restart. */
const turns = new UserTurns();
/** Whether the Overseer is answering the user right now. Exported for the tests. */
export const attendedForTest = () => turns.attended();

/** Sessions the Overseer created or prompted, for the running-at-once cap. */
const started = new Set<string>();
/** When the Overseer last created or prompted each local session (by path), for the sessions in
    play (§app.overseer/sessions-in-play); in memory, beside what its branch's tool results say. */
const touchedAt = new Map<string, number>();
const touchedHere = (): Touched[] => [...touchedAt].map(([path, at]) => ({ id: idOf(path), at }));
/** When the Overseer last sent a prompt to a session, until that session is seen running: its run
    reports streaming only after some async preflight, and it must count as running meanwhile. */
const promptedAt = new Map<string, number>();
export const STARTING_GRACE_MS = 15_000;

/** A session the Overseer started on a mesh peer, in `started`: never a path, so never a local one. */
const peerKey = (peerId: string, sessionId: string) => `peer:${peerId}:${sessionId}`;
/** Whether each peer-started session was busy when its host last answered (pollPeerStarted). */
const peerBusy = new Map<string, boolean>();
export const PEER_POLL_MS = 5000;
let peerPoll: ReturnType<typeof setInterval> | null = null;

const running = (key: string) => (key.startsWith("peer:") ? peerBusy.get(key) === true : isSessionBusy(key) || workingSubagents(key) > 0);

/** One pass over the peer-started sessions: each host is asked for its session's state; one that
    is idle and past its starting grace can't run again unless the Overseer prompts it, so it is
    dropped. A host that doesn't answer reads as idle: its session holds a slot only in its grace. */
async function pollPeerStarted(): Promise<void> {
  const keys = [...started].filter((k) => k.startsWith("peer:"));
  await Promise.all(
    keys.map(async (key) => {
      const [, peerId = "", id = ""] = key.split(":");
      const s = await peerSession(peerId, id).catch(() => null);
      const busy = !!s && (!!s.busy || (s.workers?.working ?? 0) > 0);
      peerBusy.set(key, busy);
      const at = promptedAt.get(key);
      if (!busy && (at === undefined || Date.now() - at >= STARTING_GRACE_MS)) {
        started.delete(key);
        peerBusy.delete(key);
        promptedAt.delete(key);
      }
    }),
  );
  if (![...started].some((k) => k.startsWith("peer:")) && peerPoll) {
    clearInterval(peerPoll);
    peerPoll = null;
  }
}

/** A peer's session by id: its by-id route, or `summary?id=` on a build that predates it. */
async function peerSession(peerId: string, id: string): Promise<SessionSummary | null> {
  for (const path of [`/api/sessions/by-id/${encodeURIComponent(id)}`, `/api/sessions/summary?id=${encodeURIComponent(id)}`]) {
    const res = await meshApi.peerFetch(peerId, path);
    if (res.status === 404 && path.includes("by-id")) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      // An unknown id answers the route's own sentence; a build without the route answers the catch-all.
      if (body?.error === "Not found") continue;
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as SessionSummary;
  }
  return null;
}

/** The Overseer runtime's driving session (watchSession): its registered tools include the subagents
    extension's tools, which the explorer routes call in-process (overseer-idea-tools.ts). */
let overseerSession: HarnessSession | null = null;

const host: OverseerToolHost = {
  request: (path, init) => {
    if (!dispatch) throw new Error("The Overseer's tools are not wired to the server yet.");
    const headers = new Headers(init?.headers);
    headers.set(OVERSEER_SENDER_HEADER, senderSecret());
    return dispatch(path, { ...init, headers });
  },
  overseerId: () => readOverseerState()?.current ?? "",
  caps: () => readOverseerSettings().caps,
  sessions: () => listSessions(),
  async session(ref) {
    const path = ref.includes("/") ? resolveSessionPath(ref) : await pathOfId(ref);
    if (!path) return null;
    const rt = await getModelRuntime().catch(() => null);
    return getSessionSummary(path, rt ? (r) => contextWindow(r, rt) : undefined);
  },
  digest: () => attentionForWire(),
  transcript: async (path) => rowsOf(await readBranch(path)),
  insight: (path) => getSessionInsight(path),
  checks: (path) => readinessChecksOf(path),
  held(path) {
    const chat = heldChat(path);
    if (!chat) return null;
    return { streaming: chat.harness.isRunning(), queued: chat.queue.size, dialogs: chat.pendingDialogs() };
  },
  answerDialog(path, dialogId, value, answer) {
    const chat = heldChat(path);
    if (!chat) throw new Error("That session isn't open on this server, so it has no dialog waiting here.");
    chat.answerDialog(dialogId, value, answer, host.overseerId());
  },
  open: async (path) => {
    await acquireChat(path);
  },
  setModel: async (path, ref) => {
    const chat = await acquireChat(path);
    await chat.setModelRef(ref);
  },
  setThinking: async (path, level) => (await acquireChat(path)).setThinking(level),
  pinMode: async (path) => {
    if (!(await acquireChat(path)).pinMode()) throw new Error("its mode entry could not be written");
  },
  sandbox: async (path) => (await acquireChat(path)).sandboxInfo(),
  // The extension's own default (index.ts defaultOn): an unreadable policy file starts sessions off.
  sandboxDefault: () => {
    const f = loadPolicyFile(policyFilePath(agentRoot()));
    return f.ok && f.value.defaultOn ? "on" : "subagents";
  },
  started: (path, prompted) => {
    started.add(path);
    touchedAt.set(path, Date.now());
    if (prompted) promptedAt.set(path, Date.now());
  },
  peer: async (id) => {
    const entry = meshApi.enabled() ? meshApi.peers().find((p) => p.id === id) : undefined;
    if (!entry) return null;
    const probe = await probePeer(entry);
    return { id: entry.id, label: entry.label, nodeId: entry.nodeId, state: probe.state, ...(probe.error ? { error: probe.error } : {}) };
  },
  peerSession: (peerId, id) => peerSession(peerId, id),
  peerIds: () => (meshApi.enabled() ? meshApi.peers().map((p) => p.id) : []),
  // peerFetch, never `request`: the sender secret is this process's and never leaves it.
  peerRequest: (id, path, init) => {
    const headers = new Headers(init?.headers);
    headers.delete(OVERSEER_SENDER_HEADER);
    return meshApi.peerFetch(id, path, { ...init, headers });
  },
  startedOnPeer: (peerId, sessionId, prompted) => {
    const key = peerKey(peerId, sessionId);
    started.add(key);
    if (prompted) promptedAt.set(key, Date.now());
    peerPoll ??= setInterval(() => void pollPeerStarted(), PEER_POLL_MS);
    peerPoll.unref?.();
  },
  links: meshLinks,
  worktrees: archiveWorktrees(readBranch),
  runningStarted: () => countRunning(started, running, promptedAt),
  counted: (path) => countRunning(started.has(path) ? [path] : [], running, promptedAt) > 0,
  attended: () => turns.attended(),
  confirmed: () => confirmedItems(turns.confirmedCard(), overseerSession ? overseerSession.branch() : []),
  // Approvals and rules (§app.overseer/approvals): read from the current runtime's file each call,
  // so a revoke applies from the next act on.
  permit(tool, sessions) {
    if (!overseerSession) return null;
    const now = Date.now();
    const p = coveringPermit(foldPermits(overseerSession.branch(), overseerSession.entries(), now), tool, sessions, now);
    return p ? { id: p.id, label: permitLabel(p) } : null;
  },
  aliases: () => readAliases(),
  setAlias: (id, alias) => setAlias(id, alias),
  used(id, tool, sessions, toolCallId) {
    if (overseerSession) overseerSession.state.append(GRANT_USE, { v: 1, id, tool, sessions, toolCallId, at: new Date().toISOString() });
  },
  explorer: () => readOverseerSettings().explorer,
  explorerCwd: () => overseerDir(),
  subagent: (name) => {
    const tool = overseerSession?.registeredTool(name);
    return tool ? (tool as unknown as SubagentTool) : null;
  },
};

/**
 * A peer's `sova_read_session` of one of this host's sessions (GET /api/peer/links/read, mounted by
 * server/mesh/links-routes.ts): the same bounded, untrusted-wrapped slice a local read renders,
 * redacted with this host's own secrets before it leaves; the asking host redacts it again.
 */
export async function renderPeerRead(
  path: string,
  opts: { from?: string; items?: number; chars?: number } = {},
  redactor: () => Redactor = serverRedactor,
): Promise<PeerLinkRead> {
  const s = await getSessionSummary(path);
  const title = s?.title ?? "Untitled";
  const items = rowsOf(await readBranch(path));
  const text = renderTranscript(items, {
    from: opts.from === "start" || opts.from === "last_user" ? opts.from : "tail",
    items: Math.min(40, Math.max(1, Math.trunc(opts.items ?? 20) || 20)),
    chars: Math.min(12000, Math.max(500, Math.trunc(opts.chars ?? 6000) || 6000)),
    title,
    id: s?.id ?? idOf(path),
  });
  // No contact of an org's roster leaves either (§app.overseer/org-projection), as no secret does.
  const contact = contactRedactor();
  return { text: contact.text(redactor().redact(text)), from: 0, total: items.length, title: contact.text(redactor().redact(title)) };
}

/**
 * The items a click on card `card` (its id, `c_N`) approves, when the run's opening message is that
 * click (§app.overseer/org-people-facing): the latest user message on the branch is exactly a
 * message a click on the card composes, and the card was open when it arrived (folded from what
 * precedes it). A card-level option approves every item; a per-item Apply only those it gave a
 * choice. Null otherwise: typed text, a closed card, a card id that matches nothing (a tool call id
 * from before card ids included). Pure over the branch, for the tests.
 */
export function confirmedItems(card: string | null, branch: readonly HEntry[]): SovaConfirmItem[] | null {
  if (!card) return null;
  let last = branch.length - 1;
  while (last >= 0 && branch[last]!.kind !== "user") last--;
  if (last < 0) return null;
  const c = cardsOnBranch(branch.slice(0, last)).find((x) => x.id === card);
  if (!c || c.phase !== "open") return null;
  const click = matchCardClick(c, joinedText(branch[last]!, { images: false }).trim());
  if (!click) return null;
  return clickItems(c, click).map(({ n: _n, default: _d, decided: _x, ...item }) => item as SovaConfirmItem);
}

/**
 * The approval for later or standing rule a card click writes (§app.overseer/approvals), or
 * nothing: the latest user message on `branch` must be exactly what a click on `card` composes,
 * with the card open when it arrived (the people-facing gate's own test), and the option it chose
 * must carry `later` or `rule`. `all` is the whole file (numbering, one write per click). Pure.
 */
export function permitOnClick(card: string | null, branch: readonly HEntry[], all: readonly HEntry[], now = new Date().toISOString()): ReturnType<typeof permitFromClick> {
  if (!card) return undefined;
  let last = branch.length - 1;
  while (last >= 0 && branch[last]!.kind !== "user") last--;
  const message = branch[last]?.id;
  if (last < 0 || !message || clickWrote(all, message)) return undefined;
  const c = foldCards(branch.slice(0, last)).find((x) => x.id === card);
  if (!c || c.phase !== "open") return undefined;
  const click = matchCardClick(c, joinedText(branch[last]!, { images: false }).trim());
  return click ? permitFromClick(c, click, all, message, now) : undefined;
}

/** "any act on these 3 sessions until 6:00 PM" / "rule: <text>". */
export function permitLabel(p: Permit): string {
  if (p.kind === "grant") return `${p.card} ${p.option}: any act on ${sessionsText(p.sessions)} until ${p.until}`;
  return `${p.card} ${p.option}: "${p.text}" (${actsText(p.acts)} on ${sessionsText(p.sessions)})`;
}

/** The Overseer file's entries: the held runtime's, else read from disk. */
async function overseerEntries(): Promise<{ path: string; branch: readonly HEntry[]; all: readonly HEntry[] } | null> {
  const st = readOverseerState();
  const path = st ? await pathOfId(st.current) : null;
  if (!path) return null;
  const chat = heldChat(path);
  if (chat) return { path, branch: chat.harness.branch(), all: chat.harness.entries() };
  const { entries } = parsePi(await readFile(path, "utf8").catch(() => ""));
  return { path, branch: branchOf(entries), all: entries };
}

/** GET /api/overseer/autonomy: the running count and cap, and every grant and rule. */
export async function overseerAutonomy(): Promise<OverseerAutonomy> {
  const cap = readOverseerSettings().caps.concurrentSessions;
  const count = countRunning(started, running, promptedAt);
  const e = await overseerEntries();
  const schedules = await schedulesForWire().catch(() => []);
  return { running: count, cap, permits: e ? foldPermits(e.branch, e.all, Date.now()) : [], ...(schedules.length ? { schedules } : {}) };
}

/** POST /api/overseer/autonomy/revoke: append the revoke through the Overseer's own runtime. */
export async function revokePermit(id: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const e = await overseerEntries();
  const p = e ? foldPermits(e.branch, e.all, Date.now()).find((x) => x.id === id) : undefined;
  if (!e || !p) return { ok: false, status: 404, error: `No approval or rule ${id} in the current Overseer conversation.` };
  if (p.status !== "live") return { ok: false, status: 409, error: `${id} has already ${p.status === "expired" ? "expired" : "been revoked"}.` };
  const chat = await acquireChat(e.path);
  chat.harness.state.append(REVOKE, { v: 1, id, at: new Date().toISOString(), by: "user" });
  return { ok: true };
}


/**
 * before_agent_start's hidden message in the global Overseer: the run note (§app.overseer/run-note:
 * the time now, the briefed blockers that cleared, open cards' sessions that merged or were
 * archived), then the open cards (§app.overseer/confirm). One message, so it stays the cards note
 * the attendance rule treats as state. A failure to read the sessions still sends the time and the cards.
 */
export async function runNoteMessage(branch: readonly HEntry[], now = new Date(), prompt: { changed?: string; opening?: OpeningDetails } = {}): Promise<{ message: { customType: string; content: string; display: false; details?: unknown } }> {
  const cardsText = cardsNote(cardsOnBranch(branch), false, sessionActivity());
  let note: { content: string; details: unknown };
  try {
    const prompted = touchedHere();
    const states = await sessionsNow(runNoteSessionIds(branch, now.getTime(), prompted));
    const digest = await attentionDigest();
    const act = digest.items.filter((i) => i.tier === "act");
    note = runNote({
      now,
      branch,
      act: { keys: new Set(act.map(blockerKey)), complete: act.length >= digest.counts.act },
      session: (id) => states.get(id) ?? null,
      prompted,
      ...(cardsText ? { cardsText } : {}),
      redact: (t) => serverRedactor().redact(t),
      ...prompt,
    });
  } catch (err) {
    console.warn("[overseer] run note without sessions:", err instanceof Error ? err.message : String(err));
    note = runNote({ now, branch: [], act: { keys: new Set(), complete: false }, session: () => null, ...(cardsText ? { cardsText } : {}), ...prompt });
  }
  return { message: { customType: CARDS_NOTE_MESSAGE, content: note.content, display: false, details: note.details } };
}

/** A session's state as the sessions in play name it (overseer-tools' list rows say it the same way). */
function stateNow(s: SessionSummary): string {
  if (s.pendingDialogs) return "needs-input";
  if (s.busy) return "working";
  return s.activity?.state ?? "idle";
}

/** Each session the run note names, as it is now; null when it is gone. */
async function sessionsNow(ids: readonly string[]): Promise<Map<string, SessionNow | null>> {
  const aliases = readAliases();
  const states = new Map<string, SessionNow | null>();
  for (const id of ids) {
    const path = await pathOfId(id);
    const s = path ? await getSessionSummary(path) : null;
    states.set(
      id,
      s
        ? {
            name: sessionName(s, aliases[s.id]),
            archived: s.archived,
            ...(mergedBranch(s) ? { merged: s.readiness!.since } : {}),
            waitsOnAnswers: !!s.align && s.align.openQuestions > 0,
            state: stateNow(s),
            branches: branchLabels(s.readiness),
          }
        : null,
    );
  }
  return states;
}

/**
 * The note written once after a compaction (§app.overseer/confirm, §app.overseer/sessions-in-play):
 * the sessions in play, then the exact open cards; undefined when there is neither.
 */
export async function compactNoteMessage(branch: readonly HEntry[], now = Date.now()): Promise<{ customType: string; content: string; display: false } | undefined> {
  const cards = cardsNote(cardsOnBranch(branch), true, sessionActivity());
  let play: string | undefined;
  try {
    const inPlay = sessionsInPlay(branch, now, touchedHere());
    const states = await sessionsNow(inPlay.map((p) => p.id));
    const text = sessionsInPlayText(inPlay, (id) => states.get(id) ?? null, now);
    play = text ? serverRedactor().redact(text) : undefined;
  } catch (err) {
    console.warn("[overseer] compaction note without sessions in play:", err instanceof Error ? err.message : String(err));
  }
  const content = [play, cards].filter(Boolean).join("\n\n");
  return content ? { customType: CARDS_NOTE_MESSAGE, content, display: false } : undefined;
}

/**
 * The id check's hidden note for a run's messages (§app.overseer/id-check), or null when every
 * session it linked is a file on this host. Names come summary-first and are redacted.
 */
export async function idNoteMessage(messages: readonly unknown[]): Promise<{ customType: string; content: string; display: false; details: unknown } | null> {
  const note = await idCheckNote(assistantText(messages), {
    known: async (id) => (await pathOfId(id)) !== null,
    allIds: async () => (await listSessionFiles()).map(idOf),
    name: async (id) => {
      const path = await pathOfId(id);
      const s = path ? await getSessionSummary(path) : null;
      return s ? sessionName(s, readAliases()[s.id]) : undefined;
    },
  });
  return note ? { customType: ID_NOTE_MESSAGE, content: serverRedactor().redact(note.content), display: false, details: note.details } : null;
}


/** An in-process call exactly as the Overseer's tools make it. Exported for the tests. */
export const requestAsOverseerForTest = (path: string, init?: RequestInit) => host.request(path, init);

/** Overseer-started sessions that count as running: running now, or prompted within the grace and
    not yet seen running (seeing one running ends its grace). Exported for the tests. */
export function countRunning(paths: Iterable<string>, isRunning: (path: string) => boolean, prompted: Map<string, number>, now = Date.now()): number {
  let n = 0;
  for (const p of paths) {
    const at = prompted.get(p);
    if (isRunning(p)) {
      prompted.delete(p);
      n++;
    } else if (at !== undefined && now - at < STARTING_GRACE_MS) n++;
    else prompted.delete(p);
  }
  return n;
}


/**
 * The values the Overseer's prompt is rendered from, as they are now: the time, the standing notes,
 * the ideas' table of contents, the todos' counts, the caps and `EXTRA` (the user's extra
 * instructions as their prompt part, redacted; empty when none). A conversation keeps the values it
 * opened with (overseer-opening.ts); what changed since is told in its run note.
 */
export function overseerValues(settings: OverseerSettings, now = new Date(), redactor: () => Redactor = serverRedactor): Record<string, string> {
  const notes = readNotes().trim();
  const c = settings.caps;
  return {
    NOW: now.toString(),
    NOTES: notes ? redactor().redact(notes.slice(0, 4000)) : "(none yet)",
    IDEAS: redactor().redact(promptToc(readManifest(), readOverseerState()?.current ?? "")),
    TODOS: promptTodos(readTodos()),
    CAPS: `${c.createPerTurn} new sessions, ${c.promptsPerTurn} prompts to other sessions or explorers, ${c.archivesPerTurn} archive operations, ${c.explorePerTurn} explorers launched, ${c.linksPerTurn} links made, ${c.orgWritesPerTurn} organization writes, ${c.gatherPerTurn} gathering sessions or offers started; at most ${c.concurrentSessions} sessions you started running at once`,
    EXTRA: extraInstructions(settings.extraSystemPrompt, redactor).join(""),
  };
}

/** The parts of the Overseer's prompt that can change while it runs, from its values. */
export function overseerLiveParts(values: Readonly<Record<string, string>>): LivePart[] {
  const v = (k: string) => values[k] ?? "";
  return [
    { key: "NOTES", title: "Standing notes", text: v("NOTES") },
    { key: "IDEAS", title: "Ideas backlog (its table of contents)", text: v("IDEAS") },
    { key: "TODOS", title: "Todos checklist", text: v("TODOS") },
    { key: "CAPS", title: "Limits per message from the user", text: v("CAPS") },
    { key: "EXTRA", title: "The user's extra instructions for you", text: v("EXTRA").replace(/^# The user's extra instructions for you\n\n/, "") },
  ];
}

/** The Overseer's prompt, rendered from the repo's .md (the runtime reads the .md once, so an edit
    to it applies at the next open) with `values` (overseerValues: now's, or the conversation's opening ones). */
export function renderOverseerPrompt(
  tools: { name: string; promptSnippet?: string; description: string }[],
  settings: OverseerSettings,
  template = readFileSync(PROMPT_FILE, "utf8"),
  now = new Date(),
  redactor: () => Redactor = serverRedactor,
  values: Readonly<Record<string, string>> = overseerValues(settings, now, redactor),
): string {
  return template
    .replaceAll("{{TOOLS}}", toolCatalogue(tools))
    .replaceAll("{{IDEAS}}", values.IDEAS ?? "")
    .replaceAll("{{TODOS}}", values.TODOS ?? "")
    .replaceAll("{{NOTES}}", values.NOTES ?? "")
    .replaceAll("{{NOW}}", values.NOW ?? now.toString())
    .replaceAll("{{HOME}}", homedir())
    .replaceAll("{{CAPS}}", values.CAPS ?? "");
}

/** The user's extra instructions (Settings → Overseer) as a prompt part, none when blank. Redacted
    like the notes (renderOverseerPrompt) and every tool's output. */
export function extraInstructions(extra: string, redactor: () => Redactor = serverRedactor): string[] {
  const t = extra.trim();
  return t ? [`# The user's extra instructions for you\n\n${redactor().redact(t)}`] : [];
}

/** The tools as the runtime registers them (exported for the prompt/tool set-equality test). */
export const buildOverseerTools = () => overseerTools(host, limits);

/**
 * The Overseer's appended prompt, fixed at opening (§app.overseer/hosting): rendered from the values
 * the conversation opened with (its first run note's `opening`, overseer-opening.ts), so it stays
 * byte-identical across runs, runtimes and server restarts and the provider's cache holds. The notes,
 * ideas, todos, caps and extra instructions are re-read at every run, and what changed since the
 * Overseer was last told goes in that run's note (`noteParts`), never into this prompt.
 *
 * Two places need it. A run started by a message (the user's, a brief, a wake-up) builds its prompt
 * from `before_agent_start`, which sets it. A run started by an extension's message
 * (`sendMessage(…, {triggerTurn:true})`) skips that hook and builds later requests from the
 * session's base options, which the SDK builds from the loader's parts: `parts` is that very array,
 * refilled in place, and `rebase` has the session rebuild them (at every run's start).
 */
class LivePrompt {
  /** The array the resource loader holds (the user's APPEND_SYSTEM.md parts, then ours). */
  readonly parts: string[] = [];
  private base: string[] = [];
  private readonly built = new WeakMap<object, string>();
  /** The conversation's opening values, once a run has read them from its branch or set them. */
  private opened?: Record<string, string>;
  constructor(
    private readonly tools: { name: string; promptSnippet?: string; description: string }[],
    private readonly template: string,
    private readonly openedAt: Date,
  ) {}
  /** The resource loader's override: the user's own parts, then the Overseer's. */
  seed(base: string[]): string[] {
    this.base = base;
    this.refresh();
    return this.parts;
  }
  /** The opening values: the branch's recorded ones, else those this runtime set, else now's (not kept
      until a branch is known: the loader asks before the conversation is read). */
  private opening(branch?: readonly HEntry[]): Record<string, string> {
    const recorded = branch ? openingOn(branch) : undefined;
    if (recorded) return (this.opened = recorded);
    if (this.opened) return this.opened;
    const now = overseerValues(readOverseerSettings(), this.openedAt);
    if (branch) this.opened = now;
    return now;
  }
  /** Fill `parts` from the opening values; returns the text the SDK joins them to. */
  refresh(branch?: readonly HEntry[]): string {
    const values = this.opening(branch);
    const next = [...this.base, renderOverseerPrompt(this.tools, readOverseerSettings(), this.template, this.openedAt, serverRedactor, values), ...(values.EXTRA ? [values.EXTRA] : [])];
    this.parts.splice(0, this.parts.length, ...next);
    return next.join("\n\n");
  }
  /** A run's note parts (overseer-opening.ts): what changed since the Overseer was last told, and the details to record. */
  noteParts(branch: readonly HEntry[], now: Date): { changed?: string; opening: OpeningDetails } {
    const recorded = openingOn(branch);
    const opened = this.opening(branch);
    const changed = changedText(overseerLiveParts(overseerValues(readOverseerSettings(), now)), toldOn(branch, overseerLiveParts(opened)));
    return {
      ...(changed.text ? { changed: changed.text } : {}),
      opening: { ...(recorded ? {} : { opening: opened }), ...(Object.keys(changed.told).length ? { told: changed.told } : {}) },
    };
  }
  /** A run starts: bring the session's base options to the opening text (a no-op when unchanged). */
  rebase(session: Pick<HarnessSession, "refreshSystemPrompt" | "branch">): void {
    const text = this.refresh(session.branch());
    if (this.built.get(session) === text) return;
    this.built.set(session, text);
    // The SDK rebuilds the base prompt options from the loader's parts (quirk P19).
    session.refreshSystemPrompt();
  }
}

/** The prompt of the runtime built last (there is one Overseer runtime at a time); taken by its session in watchSession. */
let livePrompt: LivePrompt | null = null;

setOverseerRuntime({
  async loadout(path) {
    const st = readOverseerState();
    if (!st || idOf(path) !== st.current)
      throw new BusyError("This is a previous Overseer conversation. It is read-only; the eye button opens the current one.", "busy");
    const settings = readOverseerSettings();
    const tools = buildOverseerTools();
    const prompt = new LivePrompt(tools, readFileSync(PROMPT_FILE, "utf8"), new Date());
    livePrompt = prompt;
    return {
      resourceLoaderOptions: {
        extensionFactories: [
          {
            name: "sova-overseer",
            factory: (pi) => {
              for (const t of tools) pi.registerTool(toPiTool(t));
              // A run started by a message: its prompt, with the notes and settings as they are now.
              // The run note (the time now, what cleared) and the open cards ride the prompt as a
              // hidden message, never the system prompt (a prompt change restarts a Claude Code CLI
              // and breaks the cache): persisted, so a restart or a fold keeps it.
              pi.on("before_agent_start", async (event, ctx) => {
                const branch = toolCtx(ctx).branch();
                event.systemPromptOptions.appendSystemPrompt = prompt.refresh(branch);
                const now = new Date();
                return runNoteMessage(branch, now, prompt.noteParts(branch, now));
              });
              // The id check (§app.overseer/id-check): a run that linked a session id this host has no
              // file for leaves a hidden note naming the nearest real id. Sent while the run still
              // streams, so the SDK appends it once the run's last message is in; the reply is never changed.
              pi.on("agent_end", async (event) => {
                try {
                  const note = await idNoteMessage(event.messages);
                  if (note) pi.sendMessage(note);
                } catch (err) {
                  console.warn("[overseer] id check skipped:", err instanceof Error ? err.message : String(err));
                }
              });
              // A compaction summarizes the card results away: the exact open cards, once, after it.
              // The sessions in play go with them (§app.overseer/sessions-in-play), even with no card open.
              pi.on("session_compact", async (_event, ctx) => {
                const note = await compactNoteMessage(toolCtx(ctx).branch());
                if (note) pi.sendMessage(note);
              });
              // Worker reports and other extension messages reach the model redacted, like every tool's output.
              pi.on("context", (event) => {
                const messages = redactExtensionMessages(event.messages, serverRedactor());
                return messages === event.messages ? undefined : { messages };
              });
            },
          },
          // Its memory, when its own switch is on (§chat.memory/overseer): the same engine as a chat's.
          memoryExtension(() => {
            const chat = heldChat(path);
            return chat && !chat.disposed ? chat.memoryHost() : null;
          }),
        ],
        // The OVERRIDE, not appendSystemPrompt: passing appendSystemPrompt suppresses discovery of
        // the user's own APPEND_SYSTEM.md, and the override keeps it (resource-loader.js:386-396).
        appendSystemPromptOverride: (base) => prompt.seed(base),
      },
      tools: [...tools.map((t) => t.name), ...BUILTIN_ALLOWED, ...MEMORY_TOOLS],
      // read/grep/find/ls reach anywhere except secret files and the attached orgs' workspaces (overseer-deny.ts).
      customTools: overseerFileTools(overseerDir(), () => new OverseerGuard(readIndex().orgs.map((o) => o.dir))),
      model: settings.model,
      thinking: settings.thinking,
    };
  },
  saveChoice(patch) {
    patchOverseerSettings(patch);
  },
  opened: keepNormal,
  // The user's message goes to the SDK through userSend; the run becomes theirs (and the caps
  // renew) when the message that call produced enters the context. Every run starts unattended, and
  // a brief, a wake-up or an extension's message never goes through it: read-only, on the same budget.
  watchSession(session) {
    overseerSession = session;
    // Its model requests are background work under a provider's request limit (§app.provider-limits/queue).
    markBackground(session.id);
    turns.watch(session);
    const prompt = livePrompt;
    session.subscribe((event) => {
      if (event.type === "run.start") prompt?.rebase(session);
      if (turns.observe(event)) limits.reset();
      // A click that approves for later or adopts a rule: the server writes it, once the click's
      // message is in the file (the SDK appends it right after this event's listeners run).
      if (event.type === "message.end" && event.role === "user" && turns.confirmedCard()) {
        const card = turns.confirmedCard();
        setImmediate(() => {
          try {
            const w = permitOnClick(card, session.branch(), session.entries());
            if (w) {
              const state = session.state;
              if (w.type === RULE_ENTRY) state.append(RULE, w.data);
              else state.append(GRANT, w.data);
            }
          } catch (err) {
            console.warn("[overseer] approval not written:", err instanceof Error ? err.message : String(err));
          }
        });
      }
    });
  },
  userSend(send, confirm) {
    return turns.send(send, confirm);
  },
});

// ---- the one-session prompt route (sova_send) -----------------------------------------------------------


// ---- proactivity: "Brief me" -----------------------------------------------------------------------

const TICK_MS = 20_000;
export const BRIEF_MIN_GAP_MS = 10 * 60_000;
export const BRIEF_MAX_UNATTENDED = 30;

/** A briefed blocker that cleared and stands again within this long is the same blocker, not news
    (§app.overseer/brief-repeat): longer than a working turn that hides a session's open questions
    while it runs (the audit saw the same session re-briefed every 16–17 minutes as it ran and
    stopped), short enough that a blocker back after an hour is news again. */
export const BRIEF_REPEAT_MS = 60 * 60_000;

/** What a brief told about one blocker: its count then, and when it cleared since (absent while it stands). */
export interface Told {
  count: number;
  clearedAt?: number;
}

/**
 * Which blockers are new, and whether to brief now. Pure, for the tests. `announced` is what the
 * user has been told about (or what was already there when watching began), with each blocker's
 * count then (`counts`, default 1). Per §app.overseer/brief-repeat a standing blocker is new again
 * only when its count rises above the count told; one that clears is remembered for
 * BRIEF_REPEAT_MS, so its return within that is not new (unless its count rose), and after it it is.
 */
export function briefDecision(input: {
  current: string[];
  counts?: ReadonlyMap<string, number>;
  announced: ReadonlyMap<string, Told> | null;
  proactivity: OverseerSettings["proactivity"];
  now: number;
  lastBriefAt: number;
  unattended: number;
  overseerIdle: boolean;
}): { announced: Map<string, Told>; brief: string[] } {
  const count = (k: string) => input.counts?.get(k) ?? 1;
  const current = new Set(input.current);
  if (input.announced === null || input.proactivity !== "brief") return { announced: new Map(input.current.map((k) => [k, { count: count(k) }])), brief: [] };
  const announced = new Map<string, Told>();
  // Told and gone: remembered from when it cleared, for BRIEF_REPEAT_MS.
  for (const [k, told] of input.announced) {
    if (current.has(k)) continue;
    const clearedAt = told.clearedAt ?? input.now;
    if (input.now - clearedAt < BRIEF_REPEAT_MS) announced.set(k, { count: told.count, clearedAt });
  }
  const fresh: string[] = [];
  for (const k of input.current) {
    const told = input.announced.get(k);
    const known = told && (told.clearedAt === undefined || input.now - told.clearedAt < BRIEF_REPEAT_MS) ? told : undefined;
    if (!known || count(k) > known.count) fresh.push(k);
    // Standing (again): told at the count it was told at; a new one waits as new until a brief carries it.
    if (known) announced.set(k, { count: known.count });
  }
  const may = fresh.length > 0 && input.overseerIdle && input.now - input.lastBriefAt >= BRIEF_MIN_GAP_MS && input.unattended < BRIEF_MAX_UNATTENDED;
  if (!may) return { announced, brief: [] };
  for (const k of fresh) announced.set(k, { count: count(k) });
  return { announced, brief: fresh };
}

let announced: Map<string, Told> | null = null;
let lastBriefAt = 0;
let unattended = 0;

/** The brief's message. Titles and details come from other sessions: redacted like any tool output. */
export function briefText(items: Pick<AttentionItem, "kind" | "title" | "id" | "detail" | "name">[], redactor: () => Redactor = serverRedactor): string {
  const lines = items.map((i) => `- ${i.kind}: [${(i.name ?? i.title).replace(/[[\]]/g, "")}](sova://s/${i.id})${i.detail ? ` — ${i.detail}` : ""}`);
  return redactor().redact(`${OVERSEER_BRIEF_PREFIX} ${items.length === 1 ? "A new blocker" : `${items.length} new blockers`} appeared while you were idle:\n${lines.join("\n")}`);
}

async function tick(): Promise<void> {
  await applySettingsNow();
  const settings = readOverseerSettings();
  const st = readOverseerState();
  // Phone notifications (server/push.ts) ride the same digest, with no Overseer needed and under
  // every proactivity. With nothing to send to, the digest is read only for a brief.
  const wanted = pushWanted();
  if (!wanted) resetPushState();
  if (!st && !wanted) return; // no Overseer yet and no phone to tell: nothing to do
  const digest = await attentionDigest();
  const act = digest.items.filter((i) => i.tier === "act");
  if (wanted) await notifyBlockers(act, digest.badge.act);
  if (!st) return; // no Overseer yet: nothing to brief
  const path = await pathOfId(st.current);
  if (!path) return;
  // The user looked at the Overseer since the last brief: the unattended run starts over.
  if ((readSeen()[st.current] ?? 0) > lastBriefAt || isViewing(st.current)) unattended = 0;
  const chat = heldChat(path);
  const idle = !chat || (!chat.harness.isRunning() && chat.queue.size === 0);
  const counts = new Map(act.map((i) => [blockerKey(i), blockerCount(i)]));
  const d = briefDecision({ current: act.map(blockerKey), counts, announced, proactivity: settings.proactivity, now: Date.now(), lastBriefAt, unattended, overseerIdle: idle });
  announced = d.announced;
  if (!d.brief.length) return;
  const text = briefText(act.filter((i) => d.brief.includes(blockerKey(i))));
  try {
    const overseer = await acquireChat(path);
    overseer.assertModelAllowed();
    const { turn } = overseer.acceptPrompt(text, undefined, "server");
    void turn.catch((err) => overseer.reportTurnFailure(err));
    lastBriefAt = Date.now();
    unattended++;
  } catch (err) {
    console.warn("[overseer] brief skipped:", err instanceof Error ? err.message : String(err));
  }
}

/** One brief to the Overseer under Brief Me (the auto-resume report); nothing under any other proactivity. */
async function sendBrief(body: string): Promise<void> {
  if (readOverseerSettings().proactivity !== "brief") return;
  const st = readOverseerState();
  const path = st ? await pathOfId(st.current) : null;
  if (!path) return;
  const overseer = await acquireChat(path);
  overseer.assertModelAllowed();
  const { turn } = overseer.acceptPrompt(serverRedactor().redact(`${OVERSEER_BRIEF_PREFIX} ${body}`), undefined, "server");
  void turn.catch((err) => overseer.reportTurnFailure(err));
  lastBriefAt = Date.now();
}

/** Free slots of the running-at-once cap, for a schedule's fire as for a resume (§chat.schedules/fire). */
export const freeRunSlots = (): number => readOverseerSettings().caps.concurrentSessions - countRunning(started, running, promptedAt);
/** A session a schedule started or woke counts toward that cap, as a resumed one does. */
export const countStarted = (path: string): void => host.started(path, true);
/** One brief to the Overseer under Brief Me, nothing otherwise (a schedule found, §chat.schedules/where-shown). */
export const briefOverseer = (body: string): Promise<void> => sendBrief(body);

/**
 * Resume the runs the last stop cut off (§app.overseer/auto-resume), once, a few seconds after
 * start: read and empty the ledger now, before this process starts runs of its own.
 */
export function startAutoResume(): void {
  const runs = runLedger.takeInterrupted();
  if (!runs.size) return;
  const timer = setTimeout(() => {
    const settings = readOverseerSettings();
    void resumeInterrupted(runs, {
      enabled: settings.autoResume !== false,
      session: async (path) => {
        const s = await getSessionSummary(path);
        if (!s) return null;
        return { ...s, name: sessionName(s, readAliases()[s.id]), projectOverseer: !!projectOverseerOfPath(path) };
      },
      freeSlots: () => readOverseerSettings().caps.concurrentSessions - countRunning(started, running, promptedAt),
      prompt: async (path, text) => {
        const r = await promptSession(path, text, readOverseerState()?.current);
        if (!r.ok) throw new Error(r.error);
        host.started(path, true);
      },
      log: (path, outcome, why) =>
        logAction({ at: new Date().toISOString(), overseerId: readOverseerState()?.current ?? "", toolCallId: "", tool: "auto_resume", args: { path }, outcome, ...(why ? { error: why } : {}) }),
      brief: sendBrief,
    }).catch((err) => console.warn("[auto-resume] failed:", err instanceof Error ? err.message : String(err)));
  }, RESUME_DELAY_MS);
  timer.unref();
}

let ticking = false;
/** Start the background loop (index.ts, once). Brief turns start only under "brief"; phone
    notifications go out under any proactivity; the loop also applies a Settings model change that
    arrived mid-turn. */
export function startOverseerLoop(): void {
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.warn("[overseer] tick failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref();
}

