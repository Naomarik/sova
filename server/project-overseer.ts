import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { OPERATOR, type BatonSession } from "../shared/baton";
import {
  AUTONOMY_MEANING,
  type ProjectOverseerSettings,
  PROJECT_OVERSEER_ENTRY,
  type ItemCodeInput,
  type ItemCodeResult,
  type ItemSendInput,
  type ItemSendResult,
  type CodingWorktree,
  type ProjectCodingMode,
  type ProjectOverseerInfo,
  type ProjectOverseerMarkerData,
  type StartedSession,
} from "../shared/project-overseer";
import { ORG_ABOUT_MAX } from "../shared/orgs";
import type { SessionSummary, TokenUsage } from "../shared/protocol";
import { onBatonEvent } from "./baton-events";
import { allBatons, batonById, createBaton, nameOf, sessionPathOf, workspaceHasFile } from "./baton";
import { acquireChat, BusyError, disposeHeldChat, drainQueueThenAbort, heldChat, isSessionBusy, onAgentSettled, registerSpecialLoadout, setOpeningChoice, type ChatSession } from "./chat-manager";
import { PROCESS_START, shuttingDown } from "./wrapup-recovery";
import { getSessionInsight } from "./insights";
import { listModels } from "./models";
import { workingSubagents } from "./live";
import { mergeMode } from "./mode-state";
import { baseCodingMode, codingModeChoice, describeCodingMode, type ModeRequest } from "./project-coding-mode";
import { cutWorktree, gitRootOf, mergeBack, readWorktree, removeWorktree, WorktreeRefusal } from "./project-worktrees";
import { piUsageTally } from "./transcript-usage";
import { decidePerson, onOrgAttached, orgDir, orgOfSessionPath, overseerPausedSince, resumeOverseer, OrgError, participantLine, readIndex, readOrg, readOrgAbout, readProjects, readRoster, operatorName, stakeholderLine } from "./orgs";
import { appRequest, pathOfId, promptSession, toolCatalogue } from "./overseer";
import { RootConfinement } from "./overseer-deny";
import { overseerFileTools } from "./overseer-file-tools";
import { getIdea, promptToc, readManifest, readProse, updateIdea } from "./overseer-ideas";
import { redactExtensionMessages, serverRedactor } from "./overseer-redact";
import { readNotes, rotateState } from "./overseer-store";
import { appendUpdate, cleanUpdateText, lastUpdate } from "./project-updates";
import { promptOpenTodos, readTodos, updateTodo } from "./overseer-todos";
import { UserTurns } from "./overseer-tools";
import { canonicalPath } from "./paths";
import { listDecisions, onReconcileEvent, promoteDecisions, reconcileProject } from "./reconcile";
import { isViewing, markSeen, readSeen } from "./seen";
import { cleanSessionTitle, readSessionTitles, setSessionTitle } from "./session-titles";
import { getSessionSummary, indexedSessionPaths, listSessions } from "./sessions-index";
import { setArchived } from "./archived-sessions";
import { readView } from "./share/hub";
import { normalizeEntries, readActiveBranch } from "./transcript";
import { loadDefaults } from "./web-defaults";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";
import {
  dayKey,
  effectiveAutonomy,
  fitThinking,
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
  type StartedRow,
  markStarted,
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

/** Archive conversations past the history's 20; they stay in the workspace repo, like every
    workspace file (Clean Up never deletes one, §app.session-list/cleanup-org-guard). */
async function dropHistory(ids: string[]): Promise<void> {
  for (const id of ids) if (await pathOfId(id)) setArchived(id, true);
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
    // Its workers too (delegate, a spec writer): their lifetime total, live or restored.
    const workers = await getSessionInsight(c.path).then((i) => i.usageTotal, () => undefined);
    const spent = sessionSpend(piUsageTally()(text, "snapshot"), workers);
    counted.set(c.sessionId, spent);
    total += spent;
  }
  // Kept in the repo, so the budget still counts these on a host without the files.
  if (counted.size) recordTokens(p, counted);
  tokenMemo.set(k, { at: Date.now(), value: total });
  return total;
}

/** A coding session's spend: its own usage plus its workers' lifetime total. Pure, for the tests. */
export function sessionSpend(own: TokenUsage, workers?: TokenUsage): number {
  const sum = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;
  return sum(own) + (workers ? sum(workers) : 0);
}

