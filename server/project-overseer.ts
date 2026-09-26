import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { OPERATOR, type BatonSession } from "../shared/baton";
import {
  AUTONOMY_MEANING,
  type ProjectOverseerSettings,
  PROJECT_OVERSEER_ENTRY,
  type ItemCodeInput,
  type ItemCodeResult,
  type ItemSendInput,
  type ItemSendResult,
  type ProjectOverseerInfo,
  type ProjectOverseerMarkerData,
  type StartedSession,
} from "../shared/project-overseer";
import type { SessionSummary } from "../shared/protocol";
import { onBatonEvent } from "./baton-events";
import { allBatons, batonById, createBaton, nameOf, sessionPathOf, workspaceHasFile } from "./baton";
import { acquireChat, BusyError, disposeHeldChat, drainQueueThenAbort, heldChat, isSessionBusy, registerSpecialLoadout } from "./chat-manager";
import { workingSubagents } from "./live";
import { piUsageTally } from "./transcript-usage";
import { decidePerson, onOrgAttached, orgDir, orgOfSessionPath, overseerPausedSince, resumeOverseer, OrgError, participantLine, readIndex, readOrg, readProjects, readRoster, operatorName } from "./orgs";
import { appRequest, pathOfId, promptSession, toolCatalogue } from "./overseer";
import { overseerFileTools } from "./overseer-file-tools";
import { getIdea, promptToc, readManifest, readProse, updateIdea } from "./overseer-ideas";
import { redactExtensionMessages, serverRedactor } from "./overseer-redact";
import { readNotes, rotateState } from "./overseer-store";
import { promptTodos, readTodos, updateTodo } from "./overseer-todos";
import { UserTurns } from "./overseer-tools";
import { canonicalPath } from "./paths";
import { listDecisions, onReconcileEvent, promoteDecisions, reconcileProject } from "./reconcile";
import { isViewing, markSeen, readSeen } from "./seen";
import { cleanSessionTitle, readSessionTitles, setSessionTitle } from "./session-titles";
import { cleanupSessions, getSessionSummary, indexedSessionPaths, listSessions } from "./sessions-index";
import { setArchived } from "./archived-sessions";
import { readView } from "./share/hub";
import { normalizeEntries, readActiveBranch } from "./transcript";
import { loadDefaults } from "./web-defaults";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";
import {
  dayKey,
  effectiveAutonomy,
  isPoId,
  noteStarted,
  patchPoSettings,
  projectOf,
  projectOverseerOfPath,
  projectOverseerPaths,
  readMemo,
  readPoSettings,
  readStarted,
  recordTokens,
  readPoState,
  sessionIdOfFile,
  writeMemo,
  writePoSettings,
  writePoState,
  type ProjectOverseerPaths,
} from "./project-overseer-store";
import { PO_BUILTINS, PoLimits, projectOverseerTools, type PoToolHost } from "./project-overseer-tools";

/**
 * The project overseer (§app/project-overseer): one special session per org project. Like the
 * Overseer (server/overseer.ts) it is an ordinary webapp-owned pi session with a marker, a runtime
 * loadout and an identity that is not the file (its project's state.json points at the current
 * conversation; a clear rotates it). Unlike it: its file lives in the org's workspace repo
 * (`<workspace>/sessions/`), its cwd is the project root, it loads no pi-config extension, and
 * what it may do in a run the operator did not start is set per project (autonomy L0–L3, enforced
 * in its tools' wrapper, server/project-overseer-tools.ts). The Overseer's module state is not
 * touched: each project has its own turns, counters and files.
 */

const PROMPT_FILE = join(import.meta.dirname, "project-overseer-prompt.md");

// ---- per-project runtime state ------------------------------------------------------------------

interface Rt {
  orgId: string;
  projectId: string;
  turns: UserTurns;
  limits: PoLimits;
  session: AgentSession | null;
}
const rts = new Map<string, Rt>();
const keyOf = (orgId: string, projectId: string) => `${orgId}/${projectId}`;

function rtOf(orgId: string, projectId: string): Rt {
  const k = keyOf(orgId, projectId);
  let rt = rts.get(k);
  if (!rt) {
    const p = projectOverseerPaths(orgId, projectId);
    rt = { orgId, projectId, turns: new UserTurns(), limits: new PoLimits(p.turn), session: null };
    rts.set(k, rt);
  }
  return rt;
}

// ---- files -----------------------------------------------------------------------------------------

