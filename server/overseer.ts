import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { agentRoot } from "./state-root";
import { fromPiToolDefinition } from "./harness/pi/tools";
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
  type SessionFeedMessage,
  type SessionSummary,
  type SovaConfirmItem,
} from "../shared/protocol";
import { type AttentionRow, blockerCount, blockerKey, buildDigest, mergedBranch, NEVER_BRIEFED, workerErrorTime } from "./attention";
import { readIndex, stakeholderAttention } from "./orgs";
import { heldAttention } from "./project-holds";
import { conflictAttention } from "./decisions";
import { senderAttention } from "./outreach/health";
import { ownerAttention } from "./owner-attention";
import { notSentAttention } from "./outreach/log";
import { PROCESS_START_MS, readinessChecksOf, readinessCovers, readinessParked, readinessReading, restartItems, settleReadiness } from "./merge-readiness";
import { RoundupGit } from "./overseer-roundup-git";
import { readLedger } from "./removed-worktrees";
import {
  acquireChatHandle,
  BusyError,
  type ChatHandle,
  chatHandle,
  closeChat,
  getModelRuntime,
  isSessionBusy,
  serverToolCall,
  type ServerToolRun,
  declOfTool,
  isOverseerFile,
  registerSpecialHost,
  serveTools,
} from "./chat-handle";
import { activityOf, failedWorkersOf, readLiveRecords, workerErrorTimesOf, workingSubagents } from "./live";
import { listModels, contextWindow } from "./models";
import { modelDenial, readModelPolicy } from "./model-policy";
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
import { BUILTIN_ALLOWED, overseerTools, type OverseerToolHost, renderTranscript, TurnLimits, UNATTENDED_WRITE_REFUSAL } from "./overseer-tools";
import { OVERSEER_SENDER_HEADER, overseerSender, senderSecret } from "./overseer-sender";

import { onSessionPrompted, pathOfId, promptSession, sessionActivity, toolCatalogue, type PromptDelivery, type PromptResult } from "./session-prompt";
import { contactRedactor } from "./overseer-org-view";
import { CARDS_NOTE_MESSAGE, cardsNote, clickItems, foldCards, matchCardClick } from "../shared/overseer-card";
import { actsText, carriedRules, clickWrote, coveringPermit, foldPermits, type Permit, permitFromClick, RULE_ENTRY, type RuleEntry, sessionsText } from "../shared/overseer-grants";
import { readAliases, sessionName, setAlias } from "./session-names";
import { RESUME_DELAY_MS, type ResumeDeps, resumeInterrupted } from "./auto-resume";
import { schedulesForWire } from "./schedules";
import { overseerFileTools, ownStateRoots } from "./overseer-file-tools";
import { OverseerGuard } from "./overseer-deny";
import { projectOverseerOfPath } from "./project-overseer-store";
import { type Redactor, redactExtensionMessages, serverRedactor } from "./overseer-redact";
import { canonicalPath, resolveSessionPath } from "./paths";
import { isViewing, markSeen, readSeen } from "./seen";
import { UnreadReplies } from "./unread-replies";
import { cleanupSessions, markArchived, endingOf, getSessionSummary, idOf, indexedSessionPaths, lastReplyAtOf, listSessionFiles, listSessions, summaryReads, type SummaryReads } from "./sessions-index";
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
import { confirmedClicks } from "./overseer-copies";
import type { HEntry, ToolSpec } from "../shared/harness";
import type { ServerToolDecl } from "../shared/chat-runtime";
import { archiveWorktrees } from "./archive-worktrees";
import { markOwned } from "./write-guard";
import { signalTextOf, teamStallOf } from "./signals-store";
import { openOfferOf } from "./session-offers";
import { openCardsOf } from "./transcript-cards";
import { readDecisionSettings } from "./decide-settings";
import { onAttentionChanged } from "./attention-memo";
import { sessionFeed } from "./session-feed";
import { notifyBlockers, pushWanted, resetPushState } from "./push";
import { MEMORY_TOOLS } from "../shared/memory";
import { overseerMemoryOf } from "./memory/settings";
import { playbookReviews } from "./projects/playbook-review";
import { tourSignInWaits } from "./tours/sign-in-notice";
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
    await markArchived(id, p);
    paths.push(p);
  }
  if (paths.length) await cleanupSessions({ mode: "paths", paths, dryRun: false }).catch(() => {});
}

/** The Overseer always runs in the normal mode with no minor modes: Delegate would route its work to
    workers and the spec minor mode would start writing claims. Every open of its runtime brings it
    back (the `opened` hook below), so a stale mode entry on its branch never stands; a switch is
    refused (ChatSession.switchMode). A chat already normal is left untouched, so opening writes
    nothing. `strict` is Delegate's alone and is left as it is. */