/** Every coding session the project started (both kinds), with its worktree or why it runs in the root, newest first. */
async function codingWorktrees(p: ProjectOverseerPaths, root: string): Promise<CodingWorktree[]> {
  const known = indexedSessionPaths();
  const out: CodingWorktree[] = [];
  for (const r of readStarted(p)) {
    if (r.kind !== "coding" && r.kind !== "operator-coding") continue;
    const path = known.get(r.sessionId) ?? (r.path && existsSync(r.path) ? r.path : null);
    const common = {
      sessionId: r.sessionId,
      path,
      title: path ? ((await getSessionSummary(path).catch(() => null))?.title ?? "") : "",
      startedBy: r.kind === "coding" ? ("overseer" as const) : ("operator" as const),
      running: path ? isSessionBusy(path) : false,
      workers: path ? workingSubagents(path) : 0,
      createdAt: r.createdAt,
    };
    if (!r.worktree) {
      // Started before worktrees (no reason recorded) or in a root that can't have one.
      out.push({ ...common, branch: null, ...(r.inRoot ? { inRoot: r.inRoot } : {}), worktree: null, base: null, target: null, state: "root", merged: false, ahead: 0, dirty: false });
      continue;
    }
    const w = await readWorktree(r.worktree, root);
    out.push({
      ...common,
      branch: r.worktree.branch,
      worktree: w.worktree,
      base: r.worktree.base,
      target: r.worktree.target,
      state: r.removed ? "removed" : w.state,
      // Merged by Merge Branch, by hand (git sees it), or removed with its branch (only ever a merged one).
      merged: w.merged || !!r.merged || !!r.branchDeleted,
      ...(!w.branch ? { branchGone: true } : {}),
      ...(r.merged ? { mergedAt: r.merged.at } : {}),
      ...(r.removed ? { removedAt: r.removed } : {}),
      ahead: w.ahead,
      dirty: w.dirty,
      ...(w.error ? { error: w.error } : {}),
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const repo = await gitRootOf(project.root);
  const trees = await codingWorktrees(p, project.root);
  for (const s of started) {
    const t = trees.find((x) => x.sessionId === s.sessionId);
    if (t?.branch) s.worktree = { branch: t.branch, state: t.state };
  }
  return {
    orgId,
    projectId,
    projectName: project.name,
    exists,
    path: exists ? path : null,
    id: exists ? st!.current : null,
    history,
    settings,
    codingModeNow: baseCodingMode(settings.codingMode, project.root),
    worktrees: { available: !("reason" in repo), ...("reason" in repo ? { reason: repo.reason } : {}), sessions: trees },
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
  // A thinking level the model doesn't offer: refused when the patch names it, else brought to pi's level and saved.
  const models = await listModels().catch(() => []);
  const s = patchPoSettings(p, body, (next, patch) => fitThinking(next, patch, models, loadDefaults().model ?? null));
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
    CODING_MODE: `${describeCodingMode(baseCodingMode(settings.codingMode, project.root))}${settings.codingMode ? " (the operator's setting)" : " (Automatic)"}`,
    ROSTER: active.length ? [...active.map(participantLine), stakeholderLine(project, roster) ?? ""].filter(Boolean).join("\n") : "(nobody yet: ask the operator to add people)",
    IDEAS: r.redact(promptToc(readManifest(p.ideas), readPoState(p)?.current ?? "")),
    TODOS: r.redact(promptOpenTodos(readTodos(p.todos))),
    NOTES: notes ? r.redact(notes.slice(0, 4000)) : "(none yet)",
    TOOLS: toolCatalogue(tools),
    NOW: now.toString(),
  };
  const extra = settings.extraSystemPrompt.trim();
  // The org's About text: after Sova's fixed prompt, before the project's own instructions (which win).
  // This render is its only reader outside the org routes (§app.organizations/about).
  const about = readOrgAbout(orgId).slice(0, ORG_ABOUT_MAX).trim();
  return (
    template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => values[k] ?? "") +
    (about ? `\n\n${aboutSection(values.ORG!, r.redact(about))}` : "") +
    (extra ? `\n\n# The operator's extra instructions\n\n${r.redact(extra)}` : "")
  );
}

const aboutSection = (org: string, text: string): string =>
  [
    "# About this organization (written by the operator)",
    "",
    `The operator wrote this about ${org}, for you only. It is context, not a person's words and not a decision. Never copy it into anything a person sees (a gathering session's public_title, question or goal, a Send to person… question) or into a coding session's prompt; use it to judge, not to quote. The project's extra instructions below take precedence over it.`,
    "",
    text,
  ].join("\n");

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
    // Its settle sessions get the model people talk to: its gathering choice, as its gathering sessions do.
    reconcile: async () => reconcileProject(orgId, projectId, { owner: { overseerOf: projectId }, ...(await gatheringChoice(orgId, projectId, {})) }),
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
    codingMode(req) {
      const s = settings();
      return codingModeChoice(req, baseCodingMode(s.codingMode, projectOf(orgId, projectId).root), s.codingMode);
    },
    async createCoding(input) {
      const made = await startCodingSession(orgId, projectId, { ...input, kind: "coding" });
      return {
        id: made.sessionId,
        path: made.path,
        cwd: made.cwd,
        ...(made.worktree ? { worktree: made.worktree } : {}),
        ...(made.note ? { note: made.note } : {}),
        ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}),
      };
    },
    async send(path, text, mode) {
      let applies: "now" | "after-turn" | undefined;
      if (mode) applies = await applyCodingMode(path, mode);
      const r = await promptSession(path, text);
      if (!r.ok) throw new Error(r.error);
      return { queued: r.queued, ...(applies ? { modeApplies: applies } : {}) };
    },
    coding: () => codingOf(paths),
    startedCoding: () => new Map(readStarted(paths).filter((r) => r.kind === "coding" || r.kind === "operator-coding").map((r) => [r.sessionId, { removed: !!r.removed }])),
    codingTokens: () => codingTokens(paths),
    async postOwnerUpdate(input) {
      const owner = readRoster(orgId).find((x) => x.id === readOrg(orgId).owner && x.status === "active");
      if (!owner) throw new Error("This organization has no owner, so there is no page to post to.");
      const text = cleanUpdateText(input.text);
      const leak = ownerUpdateLeak(orgId, projectId, text);
      if (leak) throw new Error(leak);
      if (!input.attended) {
        const last = lastUpdate(orgId, projectId);
        const now = Date.now();
        if (last && now - Date.parse(last.at) < OWNER_UPDATE_EVERY_MS) throw new Error(`An update was posted ${hoursAgo(last.at, now)}: at most one a day.`);
        if (!(await milestoneSince(orgId, projectId, last ? Date.parse(last.at) : 0)))
          throw new Error("Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged.");
      }
      const update = appendUpdate(orgId, projectId, { text, run: input.attended ? "operator" : "auto" });
      return { update, owner: owner.name };
    },
  };
}