/** A new, empty conversation: header + marker, written now, in the org's workspace sessions dir, cwd = the project root. */
function createPoFile(orgId: string, projectId: string): { id: string; path: string } {
  const dir = orgDir(orgId);
  const project = projectOf(orgId, projectId);
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sm = SessionManager.create(project.root, sessionsDir);
  const raw = sm.getSessionFile();
  const header = sm.getHeader();
  if (!raw || !header) throw new Error("SessionManager did not produce a session file");
  sm.appendCustomEntry(PROJECT_OVERSEER_ENTRY, { v: 1, orgId, projectId } satisfies ProjectOverseerMarkerData);
  writeFileSync(raw, `${[JSON.stringify(header), ...sm.getEntries().map((e) => JSON.stringify(e))].join("\n")}\n`, { flag: "wx" });
  const path = canonicalPath(raw);
  markOwned(path);
  addWebSession(header.id);
  markSeen(header.id);
  setSessionTitle(header.id, cleanSessionTitle(`Overseer · ${project.name}`) ?? null);
  return { id: header.id, path };
}

/**
 * An attach (a restored clone): the overseer conversations' listing title, web origin and write-guard
 * stat are host-local, so they are derived again from each project's state.json (a title the
 * operator already gave one here stays). Its level is paused by the attach itself (server/orgs.ts).
 */
onOrgAttached((orgId, dir) => {
  const sessionsDir = join(dir, "sessions");
  const files = new Map<string, string>();
  for (const f of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) if (f.endsWith(".jsonl")) files.set(sessionIdOfFile(f), canonicalPath(join(sessionsDir, f)));
  const titles = readSessionTitles();
  for (const pr of readProjects(orgId)) {
    const st = readPoState(projectOverseerPaths(orgId, pr.id, dir));
    for (const id of st ? [st.current, ...st.history] : []) {
      const path = files.get(id);
      if (!path) continue;
      addWebSession(id);
      markOwned(path);
      if (!titles[id]) setSessionTitle(id, cleanSessionTitle(`Overseer · ${pr.name}`) ?? null);
    }
  }
});

/** Delete conversations that fell off the history (>20), through the cleanup "paths" mode. */
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

const ensuring = new Map<string, Promise<{ id: string; path: string }>>();

/** The current conversation, created when there is none (or its file is gone). Single-flight per project. */
export function ensureProjectOverseer(orgId: string, projectId: string): Promise<{ id: string; path: string }> {
  const k = keyOf(orgId, projectId);
  let run = ensuring.get(k);
  if (run) return run;
  run = (async () => {
    projectOf(orgId, projectId);
    const p = projectOverseerPaths(orgId, projectId);
    const st = readPoState(p);
    if (st) {
      const path = await pathOfId(st.current);
      if (path && projectOverseerOfPath(path)) return { id: st.current, path };
    }
    const made = createPoFile(orgId, projectId);
    const { state, dropped } = rotateState(st, made.id);
    writePoState(p, state);
    // The settings file exists from the first open on, so the repo shows what is in force.
    writePoSettings(p, readPoSettings(p));
    await dropHistory(dropped);
    return made;
  })().finally(() => ensuring.delete(k));
  ensuring.set(k, run);
  return run;
}

/** A new conversation; settings, notes, ideas and to-dos stay. Never refuses. */
export async function clearProjectOverseer(orgId: string, projectId: string): Promise<ProjectOverseerInfo> {
  const p = projectOverseerPaths(orgId, projectId);
  const st = readPoState(p);
  const oldPath = st ? await pathOfId(st.current) : null;
  if (oldPath) {
    const chat = heldChat(oldPath);
    if (chat?.session.isStreaming) await drainQueueThenAbort(chat.session, (m) => chat.broadcast(m), chat.queue).catch(() => {});
    await disposeHeldChat(oldPath, "The project overseer was cleared. Opening the new conversation.");
  }
  const rt = rtOf(orgId, projectId);
  rt.limits.reset();
  rt.turns.reset();
  const made = createPoFile(orgId, projectId);
  const { state, dropped } = rotateState(readPoState(p), made.id);
  writePoState(p, state);
  await dropHistory(dropped);
  return projectOverseerInfo(orgId, projectId);
}

// ---- info ------------------------------------------------------------------------------------------

async function unreadReplies(path: string, since: number | undefined): Promise<number> {
  if (since === undefined) return 0;
  let count = 0;
  for (const e of await readActiveBranch(path).catch(() => [])) {
    const m = e.type === "message" ? e.message : null;
    if (m?.role !== "assistant" || m.stopReason === "toolUse") continue;
    const t = typeof m.timestamp === "number" ? m.timestamp : Date.parse(e.timestamp ?? "");
    if (Number.isFinite(t) && t > since) count++;
  }
  return count;
}

/** A baton's file on this host (the registry knows it; the listing cache may not yet). */
function batonPath(b: BatonSession): string | null {
  const hit = batonById(b.sessionId);
  return hit && workspaceHasFile(hit.dir, hit.row) ? sessionPathOf(hit.dir, hit.row) : null;
}

const projectBatons = (orgId: string, projectId: string): BatonSession[] => allBatons().filter((b) => b.orgId === orgId && b.projectId === projectId);
const ownedBy = (b: BatonSession, projectId: string) => typeof b.owner === "object" && b.owner.overseerOf === projectId;