async function keepNormal(chat: ChatHandle): Promise<void> {
  try {
    const s = chat.mirror.mode;
    if (s.mode !== "normal" || s.minorModes.length) await chat.applyMode({ mode: "normal", minorModes: [] });
  } catch (err) {
    console.warn("[overseer] could not set the normal mode:", err instanceof Error ? err.message : String(err));
  }
}

/** A brand-new file (creation, /clear): open it, which makes it normal. */
async function normalMode(path: string): Promise<void> {
  try {
    await keepNormal(await acquireChatHandle(path));
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
    const chat = chatHandle(oldPath);
    if (chat?.mirror.running) await chat.drainAndAbort().catch(() => {});
    await closeChat(oldPath, "The Overseer was cleared. Opening the new conversation.");
  }
  limits.reset();
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

/** The Overseer's state. `list`, the session feed's own (§app.decisions/push): its history rows and
    digest come from it, with no read of their own; without it, the stores every history row reads
    are read once for all of them. */
export async function overseerInfo(list?: readonly SessionSummary[]): Promise<OverseerInfo> {
  const cur = await ensureOverseer();
  const st = readOverseerState();
  const history: OverseerInfo["history"] = [];
  const byId = list ? new Map(list.map((s) => [s.id, s])) : null;
  let reads: SummaryReads | undefined;
  for (const id of st?.history ?? []) {
    const row = byId?.get(id);
    if (row) {
      history.push({ id, path: row.path, title: row.title, lastActiveAt: row.lastActiveAt });
      continue;
    }
    const p = await pathOfId(id);
    if (!p) continue;
    reads ??= summaryReads();
    const s = await getSessionSummary(p, undefined, reads);
    if (s) history.push({ id, path: p, title: s.title, lastActiveAt: s.lastActiveAt });
  }
  const digest = await attentionDigest(list);
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
let digestMemo: { at: number; value: Promise<ReturnType<typeof buildDigest>>; list?: readonly SessionSummary[] } | null = null;
onAttentionChanged(() => (digestMemo = null));
onSessionPrompted(() => (digestMemo = null));

/** The digest, memoised ~3s. `list` (the session feed's own, §app.decisions/push) builds it from
    that list, reusing a memo built from the same list; the memo then serves requests too. */
export function attentionDigest(list?: readonly SessionSummary[]): Promise<ReturnType<typeof buildDigest>> {
  const now = Date.now();
  if (digestMemo && now - digestMemo.at < DIGEST_MS && (!list || digestMemo.list === list)) return digestMemo.value;
  // While nothing changed since the feed's last list, that list is current: no build of its own.
  const fed = list ?? sessionFeed()?.cleanRows(now) ?? undefined;
  const value = (async () => {
    const sessions = fed ?? (await listSessions());
    const records = readLiveRecords({ includeOwn: true });
    const byPath = new Map<string, { failed: number; since: number; errorTimes: number[] }>();
    for (const r of records) {
      if (!r.sessionFile) continue;
      const prev = byPath.get(r.sessionFile);
      const failed = failedWorkersOf(r.rec);
      const since = activityOf(r.rec)?.since ?? 0;
      byPath.set(r.sessionFile, {
        failed: Math.max(failed, prev?.failed ?? 0),
        since: Math.max(since, prev?.since ?? 0),
        errorTimes: [...(prev?.errorTimes ?? []), ...workerErrorTimesOf(r.rec)],
      });
    }
    const nowMs = Date.now();
    // A stalled team (§app.decisions/team-stall) shows only while attention signals are on.
    const stallsOn = readDecisionSettings().features.attention;
    for (const p of [...failedRise.keys()]) if (!byPath.get(p)?.failed) failedRise.delete(p);
    const aliases = readAliases();
    // Proposed verb playbook runs (§app.project-runtime/review), by their session file.
    const reviews = playbookReviews();
    // Tour recordings waiting for a sign-in (§app.tours/sites), by session id, from the server's memory.
    const signIns = tourSignInWaits();
    const rows: AttentionRow[] = sessions.map((s) => {
      const chat = chatHandle(s.path)?.mirror;
      const live = byPath.get(s.path);
      return {
        summary: s,
        dialogs: chat ? chat.dialogs.map((d) => d.title || d.method) : [],
        queued: chat ? chat.queue.web : 0,
        failedWorkers: live?.failed ?? 0,
        workerErrorAt: live?.failed ? workerErrorTime(live.failed, live.errorTimes, noteFailedRise(s.path, live.failed, nowMs)) : undefined,
        viewing: isViewing(s.id),
        activitySince: live?.since ?? 0,
        lastReplyAt: lastReplyAtOf(s.path),
        ...(s.signals || s.workerSignals ? { signalText: signalTextOf(s.id, nowMs) } : {}),
        ...(stallsOn ? teamStallField(s.id) : {}),
        ...(aliases[s.id] ? { alias: aliases[s.id] } : {}),
        ...(reviews.has(s.path) ? { playbook: reviews.get(s.path)! } : {}),
        ...(signIns.has(s.id) ? { tourSignIn: signIns.get(s.id)! } : {}),
        ...offerField(s),
        ...cardsField(s),
      };
    });
    // Items of no session: an org project's missing stakeholder, its held acts and conflicts routed to the operator
    // (the refit), and the one restart item of the whole server (§chat.worktrees/readiness), never one per session.
    // A deploy target whose latest deploy failed, and an overseer's request to deploy (§app.project-services/deploy-status).
    const deploys = await deployAttentionItems().catch(() => []);
    // WhatsApp sending down (§app.outreach/sender-health): from the sender's last reading, no round trip.
    return buildDigest(rows, Date.now(), homedir(), [...stakeholderAttention(), ...heldAttention(), ...notSentAttention(), ...senderAttention(), ...ownerAttention(), ...conflictAttention(), ...restartItems(sessions), ...deploys]);
  })();
  digestMemo = { at: now, value, ...(fed ? { list: fed } : {}) };
  value.catch(() => {
    if (digestMemo?.value === value) digestMemo = null;
  });
  return value;
}

/** The session's open offer card (§chat.offers/card) as a digest row's field: a Needs you item, idle or working. */
function offerField(s: SessionSummary): { offer?: { title: string; at: number } } {
  if (s.archived) return {};
  const o = openOfferOf(s.id);
  return o ? { offer: { title: o.title, at: Number.isFinite(o.at) ? o.at : 0 } } : {};
}

/** The session's open transcript cards (§chat.transcript-cards/answering) as a digest row's field: one Needs you item each. */
function cardsField(s: SessionSummary): { cards?: { title: string; at: number }[] } {
  if (s.archived) return {};
  const open = openCardsOf(s.id);
  return open.length ? { cards: open.map((c) => ({ title: c.title, at: c.at })) } : {};
}

function teamStallField(id: string): { teamStall?: { since: number; names: string[] } } {
  const stall = teamStallOf(id);
  return stall ? { teamStall: stall } : {};
}

/** The digest as the wire has it (no badge). */
export async function attentionForWire(list?: readonly SessionSummary[]): Promise<AttentionDigest> {
  const { badge: _badge, ...digest } = await attentionDigest(list);
  return digest;
}

/** What the session feed pushes after each comparison, from its own list (§app.decisions/push): the
    digest, and the Overseer's state once it has a conversation (the feed never creates one). */
export async function feedFrames(list: readonly SessionSummary[]): Promise<SessionFeedMessage[]> {
  const frames: SessionFeedMessage[] = [{ type: "attention", digest: await attentionForWire(list) }];
  if (readOverseerState()?.current) frames.push({ type: "overseer", info: await overseerInfo(list) });
  return frames;
}

/** What of a feed frame is compared: the digest's build time alone is no change. */
export function feedFrameKey(f: SessionFeedMessage): string {
  if (f.type !== "attention") return JSON.stringify(f);
  const { generatedAt: _at, ...rest } = f.digest;
  return JSON.stringify(rest);
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
  // The memory switch is its own route's: a settings save keeps the stored one, so a
  // stale copy of the settings never turns it back on or off.
  const { memory: _sent, ...rest } = parsed;
  const stored = readOverseerSettings().memory;
  writeOverseerSettings({ ...rest, ...(stored ? { memory: stored } : {}) });
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
  const chat = path ? chatHandle(path) : undefined;
  if (!chat) {
    pendingApply = false; // the next open syncs from the file (chat-manager syncOverseerModel)
    return;
  }
  if (chat.mirror.running) return;
  pendingApply = false;
  // A conversation that has written no model or thinking yet (nothing sent): reopen it rather than
  // switch it. A switch would first flush the open-time pi-default model/thinking entries and then
  // record the new model — three info rows before the first message. A reopen seeds the runtime
  // from overseer.json directly (chat-manager createRuntime), so the file only ever records the
  // chosen model, at the first prompt. Open tabs get "reloaded" and reconnect.
  const untouched = !(await chat.entries()).some(sentOrSet);
  if (untouched) {
    await closeChat(chat.path, "The Overseer's model changed; reopening it.");
    return;
  }
  const s = readOverseerSettings();
  const cur = chat.mirror.model?.ref ?? null;
  try {
    if (s.model && s.model !== cur) await chat.setModel(s.model);
    if (s.thinking && s.thinking !== chat.mirror.thinking) await chat.setThinking(s.thinking);
  } catch (err) {
    console.warn("[overseer] applying settings failed:", err instanceof Error ? err.message : String(err));
  }
}

// ---- the runtime loadout ---------------------------------------------------------------------------

/** Per-turn caps, shared by the tools and the chat's run events (a user message resets them). Kept
    in a file, so a restart mid-sequence doesn't renew the budget. */
const limits = new TurnLimits(overseerTurnFile());
/** The chat of the Overseer's current conversation, once opened. */
let overseerPath: string | null = null;
/**
 * Who started the turn the Overseer is in, as its chat tells (UserTurns, by the object the user's
 * message reaches the agent as): the caps' reset and the unattended read-only rule both read it, so
 * they can never disagree. A server-hosted tool reads it as its call carried it; anything else reads
 * the chat. Starts unattended (fail closed), so does a restart.
 */
function attended(): boolean {
  const run = serverToolCall();
  if (run && run.call.chatId === overseerPath) return run.call.attended;
  return (overseerPath ? chatHandle(overseerPath)?.mirror.attended : false) ?? false;
}
/** Whether the Overseer is answering the user right now. Exported for the tests. */
export const attendedForTest = () => attended();
/** The run of the Overseer's server-hosted tool this code runs inside, or undefined. */
function overseerRun(): ServerToolRun | undefined {
  const run = serverToolCall();
  return run && run.call.chatId === overseerPath ? run : undefined;
}

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
  // The overview reads (§app.overseer/list-overview, §app.overseer/roundup): the list's cached tail,
  // readiness's own readings with a bounded wait, the cleanup's ledger.
  ending: (path) => endingOf(path),
  readiness: { settle: settleReadiness, reading: readinessReading, covers: readinessCovers, parked: readinessParked },
  ledger: () => readLedger(),
  roundupGit: new RoundupGit(),
  serverStart: PROCESS_START_MS,
  held(path) {
    const chat = chatHandle(path)?.mirror;
    if (!chat) return null;
    return { streaming: chat.running, queued: chat.queue.web, dialogs: chat.dialogs };
  },
  answerDialog(path, dialogId, value, answer) {
    const chat = chatHandle(path);
    if (!chat) throw new Error("That session isn't open on this server, so it has no dialog waiting here.");
    return chat.answerDialog(dialogId, value, answer, host.overseerId());
  },
  open: async (path) => {
    await acquireChatHandle(path);
  },
  setModel: async (path, ref) => {
    const chat = await acquireChatHandle(path);
    await chat.setModel(ref);
  },
  setThinking: async (path, level) => (await acquireChatHandle(path)).setThinking(level),
  pinMode: async (path) => {
    if (!(await (await acquireChatHandle(path)).pinMode())) throw new Error("its mode entry could not be written");
  },
  sandbox: async (path) => (await acquireChatHandle(path)).sandboxInfo(),
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
  attended: () => attended(),
  confirmed: () => {
    const run = overseerRun();
    return confirmedItems(run ? run.call.card : null, run ? run.chat.branch() : []);
  },
  confirmedRows: () => {
    const run = overseerRun();
    return confirmedRows(run ? run.call.card : null, run ? run.chat.branch() : []);
  },
  // A land row's snapshot (§app.overseer/card-land): the session's readiness as listed, else read now.
  async readyToLand(s) {
    const r = s.readiness ?? (await (await import("./merge-readiness")).idleReadinessOf(s));
    return (r?.trees ?? []).flatMap((t) => (t.landing?.state === "ready" ? [{ branch: t.branch, head: t.landing.commit }] : []));
  },
  landAtCommit: async (input) => (await import("./overseer-land")).recordCardGoAhead(input),
  // The same click, per row with its chosen label: copies and leftover processes (§app.overseer/copies).
  confirmedClicks: () => {
    const run = overseerRun();
    return confirmedClicks(run ? run.call.card : null, run ? run.chat.branch() : [], (h) => joinedText(h, { images: false }));
  },
  // Approvals and rules (§app.overseer/approvals): read from the current runtime's file each call,
  // so a revoke applies from the next act on.
  permit(tool, sessions) {
    const run = overseerRun();
    if (!run) return null;
    const now = Date.now();
    const p = coveringPermit(foldPermits(run.chat.branch(), run.chat.entries(), now), tool, sessions, now);
    return p ? { id: p.id, label: permitLabel(p) } : null;
  },
  aliases: () => readAliases(),
  setAlias: (id, alias) => setAlias(id, alias),
  used(id, tool, sessions, toolCallId) {
    overseerRun()
      ?.chat.append(GRANT_USE, { v: 1, id, tool, sessions, toolCallId, at: new Date().toISOString() })
      .catch((err) => console.warn("[overseer] approval use not recorded:", err instanceof Error ? err.message : String(err)));
  },
  explorer: () => readOverseerSettings().explorer,
  explorerCwd: () => overseerDir(),
  subagent: (name) => {
    // The subagents extension's tools, called in-process within this tool's run (overseer-idea-tools.ts).
    const tool = overseerRun()?.chat.tool(name);
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
 * confirmedItems with the letter the click picked for each row (`pick`): a per-item Apply's own letter per row,
 * none for a card-level option click. What tells Go (the row's first choice, "a") from Not Yet on a land row
 * (§app.overseer/card-land). Null exactly when confirmedItems is. Pure over the branch.
 */
export function confirmedRows(card: string | null, branch: readonly HEntry[]): (SovaConfirmItem & { pick?: string })[] | null {
  if (!card) return null;
  let last = branch.length - 1;
  while (last >= 0 && branch[last]!.kind !== "user") last--;
  if (last < 0) return null;
  const c = cardsOnBranch(branch.slice(0, last)).find((x) => x.id === card);
  if (!c || c.phase !== "open") return null;
  const click = matchCardClick(c, joinedText(branch[last]!, { images: false }).trim());
  if (!click) return null;
  return clickItems(c, click).map(({ n, default: _d, decided: _x, ...item }) => ({ ...(item as SovaConfirmItem), ...("items" in click ? { pick: click.items[n] } : {}) }));
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
  const chat = chatHandle(path);
  if (chat) return { path, branch: await chat.branch(), all: await chat.entries() };
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
  const chat = await acquireChatHandle(e.path);
  await chat.appendState(REVOKE, { v: 1, id, at: new Date().toISOString(), by: "user" });
  return { ok: true };
}


/**
 * before_agent_start's hidden message in the global Overseer: the run note (§app.overseer/run-note:
 * the time now, the briefed blockers that cleared, open cards' sessions that merged or were
 * archived, the sessions in play, and with memory on the pointer to zoom), then the open cards
 * (§app.overseer/confirm). One message, so it stays the cards note
 * the attendance rule treats as state. A failure to read the sessions still sends the time and the cards.
 */
export async function runNoteMessage(branch: readonly HEntry[], now = new Date(), prompt: { changed?: string; opening?: OpeningDetails } = {}): Promise<{ message: { customType: string; content: string; display: false; details?: unknown } }> {
  const cardsText = cardsNote(cardsOnBranch(branch), false, sessionActivity());
  // The switch its recall tools follow (§chat.memory/overseer): zoom is named only while it has it.
  const memory = overseerMemoryOn();
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
      memory,
      ...prompt,
    });
  } catch (err) {
    console.warn("[overseer] run note without sessions:", err instanceof Error ? err.message : String(err));
    note = runNote({ now, branch: [], act: { keys: new Set(), complete: false }, session: () => null, ...(cardsText ? { cardsText } : {}), memory, ...prompt });
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
  return idNoteForText(assistantText(messages));
}
/** The same for a run's assistant text, as the chat sends it. */
export async function idNoteForText(text: string): Promise<{ customType: string; content: string; display: false; details: unknown } | null> {
  const note = await idCheckNote(text, {
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


/** The Overseer's memory switch in force (§chat.memory/overseer): on when never set. The one its
    recall tools follow (chat-manager's overseerMemoryNow), read for the prompt and the run note. */
export const overseerMemoryOn = (settings: OverseerSettings = readOverseerSettings()): boolean => overseerMemoryOf(settings.memory).on;

/** The prompt's id rule with memory on (§app.overseer/verify-first): zoom output is a source, and a
    search only for a session memory never names. Wording chosen by an A/B evaluation of recall. */
export const ID_RULE_MEMORY = `- **Ids are copied, never typed.** Take a session id verbatim from a tool's output in this turn,
  \`zoom\` included. Never type, shorten, complete or piece one together. A summary line's short id
  points to the message that has it whole: zoom down to it. Search with \`sova_list_sessions\` only
  when memory never names the session. A hidden \`[ids]\` note naming an id from your last reply as
  no session here means that link was wrong: correct it at the start of your next reply, with the
  id copied from a tool.`;

/** The prompt's id rule with memory off: no zoom to name, so a search when unsure. */
export const ID_RULE_PLAIN = `- **Ids are copied, never typed.** Take a session id verbatim from a tool's output in this turn
  (\`sova_list_sessions\`, \`sova_attention\`, \`sova_session\`). Never type, shorten or piece one
  together from memory; when unsure, \`sova_list_sessions\` with a query first. A hidden \`[ids]\`
  note naming an id from your last reply as no session here means that link was wrong: correct it
  at the start of your next reply, with the id copied from a tool.`;

/** The id rule's form for the memory switch in force. */
export const idRule = (settings: OverseerSettings): string => (overseerMemoryOn(settings) ? ID_RULE_MEMORY : ID_RULE_PLAIN);

/**
 * The values the Overseer's prompt is rendered from, as they are now: the time, the standing notes,
 * the ideas' table of contents, the todos' counts, the caps and `EXTRA` (the user's extra
 * instructions as their prompt part, redacted; empty when none) and `IDS`, the id rule's form for the
 * memory switch (§app.overseer/verify-first). A conversation keeps the values it
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
    IDS: idRule(settings),
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
    { key: "IDS", title: "Ids are copied, never typed", text: v("IDS") },
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
    .replaceAll("{{IDS}}", values.IDS ?? idRule(settings))
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
 * refilled in place at every run's start, and the chat has the session rebuild them when the text
 * changed (SpecialLoadoutResult.promptAtRunStart).
 */
class LivePrompt {
  /** The array the resource loader holds (the user's APPEND_SYSTEM.md parts, then ours). */
  readonly parts: string[] = [];
  private base: string[] = [];
  /** The conversation's opening values, once a run has read them from its branch or set them. */
  private opened?: Record<string, string>;
  /** The values when this runtime opened: a value the prompt gained after the conversation opened
      (its recorded opening lacks it) takes this one, so it stays fixed for the runtime too. */
  private atOpen?: Record<string, string>;
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
    if (recorded) return (this.opened = { ...(this.atOpen ??= overseerValues(readOverseerSettings(), this.openedAt)), ...recorded });
    if (this.opened) return this.opened;
    const now = overseerValues(readOverseerSettings(), this.openedAt);
    if (branch) this.opened = now;
    return now;
  }
  /** The Overseer's own parts as a run on `branch` has them (none of the user's): what the chat
      appends after the user's own (RunStartAnswer.append). */
  ours(branch?: readonly HEntry[]): string[] {
    this.refresh(branch);
    return this.parts.slice(this.base.length);
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
}

/** The approvals card clicks write, one after another. */
let approvalWrites: Promise<void> = Promise.resolve();

/** The Overseer's prompt as each of its chats opened it (a conversation's LivePrompt; a clear opens the next one). */
const prompts = new Map<string, LivePrompt>();
const promptOf = (path: string, tools = buildOverseerTools()): LivePrompt => {
  let p = prompts.get(path);
  if (!p) prompts.set(path, (p = new LivePrompt(tools, readFileSync(PROMPT_FILE, "utf8"), new Date())));
  return p;
};

/** The Overseer's file tools, served (§app.chat-processes/server-actions): read/grep/find/ls reach anywhere
    except secret files and the attached orgs' workspaces (overseer-deny.ts); write/edit the same, never
    Sova's or pi's own state, and only in a turn the user started. */
const overseerFileSpecs = () =>
  overseerFileTools(overseerDir(), () => new OverseerGuard(readIndex().orgs.map((o) => o.dir)), undefined, undefined, {
    protectedRoots: ownStateRoots,
    attended: () => attended(),
    unattended: UNATTENDED_WRITE_REFUSAL,
    log: (line) => logAction({ at: new Date().toISOString(), overseerId: readOverseerState()?.current ?? "", ...line }),
  }).map((def) => fromPiToolDefinition(def, def.prepareArguments ? "pi-edit" : undefined));

/** The tools' declarations of one open, served for this chat. */
const declsOf = (path: string, specs: ToolSpec[]): ServerToolDecl[] => {
  serveTools(path, specs);
  return specs.map(declOfTool);
};

registerSpecialHost({
  kind: "overseer",
  matches: (marks) => isOverseerFile(marks),
  async spec(path) {
    const st = readOverseerState();
    if (!st || idOf(path) !== st.current)
      throw new BusyError("This is a previous Overseer conversation. It is read-only; the eye button opens the current one.", "busy");
    const settings = readOverseerSettings();
    const tools = buildOverseerTools();
    // A new loadout: the prompt as this build opens it.
    prompts.delete(path);
    const prompt = promptOf(path, tools);
    const files = overseerFileSpecs();
    return {
      kind: "overseer",
      extension: "sova-overseer",
      cwd: null,
      tools: declsOf(path, tools),
      customTools: declsOf(path, files),
      allow: [...tools.map((t) => t.name), ...BUILTIN_ALLOWED, ...MEMORY_TOOLS],
      loader: { append: "user-then-ours" },
      model: settings.model,
      thinking: settings.thinking,
      // Its memory, when its own switch is on (§chat.memory/overseer): the same engine as a chat's.
      memory: true,
      // The user's message makes the run theirs (and the caps renew) when it enters the context.
      // Every run starts unattended, and a brief, a wake-up or an extension's message never does:
      // read-only, on the same budget.
      attribution: true,
      // Its model requests are background work under a provider's request limit (§app.provider-limits/queue).
      background: true,
      usage: "overseer",
      hooks: { compact: true, agentEnd: true },
      context: "redact",
      refuses: {},
      saveChoice: true,
      composerClosed: null,
      start: { prompt: {}, append: prompt.ours() },
    };
  },
  async adopt(path) {
    overseerPath = path;
    serveTools(path, [...buildOverseerTools(), ...overseerFileSpecs()]);
  },
  // A run started by a message: its prompt, with the notes and settings as they are now. The run
  // note (the time now, what cleared) and the open cards ride the prompt as a hidden message, never
  // the system prompt (a prompt change restarts a Claude Code CLI and breaks the cache): persisted,
  // so a restart or a fold keeps it.
  async runStart(path, ctx) {
    const prompt = promptOf(path);
    const branch = ctx.branch();
    const append = prompt.ours(branch);
    const now = new Date();
    const { message } = await runNoteMessage(branch, now, prompt.noteParts(branch, now));
    return { prompt: {}, append, message };
  },
  // A compaction summarizes the card results away: the exact open cards, once, after it. The
  // sessions in play go with them (§app.overseer/sessions-in-play), even with no card open.
  compact: async (_path, ctx) => (await compactNoteMessage(ctx.branch())) ?? null,
  // The id check (§app.overseer/id-check): a run that linked a session id this host has no file for
  // leaves a hidden note naming the nearest real id. Sent while the run still streams, so the SDK
  // appends it once the run's last message is in; the reply is never changed.
  agentEnd: (_path, text) => idNoteForText(text),
  saveChoice(_path, patch) {
    patchOverseerSettings(patch);
  },
  closed: (path) => void prompts.delete(path),
  opened: (chat) => {
    overseerPath = chat.path;
    return keepNormal(chat);
  },
  runEvent(path, event) {
    overseerPath = path;
    if (event.type === "user.entered") limits.reset();
    // A click that approves for later or adopts a rule: the server writes it, once the click's
    // message is in the file (the chat writes it right after this event).
    // One at a time, each reading what the one before wrote: a click told again (a chat process tells
    // the next server what the last may have heard) finds its approval written and writes none.
    if (event.type === "user.end") {
      const card = event.card;
      const write = () =>
        new Promise<void>((done) =>
          setImmediate(() => {
            const chat = chatHandle(path);
            if (!chat) return done();
            void Promise.all([chat.branch(), chat.entries()])
              .then(([branch, entries]) => {
                const w = permitOnClick(card, branch, entries);
                if (!w) return;
                return w.type === RULE_ENTRY ? chat.appendState(RULE, w.data) : chat.appendState(GRANT, w.data);
              })
              .catch((err) => console.warn("[overseer] approval not written:", err instanceof Error ? err.message : String(err)))
              .finally(() => done());
          }),
        );
      approvalWrites = approvalWrites.then(write);
    }
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

let feedHold: (() => void) | null = null;

async function tick(ignoreGap = false): Promise<{ briefed: string[] } | { error: string }> {
  await applySettingsNow();
  const settings = readOverseerSettings();
  const st = readOverseerState();
  // Phone notifications (server/push.ts) ride the same digest, with no Overseer needed and under
  // every proactivity. With nothing to send to, the digest is read only for a brief.
  const wanted = pushWanted();
  if (!wanted) resetPushState();
  // The loop holds the session feed while it reads the digest, so the digest comes from the feed's
  // change-driven list (§app.decisions/push) instead of a list built every tick.
  if ((st || wanted) && !feedHold) feedHold = sessionFeed()?.add(() => {}) ?? null;
  else if (!st && !wanted && feedHold) {
    feedHold();
    feedHold = null;
  }
  if (!st && !wanted) return { briefed: [] }; // no Overseer yet and no phone to tell: nothing to do
  const digest = await attentionDigest();
  const act = digest.items.filter((i) => i.tier === "act");
  if (wanted) await notifyBlockers(act, digest.badge.act);
  if (!st) return { briefed: [] }; // no Overseer yet: nothing to brief
  const path = await pathOfId(st.current);
  if (!path) return { briefed: [] };
  // The user looked at the Overseer since the last brief: the unattended run starts over.
  if ((readSeen()[st.current] ?? 0) > lastBriefAt || isViewing(st.current)) unattended = 0;
  const chat = chatHandle(path)?.mirror;
  const idle = !chat || (!chat.running && chat.queue.web === 0);
  // An option card waiting for the user is Needs you but never a brief (§app.overseer/attention-digest).
  const briefable = act.filter((i) => !NEVER_BRIEFED.has(i.kind));
  const counts = new Map(briefable.map((i) => [blockerKey(i), blockerCount(i)]));
  const d = briefDecision({ current: briefable.map(blockerKey), counts, announced, proactivity: settings.proactivity, now: Date.now(), lastBriefAt: ignoreGap ? 0 : lastBriefAt, unattended: ignoreGap ? 0 : unattended, overseerIdle: idle });
  const before = announced;
  announced = d.announced;
  if (!d.brief.length) return { briefed: [] };
  const text = briefText(briefable.filter((i) => d.brief.includes(blockerKey(i))));
  try {
    const overseer = await acquireChatHandle(path);
    // Keyed by what it briefs (§app.chat-processes/server-messages): sent again after a lost answer, one turn.
    await overseer.send({ text, origin: "server", checkModel: true, key: tickBriefKey(briefDigest(d.brief.map((k) => `${k}=${counts.get(k) ?? ""}`))) });
    pendingBrief = null;
    lastBriefAt = Date.now();
    unattended++;
    return { briefed: d.brief };
  } catch (err) {
    // Not sent: its blockers stay new, and the next check tries again (§app.overseer/proactivity).
    announced = before;
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[overseer] brief skipped:", error);
    return { error };
  }
}

/** A digest of what a brief says. */
const briefDigest = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);

/** The check's brief not yet known sent: its digest and key, kept so a retry of it (a lost answer, the
    next check after a failed send) is the same message, and a later brief of the same blockers (after
    BRIEF_REPEAT_MS) a new one, whatever the chat's key memory keeps. */
let pendingBrief: { digest: string; key: string } | null = null;
function tickBriefKey(digest: string, now = Date.now()): string {
  if (pendingBrief?.digest !== digest) pendingBrief = { digest, key: `brief:${digest}:${now}` };
  return pendingBrief.key;
}
/** For the tests: the key a check's brief of `digest` gets now, and marking it sent. */
export const briefKeyForTest = { key: (digest: string, now?: number) => tickBriefKey(digest, now), sent: () => void (pendingBrief = null) };

/** One brief to the Overseer under Brief Me (the auto-resume report); nothing under any other proactivity. */
async function sendBrief(body: string): Promise<void> {
  if (readOverseerSettings().proactivity !== "brief") return;
  const st = readOverseerState();
  const path = st ? await pathOfId(st.current) : null;
  if (!path) return;
  const overseer = await acquireChatHandle(path);
  const text = serverRedactor().redact(`${OVERSEER_BRIEF_PREFIX} ${body}`);
  // One send, one key: a lost answer's retry within the handle is the same message.
  await overseer.send({ text, origin: "server", checkModel: true, key: `brief:${briefDigest([text])}:${Date.now()}` });
  lastBriefAt = Date.now();
}

/** Test only (SOVA_CHAT_TEST_SERVED=1, server/chat-trial-routes.ts): one check now, the 10-minute gap
    and the unattended count ignored: the blocker keys it briefed, or why the brief was not sent. */
export const tickNowForTest = (o: { ignoreGap?: boolean } = {}): Promise<{ briefed: string[] } | { error: string }> => tick(!!o.ignoreGap);

/** Free slots of the running-at-once cap, for a schedule's fire as for a resume (§chat.schedules/fire). */
export const freeRunSlots = (): number => readOverseerSettings().caps.concurrentSessions - countRunning(started, running, promptedAt);
/** A session a schedule started or woke counts toward that cap, as a resumed one does. */
export const countStarted = (path: string): void => host.started(path, true);
/** One brief to the Overseer under Brief Me, nothing otherwise (a schedule found, §chat.schedules/where-shown). */
export const briefOverseer = (body: string): Promise<void> => sendBrief(body);

/**
 * A chat in a process of its own died with a run in flight (§app.chat-processes/crash): resume it
 * once, a few seconds later (§app.overseer/auto-resume). Its next run is marked a
 * resume in the chat's own process (`before`), which the send then opens.
 */
export function resumeCrashedChat(path: string, since: number, before: (path: string) => Promise<void>, done?: () => void): void {
  const timer = setTimeout(() => {
    const deps = resumeDeps();
    void resumeInterrupted(new Map([[path, { since }]]), { ...deps, prompt: async (p, text, key) => (await before(p), deps.prompt(p, text, key)) })
      .catch((err) => console.warn("[auto-resume] failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => done?.());
  }, RESUME_DELAY_MS);
  timer.unref();
}

function resumeDeps(): ResumeDeps {
  const settings = readOverseerSettings();
  return {
    enabled: settings.autoResume !== false,
    session: async (path) => {
      const s = await getSessionSummary(path);
      if (!s) return null;
      return { ...s, name: sessionName(s, readAliases()[s.id]), projectOverseer: !!projectOverseerOfPath(path) };
    },
    freeSlots: () => readOverseerSettings().caps.concurrentSessions - countRunning(started, running, promptedAt),
    prompt: async (path, text, key) => {
      const r = await promptSession(path, text, readOverseerState()?.current, "followUp", undefined, key);
      if (!r.ok) throw new Error(r.error);
      host.started(path, true);
    },
    log: (path, outcome, why) =>
      logAction({ at: new Date().toISOString(), overseerId: readOverseerState()?.current ?? "", toolCallId: "", tool: "auto_resume", args: { path }, outcome, ...(why ? { error: why } : {}) }),
    brief: sendBrief,
  };
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