/** The shortest repeated run that counts as copying private text into an owner update. */
export const OWNER_UPDATE_REPEAT = 24;
/** At most one owner update per project in this long, in runs the operator did not start. */
export const OWNER_UPDATE_EVERY_MS = 24 * 3_600_000;

const hoursAgo = (at: string, now: number): string => {
  const h = Math.floor((now - Date.parse(at)) / 3_600_000);
  return h < 1 ? "less than an hour ago" : h === 1 ? "1 hour ago" : `${h} hours ago`;
};

/**
 * A real milestone of the project since `since` (ms), for an update in a run the operator did not
 * start (§app.owner-page/updates): a conversation shown on the owner page finished, a decision was
 * agreed (promoted), or a coding session of the project was merged, or finished (not working now,
 * its file last written after `since`).
 */
export async function milestoneSince(orgId: string, projectId: string, since: number): Promise<boolean> {
  const after = (t: string | undefined) => !!t && Date.parse(t) > since;
  const project = projectOf(orgId, projectId);
  const shown = projectBatons(orgId, projectId).filter((b) => !b.hiddenFromOwner && !project.ownerHidden);
  if (shown.some((b) => b.state === "done" && after(b.closedAt))) return true;
  const shownIds = new Set(shown.map((b) => b.sessionId));
  try {
    if (listDecisions(orgId, projectId).decisions.some((d) => d.state === "promoted" && shownIds.has(d.sessionId) && after(d.promotedAt))) return true;
  } catch {
    // an index that can't sync: no decision counts
  }
  const known = indexedSessionPaths();
  for (const r of readStarted(projectOverseerPaths(orgId, projectId))) {
    if (r.kind !== "coding" && r.kind !== "operator-coding") continue;
    if (after(r.merged?.at)) return true;
    const path = known.get(r.sessionId) ?? r.path;
    if (!path || !existsSync(path) || isSessionBusy(path)) continue;
    try {
      if (statSync(path).mtimeMs > since) return true;
    } catch {
      // gone
    }
  }
  return false;
}