function codingOf(p: ProjectOverseerPaths): { sessionId: string; path: string | null; running: boolean; createdAt: string; tokens?: number }[] {
  const known = indexedSessionPaths();
  return readStarted(p)
    .filter((s) => s.kind === "coding")
    .map((s) => {
      const path = known.get(s.sessionId) ?? (s.path && existsSync(s.path) ? s.path : null);
      return { sessionId: s.sessionId, path, running: path ? isSessionBusy(path) || workingSubagents(path) > 0 : false, createdAt: s.createdAt, tokens: s.tokens };
    });
}

const tokenMemo = new Map<string, { at: number; value: number }>();
async function codingTokens(p: ProjectOverseerPaths): Promise<number> {
  const k = keyOf(p.orgId, p.projectId);
  const hit = tokenMemo.get(k);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  let total = 0;
  const counted = new Map<string, number>();
  for (const c of codingOf(p)) {
    // Not on this host (the org moved): what it had spent when last counted, from started.json.
    if (!c.path) {
      total += c.tokens ?? 0;
      continue;
    }
    // From the file (every assistant message's usage, deduplicated), not a live record: a
    // session that is not running still counts what it spent.
    const text = await readFile(c.path, "utf8").catch(() => "");
    const u = piUsageTally()(text, "snapshot");
    const spent = u.input + u.output + u.cacheRead + u.cacheWrite;
    counted.set(c.sessionId, spent);
    total += spent;
  }
  // Kept in the repo, so the budget still counts these on a host without the files.
  if (counted.size) recordTokens(p, counted);
  tokenMemo.set(k, { at: Date.now(), value: total });
  return total;
}

export async function projectOverseerInfo(orgId: string, projectId: string): Promise<ProjectOverseerInfo> {
  const project = projectOf(orgId, projectId);
  const p = projectOverseerPaths(orgId, projectId);
  const settings = readPoSettings(p);
  const st = readPoState(p);
  const path = st ? await pathOfId(st.current) : null;
  const exists = !!(st && path && projectOverseerOfPath(path));
  const history: ProjectOverseerInfo["history"] = [];
  for (const id of st?.history ?? []) {
    const hp = await pathOfId(id);
    if (!hp) continue;
    const s = await getSessionSummary(hp);
    if (s) history.push({ id, path: hp, title: s.title, lastActiveAt: s.lastActiveAt });
  }
  const memo = readMemo(p);
  const known = indexedSessionPaths();
  const started: StartedSession[] = [
    ...projectBatons(orgId, projectId)
      .filter((b) => ownedBy(b, projectId))
      .map((b) => ({
        sessionId: b.sessionId,
        path: batonPath(b),
        title: b.publicTitle,
        kind: (b.offers?.length ? "offer" : "gathering") as StartedSession["kind"],
        state: b.state,
        createdAt: b.createdAt,
      })),
    ...codingOf(p).map((c) => ({ sessionId: c.sessionId, path: c.path, title: c.path ? "" : "(not on this host)", kind: "coding" as const, state: c.running ? "working" : "idle", createdAt: c.createdAt })),
  ];
  for (const s of started) if (s.kind === "coding" && s.path) s.title = (await getSessionSummary(s.path).catch(() => null))?.title ?? "";
  started.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    orgId,
    projectId,
    projectName: project.name,
    exists,
    path: exists ? path : null,
    id: exists ? st!.current : null,
    history,
    settings,
    effective: effectiveAutonomy(settings, readRoster(orgId), overseerPausedSince(orgId, projectId)),
    paused: overseerPausedSince(orgId, projectId),
    busy: exists && path ? isSessionBusy(path) : false,
    lastRun: memo.lastRun,
    started,
    unread: exists && path && !isViewing(st!.current) ? await unreadReplies(path, readSeen()[st!.current]) : 0,
    usage: { codingTokens: await codingTokens(p), tokenBudget: settings.tokenBudget, unattendedToday: memo.perDay[dayKey()] ?? 0, lastWatchAt: memo.lastRunAt, pending: memo.pending },
  };
}

/** PATCH …/overseer: settings, then the held idle runtime brought to the model/thinking. */
export async function patchProjectOverseer(orgId: string, projectId: string, body: unknown): Promise<ProjectOverseerInfo> {
  projectOf(orgId, projectId);
  const p = projectOverseerPaths(orgId, projectId);
  const s = patchPoSettings(p, body);
  // Setting the level on this host (any level, the same one too) ends the pause an attach put on it.
  if ((body as { autonomy?: unknown }).autonomy !== undefined) resumeOverseer(orgId, projectId);
  const st = readPoState(p);
  const path = st ? await pathOfId(st.current) : null;
  const chat = path ? heldChat(path) : undefined;
  if (chat && !chat.session.isStreaming) {
    const cur = chat.session.model ? `${chat.session.model.provider}/${chat.session.model.id}` : null;
    try {
      if (s.model && s.model !== cur) await chat.setModelRef(s.model);
      if (s.thinking && s.thinking !== chat.session.thinkingLevel) chat.setThinking(s.thinking);
    } catch (err) {
      throw new OrgError(err instanceof Error ? err.message : String(err));
    }
  }
  return projectOverseerInfo(orgId, projectId);
}