/**
 * The refusal for an owner update that repeats private text, or null (§app.owner-page/updates). An update is
 * written by this project's overseer, whose prompt holds the org's About text, its notes and the
 * operator's instructions: any run of OWNER_UPDATE_REPEAT characters from those, from a
 * conversation's goal or a hand-off briefing, or from a person's profile, and any contact value,
 * refuses the post. The About text is read here to be kept OUT of the update, never to write it.
 */
export function ownerUpdateLeak(orgId: string, projectId: string, text: string): string | null {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  const repeats = (secret: string): boolean => {
    const s = norm(secret);
    for (let i = 0; i + OWNER_UPDATE_REPEAT <= s.length; i++) if (hay.includes(s.slice(i, i + OWNER_UPDATE_REPEAT))) return true;
    return false;
  };
  const paths = projectOverseerPaths(orgId, projectId);
  const roster = readRoster(orgId);
  const batons = projectBatons(orgId, projectId);
  const PRIVATE = "This update repeats text from About this organization or your notes. Updates are for the client: write it again in your own words.";
  const OTHER = "This update repeats private text (a conversation's goal or briefing, the operator's instructions, or a person's profile or contact). Updates are for the client: write it again in your own words.";
  const sources: [string, string[]][] = [
    [PRIVATE, [readOrgAbout(orgId), readNotes(paths.notes)]],
    [OTHER, [readPoSettings(paths).extraSystemPrompt, ...batons.flatMap((b) => [b.goal, ...b.handoffs.map((h) => h.briefing), ...(b.offers ?? []).map((o) => o.briefing)])]],
    [OTHER, roster.flatMap((x) => [x.voice, x.role, ...x.skills, x.referral?.why ?? ""])],
  ];
  for (const [what, texts] of sources) if (texts.some((t) => t && repeats(t))) return what;
  for (const x of roster) for (const v of Object.values(x.contact ?? {})) if (typeof v === "string" && v.trim().length >= 5 && hay.includes(norm(v))) return OTHER;
  return null;
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

/**
 * Set a coding session's mode and pin it (§app.project-overseer/tools, Modes): the mode extension's
 * own handler (applyMode), then the `mode` entry Sova writes itself, so the session keeps this mode
 * whatever mode.json says later. Throws when either can't be done: the caller then sends no prompt.
 * Returns when the switch applies (a running turn finishes in the old mode).
 */
async function applyCodingMode(path: string, mode: ProjectCodingMode): Promise<"now" | "after-turn"> {
  const chat = await acquireChat(path);
  const plan = await chat.applyMode(mergeMode(chat.modeState, { mode: mode.mode, minorModes: mode.minorModes as never }));
  if (plan !== "command")
    throw new OrgError(plan === "unsupported" ? "the mode extension is not loaded in it" : "it is open in another writer (a terminal, or a process Sova doesn't know)", 409);
  if (!chat.pinMode()) throw new OrgError("its mode entry could not be written", 409);
  return chat.session.isStreaming ? "after-turn" : "now";
}

export interface StartedCoding {
  sessionId: string;
  path: string;
  /** Where it runs: its worktree (or the folder inside it), else the root folder asked for. */
  cwd: string;
  mode: ProjectCodingMode;
  worktree?: { path: string; branch: string };
  /** Why it runs in the root itself (a tail: "it isn't a Git repository."). */
  note?: string;
  /** Its mode could not be set, so no prompt was sent: the sentence to show. */
  notPrompted?: string;
}

export const NOT_PROMPTED = "Started, but not prompted: its mode could not be set.";

/**
 * A new ordinary coding session for the project (sova_create_session, Start coding session): in its
 * own git worktree and branch cut from the root's HEAD when the root is in git (else in the root,
 * with the reason recorded), created through the same route the browser uses, recorded in
 * started.json at once (so it is listed and budgeted even when its prompt fails), titled, with
 * model and thinking, then its mode set and pinned, and only then its first prompt. A mode that
 * could not be set sends no prompt.
 */
async function startCodingSession(
  orgId: string,
  projectId: string,
  input: { cwd?: string; prompt: string; title?: string; model?: string; thinking?: string; mode?: ProjectCodingMode; kind: "coding" | "operator-coding" },
): Promise<StartedCoding> {
  const project = projectOf(orgId, projectId);
  const p = projectOverseerPaths(orgId, projectId);
  const settings = readPoSettings(p);
  const mode = input.mode ?? baseCodingMode(settings.codingMode, project.root);
  let cwd = input.cwd ?? project.root;
  const repo = await gitRootOf(project.root);
  let extra: Pick<StartedRow, "worktree" | "inRoot"> = {};
  if ("reason" in repo) extra = { inRoot: repo.reason };
  else {
    try {
      const cut = await cutWorktree(repo, cwd, input.title?.trim() || input.prompt.trim().split(/\s+/).slice(0, 8).join(" "));
      cwd = cut.cwd;
      extra = { worktree: cut.worktree };
    } catch (err) {
      throw new OrgError(`No session was started: its worktree could not be made (${err instanceof Error ? err.message : String(err)}).`, 409);
    }
  }
  const res = await appRequest("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const json = (await res.json().catch(() => null)) as (SessionSummary & { error?: string }) | null;
  if (res.status !== 201 || !json?.path) {
    // Nothing runs in it: the worktree goes again (it holds nothing).
    if (extra.worktree) await removeWorktree(extra.worktree, project.root).catch(() => {});
    throw new OrgError(json?.error ?? `Creating the session failed (HTTP ${res.status}).`, res.status === 409 ? 409 : 400);
  }
  noteStarted(p, json.id, input.kind, new Date(), json.path, extra);
  const title = input.title?.trim() ? cleanSessionTitle(input.title) : null;
  if (title) setSessionTitle(json.id, title);
  const choice = codingChoice(input, settings, await overseerRunning(orgId, projectId));
  // Opened on its model and thinking from the start (its file never records the default first);
  // set again only when the open didn't take them (a model without auth, an unknown level).
  setOpeningChoice(json.path, choice);
  const chat = await acquireChat(json.path);
  const cur = chat.session.model ? `${chat.session.model.provider}/${chat.session.model.id}` : null;
  // (The open already clamped the thinking to the model's levels, as a later setThinking would.)
  if (choice.model && choice.model !== cur) {
    await chat.setModelRef(choice.model);
    if (choice.thinking) chat.setThinking(choice.thinking);
  }
  const made: StartedCoding = {
    sessionId: json.id,
    path: json.path,
    cwd,
    mode,
    ...(extra.worktree ? { worktree: { path: extra.worktree.path, branch: extra.worktree.branch } } : {}),
    ...(extra.inRoot ? { note: extra.inRoot } : {}),
  };
  try {
    await applyCodingMode(json.path, mode);
  } catch (err) {
    // The session stays, listed and counted; its first turn never runs in a mode it wasn't given.
    console.warn(`[project-overseer] ${json.id}: mode ${describeCodingMode(mode)} not set: ${err instanceof Error ? err.message : String(err)}`);
    return { ...made, notPrompted: NOT_PROMPTED };
  }
  const sent = await promptSession(json.path, input.prompt);
  if (!sent.ok) throw new OrgError(sent.error, 409);
  return made;
}

// ---- worktrees: the operator's merge and removal ------------------------------------------------------

function worktreeRow(p: ProjectOverseerPaths, sessionId: unknown): StartedRow & { worktree: NonNullable<StartedRow["worktree"]> } {
  if (typeof sessionId !== "string" || !sessionId) throw new OrgError("Give the sessionId");
  const r = readStarted(p).find((x) => x.sessionId === sessionId && (x.kind === "coding" || x.kind === "operator-coding"));
  if (!r) throw new OrgError("Unknown coding session of this project", 404);
  if (!r.worktree) throw new OrgError(`It runs in the project root${r.inRoot ? `: ${r.inRoot}` : "."}`, 409);
  return r as StartedRow & { worktree: NonNullable<StartedRow["worktree"]> };
}

/** The session file on this host, or a refusal (a gesture never acts on another host's worktree); refused while it or its workers run. */
function refuseBusy(r: StartedRow): string {
  const path = indexedSessionPaths().get(r.sessionId) ?? (r.path && existsSync(r.path) ? r.path : null);
  if (!path) throw new OrgError("On another host: its worktree is there.", 409);
  if (isSessionBusy(path)) throw new OrgError("The session is working.", 409);
  if (workingSubagents(path) > 0) throw new OrgError("Its workers are running.", 409);
  return path;
}

/** POST …/worktrees/merge: Merge Branch, into its target in the project root's checkout. */
export async function mergeCodingWorktree(orgId: string, projectId: string, sessionId: unknown): Promise<ProjectOverseerInfo> {
  const project = projectOf(orgId, projectId);
  const p = projectOverseerPaths(orgId, projectId);
  const r = worktreeRow(p, sessionId);
  const path = refuseBusy(r);
  const title = (await getSessionSummary(path).catch(() => null))?.title || r.worktree.branch;
  try {
    const m = await mergeBack(r.worktree, project.root, title);
    markStarted(p, r.sessionId, { merged: { at: new Date().toISOString(), commit: m.sha } });
  } catch (err) {
    if (err instanceof WorktreeRefusal) throw new OrgError(err.message, 409);
    throw err;
  }
  return projectOverseerInfo(orgId, projectId);
}

/** POST …/worktrees/remove: Remove Worktree; the branch goes too only when merged. The session stays. */
export async function removeCodingWorktree(orgId: string, projectId: string, sessionId: unknown): Promise<ProjectOverseerInfo> {
  const project = projectOf(orgId, projectId);
  const p = projectOverseerPaths(orgId, projectId);
  const r = worktreeRow(p, sessionId);
  if (r.removed) throw new OrgError("Its worktree was already removed.", 409);
  const path = refuseBusy(r);
  try {
    const out = await removeWorktree(r.worktree, project.root);
    markStarted(p, r.sessionId, { removed: new Date().toISOString(), ...(out.branchDeleted ? { branchDeleted: true } : {}) });
  } catch (err) {
    if (err instanceof WorktreeRefusal) throw new OrgError(err.message, 409);
    throw err;
  }
  // Its cwd is gone: a held runtime would run tools in nothing.
  await disposeHeldChat(path, "Its worktree was removed, so it has no folder to work in.").catch(() => {});
  return projectOverseerInfo(orgId, projectId);
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

/** The context files pi found that belong to the project: those inside its root (and outside what
    the file tools never read). */
export function projectContextFiles<T extends { path: string }>(files: T[], root: string, out: string[] = confinedOut()): T[] {
  const c = new RootConfinement(root, out);
  return files.filter((f) => c.problem(f.path) === null);
}

/** What the project overseer's file tools never read, even inside its root: every attached org's
    workspace (the roster's contacts, every project's transcripts) and pi's and Sova's state (the
    host's link store, every session). */
const confinedOut = () => [...readIndex().orgs.map((o) => o.dir), getAgentDir(), join(homedir(), ".pi")];

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
        // no input rewriting. The project's own context files (AGENTS.md) stay; the host's (the
        // agent dir's, and those of folders above the root, like the home folder's) don't.
        agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: projectContextFiles(agentsFiles, project.root) }),
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
      // read/grep/find/ls in the project root only, never a secret file, an org's workspace or
      // Sova's own state (overseer-deny.ts), whatever the root holds.
      customTools: overseerFileTools(project.root, undefined, undefined, () => new RootConfinement(projectOf(rt.orgId, rt.projectId).root, confinedOut())),
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
  // Recorded at once as organizational (server/org-sessions.ts), under its own kind so the
  // overseer's budget and caps, which read only "coding", never count the operator's sessions.
  const made = await startCodingSession(orgId, projectId, {
    prompt: body.prompt?.trim() || item.text,
    title: item.title.slice(0, 80),
    ...(body.model ? { model: body.model } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    kind: "operator-coding",
  });
  linkItem(p, item, made.sessionId);
  return {
    path: made.path,
    sessionId: made.sessionId,
    ...(made.worktree ? { worktree: made.worktree } : {}),
    ...(made.note ? { note: made.note } : {}),
    ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}),
  };
}