// ---- the prompt ------------------------------------------------------------------------------------

export function renderProjectOverseerPrompt(orgId: string, projectId: string, tools: { name: string; promptSnippet?: string; description: string }[], template = readFileSync(PROMPT_FILE, "utf8"), now = new Date()): string {
  const p = projectOverseerPaths(orgId, projectId);
  const project = projectOf(orgId, projectId);
  const settings = readPoSettings(p);
  const roster = readRoster(orgId);
  const eff = effectiveAutonomy(settings, roster, overseerPausedSince(orgId, projectId));
  const r = serverRedactor();
  const notes = readNotes(p.notes).trim();
  const c = settings.caps;
  const active = roster.filter((x) => x.status === "active");
  const values: Record<string, string> = {
    PROJECT: project.name,
    ORG: readOrg(orgId).name,
    OPERATOR: operatorName(),
    AUTONOMY: `${eff.autonomy} — ${AUTONOMY_MEANING[eff.autonomy]}`,
    AUTONOMY_REASON: eff.reason ? ` (${eff.reason})` : "",
    CAPS: `per operator message ${c.gatherPerTurn} gathering sessions, ${c.promotePerTurn} promotions, ${c.createPerTurn} coding sessions, ${c.promptsPerTurn} prompts to them; at once ${c.gatheringsOpen} open gatherings, ${c.codingRunning} coding sessions running; ${settings.tokenBudget} coding tokens in total`,
    ROOT: project.root,
    ROSTER: active.length ? active.map(participantLine).join("\n") : "(nobody yet: ask the operator to add people)",
    IDEAS: r.redact(promptToc(readManifest(p.ideas), readPoState(p)?.current ?? "")),
    TODOS: promptTodos(readTodos(p.todos)),
    NOTES: notes ? r.redact(notes.slice(0, 4000)) : "(none yet)",
    TOOLS: toolCatalogue(tools),
    NOW: now.toString(),
  };
  const extra = settings.extraSystemPrompt.trim();
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => values[k] ?? "") + (extra ? `\n\n# The operator's extra instructions\n\n${r.redact(extra)}` : "");
}

// ---- the tools' host --------------------------------------------------------------------------------

function toolHost(rt: Rt): PoToolHost {
  const { orgId, projectId } = rt;
  const paths = projectOverseerPaths(orgId, projectId);
  const settings = () => readPoSettings(paths);
  return {
    paths,
    project: () => projectOf(orgId, projectId),
    settings,
    roster: () => readRoster(orgId),
    effective: () => effectiveAutonomy(settings(), readRoster(orgId), overseerPausedSince(orgId, projectId)),
    attended: () => rt.turns.attended(),
    overseerId: () => readPoState(paths)?.current ?? "",
    batons: () => projectBatons(orgId, projectId),
    async batonView(sessionId) {
      const hit = batonById(sessionId);
      return hit ? readView(hit.row, hit.dir) : null;
    },
    decisions: async () => listDecisions(orgId, projectId),
    reconcile: () => reconcileProject(orgId, projectId, { owner: { overseerOf: projectId } }),
    // Never an out-of-area decision (the author does not own the area): refused here, in any turn; only the operator promotes one, explicitly.
    promote: (ids) => promoteDecisions(orgId, projectId, ids, { by: "overseer" }),
    async startGathering(input) {
      // No link minted: no one would see it (and the model must never see a token), so Needs you
      // asks the operator to send one (Get Link mints it).
      const made = createBaton({
        orgId,
        projectId,
        to: input.to,
        publicTitle: input.publicTitle,
        goal: input.goal,
        question: input.question,
        ...(await gatheringChoice(orgId, projectId, input)),
        owner: { overseerOf: projectId },
        mintLink: false,
      });
      const to = Array.isArray(input.to) ? input.to : [input.to];
      noteStarted(paths, made.sessionId, to.length > 1 ? "offer" : "gathering");
      return { sessionId: made.sessionId, path: made.path, invited: to.map((ref) => nameOf(orgId, ref)) };
    },
    decideReferral: async (personId, approve) => decidePerson(orgId, personId, approve, { kind: "overseer", sessionId: readPoState(paths)?.current ?? "" }),
    sessions: () => listSessions(),
    transcript: async (path) => normalizeEntries(await readActiveBranch(path)),
    async createCoding(input) {
      const made = await startCodingSession(orgId, projectId, input);
      noteStarted(paths, made.sessionId, "coding", new Date(), made.path);
      return { id: made.sessionId, path: made.path };
    },
    async send(path, text) {
      const r = await promptSession(path, text);
      if (!r.ok) throw new Error(r.error);
      return { queued: r.queued };
    },
    coding: () => codingOf(paths),
    codingTokens: () => codingTokens(paths),
  };
}