// ---- the watch loop ------------------------------------------------------------------------------------

export const WATCH_TICK_MS = 20_000;
export const WATCH_MIN_GAP_MS = 10 * 60_000;
/** An event that should be seen soon starts a look this long after it (bypassing the 10-minute gap). */
export const WATCH_SOON_MS = 60_000;
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
  /** When an event asked for a look soon (ms; 0 = none): due from then on, whatever the gap. */
  soonAt?: number;
}): { run: boolean; why?: string } {
  if (!input.exists) return { run: false, why: "no conversation yet" };
  if (!input.idle) return { run: false, why: "busy" };
  if (!input.force) {
    if (!input.watch) return { run: false, why: "watching is off" };
    if (!input.pending.length) return { run: false, why: "nothing new" };
    const soon = !!input.soonAt && input.now >= input.soonAt;
    if (!soon && input.now - input.lastRunAt < WATCH_MIN_GAP_MS) return { run: false, why: "too soon" };
  }
  if (input.today >= input.perDay) return { run: false, why: `the daily limit of ${input.perDay} unattended runs is reached` };
  return { run: true };
}

/** `openTodos`: how many of the operator's to-dos are open (their text is in the prompt). */
export function watchText(reasons: string[], autonomy: string, openTodos = 0): string {
  const list = reasons.length ? reasons.slice(-20).map((r) => `- ${r}`).join("\n") : "- (the operator asked for a look)";
  const todos = openTodos ? `The operator has ${openTodos} open to-do item${openTodos === 1 ? "" : "s"} for you, listed in full in your prompt: work on ${openTodos === 1 ? "it" : "them"} too. ` : "";
  return (
    `${WATCH_PREFIX} Since your last look:\n${list}\n\n` +
    `Re-read the project (sova_project, and sova_decisions where it matters). Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). ` +
    todos +
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
export function noteReason(orgId: string, projectId: string, reason: string, own = false, soon = false, now = Date.now()): void {
  try {
    const p = projectOverseerPaths(orgId, projectId);
    if (!readPoState(p)) return;
    const rt = rts.get(keyOf(orgId, projectId));
    if (own && rt?.session?.isStreaming) return;
    const m = readMemo(p);
    if (!m.pending.includes(reason)) m.pending.push(reason);
    // The first such event since the last look sets when; later ones don't push it back.
    if (soon && !m.soonAt) m.soonAt = new Date(now + WATCH_SOON_MS).toISOString();
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
    soonAt: memo.soonAt ? Date.parse(memo.soonAt) : 0,
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
  const at = new Date().toISOString();
  try {
    const po = await acquireChat(path!);
    po.assertModelAllowed();
    const openTodos = readTodos(p.todos).todos.filter((t) => !t.done).length;
    const from = po.session.sessionManager.getBranch().length;
    const { queued, turn } = po.acceptPrompt(watchText(reasons, eff.autonomy, openTodos), undefined, "server");
    const end = (err?: unknown) => recordRunEnd(p, at, runEnd(po, from, err));
    if (queued) {
      // Held behind a start or a compaction: it runs as the next turn, which ends at the next settle.
      const off = onAgentSettled((settledPath) => {
        if (canonicalPath(settledPath) !== canonicalPath(path!)) return;
        off();
        end();
      });
    } else
      void turn.then(
        () => end(),
        (err) => {
          po.reportTurnFailure(err);
          end(err);
        },
      );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    memo.lastRun = { at: new Date().toISOString(), reasons, outcome: "skipped", detail };
    writeMemo(p, memo);
    return { started: false, why: detail };
  }
  writeMemo(p, { ...memo, pending: [], soonAt: null, lastRunAt: at, lastRun: { at, reasons, outcome: "started" }, perDay: { ...memo.perDay, [today]: (memo.perDay[today] ?? 0) + 1 } });
  return { started: true };
}

export const CUT_OFF_DETAIL = "The server restarted during the run.";

/** How an unattended run ended, from its own part of the branch (entries past `from`). */
function runEnd(chat: ChatSession, from: number, err?: unknown): { outcome: "finished" | "stopped" | "cut-off"; detail?: string } {
  const mine = chat.session.sessionManager.getBranch().slice(from);
  const last = [...mine].reverse().find((e) => e.type === "message" && e.message.role === "assistant") as { message: { stopReason?: string; errorMessage?: string } } | undefined;
  const stop = last?.message.stopReason;
  const failed = !last || stop === "error" || stop === "aborted" || err !== undefined;
  if (!failed) return { outcome: "finished" };
  if (chat.lastStreamTrip) return { outcome: "stopped", detail: chat.lastStreamTrip.detail };
  if (shuttingDown()) return { outcome: "cut-off", detail: CUT_OFF_DETAIL };
  if (stop === "aborted") return { outcome: "stopped", detail: "Stopped." };
  if (stop === "error") return { outcome: "stopped", detail: last?.message.errorMessage || "The model failed." };
  if (err !== undefined) return { outcome: "stopped", detail: err instanceof Error ? err.message : String(err) };
  return { outcome: "stopped", detail: "The run ended without an answer." };
}

/** Record how the run started at `at` ended, unless a later run (or a skip) took its place. */
function recordRunEnd(p: ProjectOverseerPaths, at: string, end: { outcome: "finished" | "stopped" | "cut-off"; detail?: string }): void {
  try {
    const m = readMemo(p);
    if (m.lastRun?.at !== at || m.lastRun.outcome !== "started") return;
    const { detail: _old, ...run } = m.lastRun;
    writeMemo(p, { ...m, lastRun: { ...run, outcome: end.outcome, ...(end.detail ? { detail: end.detail } : {}) } });
  } catch (err) {
    console.warn("[project-overseer] run end not recorded:", err instanceof Error ? err.message : String(err));
  }
}

/** A run still `started` from before this process: nothing runs it now (one server per state dir). */
export function sweepCutOffRuns(processStart = PROCESS_START): void {
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
        const run = readMemo(p).lastRun;
        if (run?.outcome === "started" && !(Date.parse(run.at) >= processStart)) recordRunEnd(p, run.at, { outcome: "cut-off", detail: CUT_OFF_DETAIL });
      } catch {
        // not a store id shape
      }
    }
  }
}