/**
 * The model and thinking a session it starts gets (`kind`: a coding session, or a gathering
 * session / offer, whose model is the one the person talks to): what the call names, else the
 * project's `codingModel`/`gatheringModel` (and thinking), else the overseer's own (its setting,
 * else what its runtime runs), and only then the new-session default. Pure, for the tests.
 */
export function sessionChoice(
  kind: "coding" | "gathering",
  input: { model?: string; thinking?: string },
  settings: Pick<ProjectOverseerSettings, "model" | "thinking" | "codingModel" | "codingThinking" | "gatheringModel" | "gatheringThinking">,
  running: { model: string | null; thinking: string | null },
): { model: string | null; thinking: string | null } {
  const own = kind === "coding" ? { model: settings.codingModel, thinking: settings.codingThinking } : { model: settings.gatheringModel, thinking: settings.gatheringThinking };
  return {
    model: input.model?.trim() || own.model || settings.model || running.model || loadDefaults().model || null,
    thinking: input.thinking?.trim() || own.thinking || settings.thinking || running.thinking || loadDefaults().thinking || null,
  };
}
export const codingChoice = (input: { model?: string; thinking?: string }, settings: Parameters<typeof sessionChoice>[2], running: Parameters<typeof sessionChoice>[3]) =>
  sessionChoice("coding", input, settings, running);

/** A gathering session's model and thinking, as createBaton takes them. */
async function gatheringChoice(orgId: string, projectId: string, input: { model?: string; thinking?: string }): Promise<{ model?: string; thinking?: string }> {
  const c = sessionChoice("gathering", input, readPoSettings(projectOverseerPaths(orgId, projectId)), await overseerRunning(orgId, projectId));
  return { ...(c.model ? { model: c.model } : {}), ...(c.thinking ? { thinking: c.thinking } : {}) };
}

/** The model and thinking the project's overseer runtime has now (held), else nulls. */
async function overseerRunning(orgId: string, projectId: string): Promise<{ model: string | null; thinking: string | null }> {
  const st = readPoState(projectOverseerPaths(orgId, projectId));
  const path = st ? await pathOfId(st.current) : null;
  const chat = path ? heldChat(path) : undefined;
  const m = chat?.session.model;
  return { model: m ? `${m.provider}/${m.id}` : null, thinking: chat?.session.thinkingLevel ?? null };
}

/** A new ordinary session in `cwd` (the project root or inside it) through the same route the
    browser uses, titled, with model/thinking, and its first prompt sent. */