/**
 * A hosted session finished a turn: when it is one of the coding sessions a project overseer
 * started (kind "coding", never the operator's "operator-coding"), a reason to look soon.
 */
export function noteCodingSettled(path: string, now = Date.now()): void {
  const want = canonicalPath(path);
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
        const row = readStarted(p).find((r) => r.kind === "coding" && r.path && canonicalPath(r.path) === want);
        if (!row) continue;
        const title = readSessionTitles()[row.sessionId] || row.sessionId;
        const failed = lastTurnFailed(path);
        noteReason(o.id, pr.id, `The coding session "${title}" ${failed ? "stopped with an error" : "finished its turn"}.`, false, true, now);
        return;
      } catch {
        // not a store id shape
      }
    }
  }
}

/** Whether the held chat's last assistant message ended in an error or an abort. */
function lastTurnFailed(path: string): boolean {
  const chat = heldChat(path);
  if (!chat) return false;
  const branch = chat.session.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as { type: string; message?: { role?: string; stopReason?: string } };
    if (e.type === "message" && e.message?.role === "assistant") return e.message.stopReason === "error" || e.message.stopReason === "aborted";
  }
  return false;
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
  sweepCutOffRuns();
  onBatonEvent((e) => {
    // A decision recorded mid-session is not a reason on its own: the session's end is, and it
    // comes with its decisions (a settle session's answer reaches the reconciler, whose events are).
    if (e.type === "done") noteReason(e.orgId, e.projectId, `The gathering session "${batonTitle(e.sessionId)}" reached its goal.`, false, true);
    else if (e.type === "closed") noteReason(e.orgId, e.projectId, `The gathering session "${batonTitle(e.sessionId)}" was closed.`);
    else if (e.type === "proposal") noteReason(e.orgId, e.projectId, `Someone was referred in "${batonTitle(e.sessionId)}" (a proposed roster person).`);
  });
  onReconcileEvent((e) => {
    const n = e.ids.length;
    if (e.type === "conflict") noteReason(e.orgId, e.projectId, `${n} new conflict${n === 1 ? "" : "s"} between decisions.`, true);
    else if (e.type === "resolved") noteReason(e.orgId, e.projectId, `${n} conflict${n === 1 ? " was" : "s were"} resolved.`, true);
    // The operator's promotion is news (a look soon: what it promoted may be ready to build); its own is not.
    else if (e.type === "promoted" && e.by !== "overseer" && n) noteReason(e.orgId, e.projectId, `The operator promoted ${n} decision${n === 1 ? "" : "s"} into the spec.`, false, true);
    else if (e.type === "promoted") noteReason(e.orgId, e.projectId, `${n} decision${n === 1 ? " was" : "s were"} promoted into the spec.`, true);
    else if (e.type === "drafted") noteReason(e.orgId, e.projectId, `${n} decision${n === 1 ? " is" : "s are"} drafted and promotable.`, true);
  });
  // A coding session it started finished a turn (the operator's own never wake it).
  onAgentSettled((path) => noteCodingSettled(path));
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