async function startCodingSession(orgId: string, projectId: string, input: { cwd?: string; prompt: string; title?: string; model?: string; thinking?: string }): Promise<{ sessionId: string; path: string }> {
  const project = projectOf(orgId, projectId);
  const cwd = input.cwd ?? project.root;
  const res = await appRequest("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const json = (await res.json().catch(() => null)) as (SessionSummary & { error?: string }) | null;
  if (res.status !== 201 || !json?.path) throw new OrgError(json?.error ?? `Creating the session failed (HTTP ${res.status}).`, res.status === 409 ? 409 : 400);
  if (input.title?.trim()) setSessionTitle(json.id, cleanSessionTitle(input.title) ?? null);
  const choice = codingChoice(input, readPoSettings(projectOverseerPaths(orgId, projectId)), await overseerRunning(orgId, projectId));
  if (choice.model) await (await acquireChat(json.path)).setModelRef(choice.model);
  if (choice.thinking) (await acquireChat(json.path)).setThinking(choice.thinking);
  const sent = await promptSession(json.path, input.prompt);
  if (!sent.ok) throw new OrgError(sent.error, 409);
  return { sessionId: json.id, path: json.path };
}

// ---- the runtime loadout ------------------------------------------------------------------------------

function markerOf(sm: { getEntries(): readonly any[] }): ProjectOverseerMarkerData | null {
  const e = sm.getEntries().find((x) => x.type === "custom" && x.customType === PROJECT_OVERSEER_ENTRY);
  const d = e?.data;
  return d && typeof d.orgId === "string" && typeof d.projectId === "string" ? { v: 1, orgId: d.orgId, projectId: d.projectId } : null;
}

/** The runtime whose file this is (the loadout's lookups), or a refusal. */
function rtOfPath(path: string): Rt {
  const po = projectOverseerOfPath(path);
  if (!po) throw new Error("Not a project overseer's conversation.");
  return rtOf(po.orgId, po.projectId);
}

registerSpecialLoadout({
  kind: "project-overseer",
  // The project's root on THIS host, not the one the file's header recorded where it was created.
  cwd(path) {
    const po = orgOfSessionPath(path) ? projectOverseerOfPath(path) : null;
    if (!po) return null;
    try {
      return projectOf(po.orgId, po.projectId).root;
    } catch {
      return null;
    }
  },
  // The marker, in THAT org's workspace, AND a conversation the project's state knows: a fork or a
  // copy elsewhere opens as an ordinary session.
  matches(sm, path) {
    const m = markerOf(sm);
    if (!m) return false;
    try {
      const org = readIndex().orgs.find((o) => o.id === m.orgId);
      if (!org) return false;
      if (!projectOverseerOfPath(path, sm.getSessionId())) return false;
      return isPoId(projectOverseerPaths(m.orgId, m.projectId), sm.getSessionId());
    } catch {
      return false;
    }
  },
  async loadout(path) {
    const rt = rtOfPath(path);
    const p = projectOverseerPaths(rt.orgId, rt.projectId);
    if (readPoState(p)?.current !== sessionIdOfFile(path))
      throw new BusyError("This is a previous conversation of the project overseer. It is read-only; open the current one from the project page.", "busy");
    const project = projectOf(rt.orgId, rt.projectId);
    const tools = projectOverseerTools(toolHost(rt), rt.limits);
    const template = readFileSync(PROMPT_FILE, "utf8");
    const settings = readPoSettings(p);
    const defaults = loadDefaults();
    return {
      resourceLoaderOptions: {
        // None of the operator's pi-config extensions, skills or templates: no mode, no subagents,
        // no input rewriting. The project's own context files (AGENTS.md) stay.
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        appendSystemPromptOverride: () => [],
        extensionFactories: [
          {
            name: "sova-project-overseer",
            factory: (pi) => {
              for (const t of tools) pi.registerTool(t);
              pi.on("before_agent_start", (event) => {
                event.systemPromptOptions.appendSystemPrompt = renderProjectOverseerPrompt(rt.orgId, rt.projectId, tools, template);
              });
              pi.on("context", (event) => {
                const messages = redactExtensionMessages(event.messages, serverRedactor());
                return messages === event.messages ? undefined : { messages };
              });
            },
          },
        ],
      },
      tools: [...tools.map((t) => t.name), ...PO_BUILTINS],
      // read/grep/find/ls in the project, never a secret file (overseer-deny.ts).
      customTools: overseerFileTools(project.root),
      model: settings.model ?? defaults.model ?? null,
      thinking: settings.thinking ?? defaults.thinking ?? null,
    };
  },
  watchSession(session, path) {
    const rt = rtOfPath(path);
    rt.session = session;
    rt.turns.watch(session.agent);
    session.subscribe((event) => {
      if (rt.turns.observe(event)) rt.limits.reset();
    });
  },
  userSend(path, send) {
    return rtOfPath(path).turns.send(send);
  },
  saveChoice(path, patch) {
    const rt = rtOfPath(path);
    const p = projectOverseerPaths(rt.orgId, rt.projectId);
    writePoSettings(p, { ...readPoSettings(p), ...(patch.model ? { model: patch.model } : {}), ...(patch.thinking ? { thinking: patch.thinking } : {}) });
  },
  refuses(gesture) {
    return gesture === "mode" ? "The project overseer has no modes." : null;
  },
});

/** The project's tools as its runtime builds them, for the tests. */
export const toolsForTest = (orgId: string, projectId: string) => {
  const rt = rtOf(orgId, projectId);
  return projectOverseerTools(toolHost(rt), rt.limits);
};

/** Whether the project's overseer is answering the operator right now (tests). */
export const attendedForTest = (orgId: string, projectId: string) => rtOf(orgId, projectId).turns.attended();

// ---- idea / to-do items → people and sessions ------------------------------------------------------------

function itemOf(p: ProjectOverseerPaths, input: { todoId?: unknown; ideaId?: unknown }): { kind: "todo" | "idea"; id: string; title: string; text: string } {
  if (typeof input.todoId === "string" && input.todoId) {
    const t = readTodos(p.todos).todos.find((x) => x.id === input.todoId);
    if (!t) throw new OrgError("Unknown to-do item", 404);
    const idea = t.ideaId ? getIdea(t.ideaId, p.ideas) : null;
    return { kind: "todo", id: t.id, title: t.text, text: idea ? `${t.text}\n\n${idea.title}` : t.text };
  }
  if (typeof input.ideaId === "string" && input.ideaId) {
    const idea = getIdea(input.ideaId, p.ideas);
    if (!idea) throw new OrgError("Unknown idea", 404);
    const prose = readProse(idea.id, p.ideas);
    return { kind: "idea", id: idea.id, title: idea.title, text: prose.trim() ? `${idea.title}\n\n${prose.trim()}` : idea.title };
  }
  throw new OrgError("Give todoId or ideaId");
}

function linkItem(p: ProjectOverseerPaths, item: { kind: "todo" | "idea"; id: string }, sessionId: string): void {
  if (item.kind === "todo") updateTodo(item.id, { sessionId }, p.todos);
  else updateIdea(item.id, { sessionId }, p.ideas);
}

/** Send to person…: a gathering session owned by the operator, prefilled from the item, linked to it. */
export async function sendItem(orgId: string, projectId: string, body: ItemSendInput, linkUrl: (token: string) => string): Promise<ItemSendResult> {
  const p = projectOverseerPaths(orgId, projectId);
  const item = itemOf(p, body);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  // The title and first question are shown to the person verbatim: never derived from the item,
  // whose text is the operator's own (internal labels, gap ids, notes about people).
  const publicTitle = typeof body.publicTitle === "string" ? body.publicTitle.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!publicTitle || !question) throw new OrgError("publicTitle and question are required: both are shown to the person as written.");
  const made = createBaton({
    orgId,
    projectId,
    to: body.to,
    publicTitle,
    goal: body.goal?.trim() || clip(item.text, 2000),
    question,
    ...(await gatheringChoice(orgId, projectId, { ...(typeof body.model === "string" ? { model: body.model } : {}), ...(typeof body.thinking === "string" ? { thinking: body.thinking } : {}) })),
  });
  linkItem(p, item, made.sessionId);
  const links = made.links ?? (made.token && typeof body.to === "string" && body.to !== OPERATOR ? [{ personId: body.to, token: made.token }] : []);
  return { path: made.path, sessionId: made.sessionId, links: links.map((l) => ({ personId: l.personId, name: nameOf(orgId, l.personId), link: linkUrl(l.token) })) };
}

/** Start coding session: an ordinary session in the project root with the item as its first prompt, linked to it. */
export async function codeItem(orgId: string, projectId: string, body: ItemCodeInput): Promise<ItemCodeResult> {
  const p = projectOverseerPaths(orgId, projectId);
  const item = itemOf(p, body);
  const made = await startCodingSession(orgId, projectId, {
    prompt: body.prompt?.trim() || item.text,
    title: item.title.slice(0, 80),
    ...(body.model ? { model: body.model } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
  });
  linkItem(p, item, made.sessionId);
  return made;
}

// ---- the watch loop ------------------------------------------------------------------------------------

export const WATCH_TICK_MS = 20_000;
export const WATCH_MIN_GAP_MS = 10 * 60_000;
export const WATCH_PREFIX = "[project watch]";

/** Whether to start an unattended look now. Pure, for the tests. */
export function watchDecision(input: {
  pending: string[];
  watch: boolean;
  exists: boolean;
  idle: boolean;
  now: number;
  lastRunAt: number;
  today: number;
  perDay: number;
  force?: boolean;
}): { run: boolean; why?: string } {
  if (!input.exists) return { run: false, why: "no conversation yet" };
  if (!input.idle) return { run: false, why: "busy" };
  if (!input.force) {
    if (!input.watch) return { run: false, why: "watching is off" };
    if (!input.pending.length) return { run: false, why: "nothing new" };
    if (input.now - input.lastRunAt < WATCH_MIN_GAP_MS) return { run: false, why: "too soon" };
  }
  if (input.today >= input.perDay) return { run: false, why: `the daily limit of ${input.perDay} unattended runs is reached` };
  return { run: true };
}

export function watchText(reasons: string[], autonomy: string): string {
  const list = reasons.length ? reasons.slice(-20).map((r) => `- ${r}`).join("\n") : "- (the operator asked for a look)";
  return (
    `${WATCH_PREFIX} Since your last look:\n${list}\n\n` +
    `Re-read the project (sova_project, and sova_decisions where it matters). Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). ` +
    `Then act within your autonomy (${autonomy}): the tools tell you when something needs a higher level. Keep your reply to a few lines for the operator.`
  );
}

/**
 * Note a reason to look (an event), for a project whose overseer exists. People's events (a
 * decision, a finished gathering, a referral) are always kept, a busy overseer included: the
 * next look after its run picks them up. `own`: the reconciler's events, which while it runs are
 * its own sova_reconcile/sova_promote acts, not news to it. (The gatherings it starts emit
 * hand-off/offer events, which are never reasons.)
 */
export function noteReason(orgId: string, projectId: string, reason: string, own = false): void {
  try {
    const p = projectOverseerPaths(orgId, projectId);
    if (!readPoState(p)) return;
    const rt = rts.get(keyOf(orgId, projectId));
    if (own && rt?.session?.isStreaming) return;
    const m = readMemo(p);
    if (!m.pending.includes(reason)) m.pending.push(reason);
    writeMemo(p, m);
  } catch {
    // an org detached meanwhile: nothing to note
  }
}

/** Start one unattended look now, when the rules allow (the ticker, Run Now). */
export async function lookNow(orgId: string, projectId: string, force = false): Promise<{ started: boolean; why?: string }> {
  const p = projectOverseerPaths(orgId, projectId);
  const settings = readPoSettings(p);
  const st = readPoState(p);
  const path = st ? await pathOfId(st.current) : null;
  const memo = readMemo(p);
  const chat = path ? heldChat(path) : undefined;
  const idle = !chat || (!chat.session.isStreaming && chat.queue.size === 0);
  const today = dayKey();
  const d = watchDecision({
    pending: memo.pending,
    watch: settings.watch,
    exists: !!path,
    idle,
    now: Date.now(),
    lastRunAt: memo.lastRunAt ? Date.parse(memo.lastRunAt) : 0,
    today: memo.perDay[today] ?? 0,
    perDay: settings.caps.unattendedPerDay,
    force,
  });
  if (!d.run) {
    // Only a refusal worth showing is recorded (not the ticker's everyday "nothing new").
    if (force || (memo.pending.length && d.why?.startsWith("the daily limit"))) {
      memo.lastRun = { at: new Date().toISOString(), reasons: memo.pending, outcome: "skipped", ...(d.why ? { detail: d.why } : {}) };
      writeMemo(p, memo);
    }
    return { started: false, ...(d.why ? { why: d.why } : {}) };
  }
  const eff = effectiveAutonomy(settings, readRoster(orgId), overseerPausedSince(orgId, projectId));
  const reasons = memo.pending;
  try {
    const po = await acquireChat(path!);
    po.assertModelAllowed();
    const { turn } = po.acceptPrompt(watchText(reasons, eff.autonomy), undefined, "server");
    void turn.catch((err) => po.reportTurnFailure(err));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    memo.lastRun = { at: new Date().toISOString(), reasons, outcome: "skipped", detail };
    writeMemo(p, memo);
    return { started: false, why: detail };
  }
  const now = new Date();
  writeMemo(p, { ...memo, pending: [], lastRunAt: now.toISOString(), lastRun: { at: now.toISOString(), reasons, outcome: "started" }, perDay: { ...memo.perDay, [today]: (memo.perDay[today] ?? 0) + 1 } });
  return { started: true };
}

async function tick(): Promise<void> {
  for (const o of readIndex().orgs) {
    let projects;
    try {
      projects = readProjects(o.id);
    } catch {
      continue;
    }
    for (const pr of projects) {
      try {
        const p = projectOverseerPaths(o.id, pr.id);
        // Paused by an attach: the watch loop waits (its reasons keep) until the operator sets its level here.
        if (overseerPausedSince(o.id, pr.id)) continue;
        if (!readPoState(p) || !readMemo(p).pending.length) continue;
        await lookNow(o.id, pr.id);
      } catch (err) {
        console.warn("[project-overseer] watch failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

const batonTitle = (sessionId: string) => batonById(sessionId)?.row.publicTitle ?? sessionId;

let started = false;
/** Start the listeners and the ticker (index.ts, once). */
export function startProjectOverseerLoop(): void {
  if (started) return;
  started = true;
  onBatonEvent((e) => {
    if (e.type === "decision") noteReason(e.orgId, e.projectId, `A decision was recorded in "${batonTitle(e.sessionId)}".`);
    else if (e.type === "done") noteReason(e.orgId, e.projectId, `The gathering session "${batonTitle(e.sessionId)}" reached its goal.`);
    else if (e.type === "closed") noteReason(e.orgId, e.projectId, `The gathering session "${batonTitle(e.sessionId)}" was closed.`);
    else if (e.type === "proposal") noteReason(e.orgId, e.projectId, `Someone was referred in "${batonTitle(e.sessionId)}" (a proposed roster person).`);
  });
  onReconcileEvent((e) => {
    const n = e.ids.length;
    if (e.type === "conflict") noteReason(e.orgId, e.projectId, `${n} new conflict${n === 1 ? "" : "s"} between decisions.`, true);
    else if (e.type === "resolved") noteReason(e.orgId, e.projectId, `${n} conflict${n === 1 ? " was" : "s were"} resolved.`, true);
    else if (e.type === "promoted") noteReason(e.orgId, e.projectId, `${n} decision${n === 1 ? " was" : "s were"} promoted into the spec.`, true);
    else if (e.type === "drafted") noteReason(e.orgId, e.projectId, `${n} decision${n === 1 ? " is" : "s are"} drafted and promotable.`, true);
  });
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => console.warn("[project-overseer] tick failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        ticking = false;
      });
  }, WATCH_TICK_MS);
  timer.unref();
}
