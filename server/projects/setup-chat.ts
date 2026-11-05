import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MergeRun, MergeTrial } from "../../shared/merge-queue";
import { CONTRACT_FILE } from "../../shared/project-contract";
import type { RuntimeRunReview } from "../../shared/project-runtime";
import type { PlaybookReviewFact } from "./playbook-review";
import type { SetupChatView, SetupHistoryItem, SetupOpened, SetupProposal, SetupState, SetupStatus, SetupTrial, SetupTrialCheck } from "../../shared/setup-chat";
import { isArchived } from "../archived-sessions";
import { attentionChanged } from "../attention-memo";
import { OrgError } from "../org-error";
import type { Envelope } from "../org-envelope";
import { realGit } from "../project-services/engine";
import { stateRoot } from "../state-root";
import { SETUP_PLAYBOOK_ID } from "./onboard";
import { projectArchived, readProject } from "./spaces";

/**
 * The Setup chat (§app.project-setup/chat, /start): one standing chat per project, title "Setup · {folder}". It is a
 * verb playbook run of `project-setup` (proposes: pipeline): a coding session of kind onboard on its own worktree and
 * branch, whose proposal the tab reads from the branch (server/projects/runtime.ts) and the user lands. Set Up with a
 * Chat and Change Setup open the chat the project has; only when it has none open is a new one started, its first
 * message the playbook's turn plus the project, its current setup and its earlier setup chats (its memory).
 *
 * Start Fresh archives the open chat. While its run's proposal is still open, the new chat carries on in the same
 * worktree and branch (the proposal stays the old run's, so Land and Merge Branch still find it); once that run has
 * ended, a new run is started on a fresh branch.
 *
 * The record is `<state>/setup-chats.json`: per project, its current chat and the earlier ones.
 */

export interface SetupCurrent {
  sessionId: string;
  path: string;
  startedAt: string;
  /** The verb playbook run whose proposal this chat carries: its own session, or (after Start Fresh) the earlier one's. */
  run: string;
  branch?: string;
  worktree?: string;
}

interface ProjectRecord {
  current?: SetupCurrent;
  history: SetupHistoryItem[];
}

const HISTORY_MAX = 20;

const recordFile = (): string => join(stateRoot(), "setup-chats.json");

function readAll(): Record<string, ProjectRecord> {
  try {
    const raw = JSON.parse(readFileSync(recordFile(), "utf8")) as Record<string, ProjectRecord>;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, ProjectRecord>): void {
  const file = recordFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function setupRecordOf(projectId: string): ProjectRecord {
  const r = readAll()[projectId];
  return { ...(r?.current ? { current: r.current } : {}), history: Array.isArray(r?.history) ? r.history : [] };
}

function saveRecord(projectId: string, r: ProjectRecord): void {
  const all = readAll();
  all[projectId] = { ...(r.current ? { current: r.current } : {}), history: r.history.slice(-HISTORY_MAX) };
  writeAll(all);
}

export const setupTitle = (root: string, name: string): string => `Setup · ${basename(root) || name}`;

// ---- what the chat is told first ------------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The facts the first message is made of. */
export interface SetupContextFacts {
  name: string;
  root: string;
  target: string;
  served: boolean;
  /** The target's `.sova/project.json`, raw; null when it has none; a string when it isn't JSON. */
  definition: Record<string, unknown> | string | null;
  /** The release playbook's step ids on the target, when it has a release setup. */
  releaseSteps: string[];
  history: SetupHistoryItem[];
  /** Start Fresh while a proposal was open: the branch and folder this chat carries on in. */
  carryOn?: { branch?: string; worktree?: string; from: string };
  why?: string;
  /** Which part the user came from: the chat starts there. */
  from?: SetupFrom;
}

export const SETUP_FROM = ["merge-queue", "releases", "deploy", "settings"] as const;
export type SetupFrom = (typeof SETUP_FROM)[number];
const FROM_WORDS: Record<SetupFrom, string> = {
  "merge-queue": "the Merge Queue tab: start with how branches land (the merge checks)",
  releases: "the Releases tab: start with releases",
  deploy: "the deploy panel: start with deploys",
  settings: "Settings → Merge Queue: start with how branches land (the merge checks)",
};

/** The host's block after the playbook's turn: `## This project`, `## Current setup`, `## Earlier setup chats`, `## The user's note`. Pure. */
export function setupContext(f: SetupContextFacts): string {
  const out = ["## This project", `- Name: ${f.name}`, `- Folder: ${f.root}`, `- Target branch: ${f.target}`, `- Merge queue: ${f.served ? "serves it (branches land only through the queue; your proposal lands with Land)" : "not set up (your proposal is merged with Merge Branch)"}`, ""];
  out.push("## Current setup");
  if (f.definition === null) out.push(`Nothing is set up yet: ${f.target} has no ${CONTRACT_FILE}.`);
  else if (typeof f.definition === "string") out.push(`${CONTRACT_FILE} on ${f.target} is not valid JSON: ${f.definition}`);
  else {
    const d = f.definition;
    const pick = Object.fromEntries(["services", "merge", "release", "deploy", "share"].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));
    out.push(Object.keys(pick).length ? `The pipeline sections of ${CONTRACT_FILE} on ${f.target}:` : `${CONTRACT_FILE} on ${f.target} declares no services, merge, release or deploy section yet.`);
    if (Object.keys(pick).length) out.push("```json", JSON.stringify(pick, null, 2), "```");
    if (f.releaseSteps.length) out.push(`Release playbook steps (${String(obj(d.release).playbook ?? "")}): ${f.releaseSteps.join(", ")}`);
    out.push("Summarise this setup as a drawing before anything else.");
  }
  out.push("");
  if (f.carryOn) {
    out.push("## Carrying on", `The user pressed Start Fresh on the earlier Setup chat (${f.carryOn.from}). Its open proposal stays: you work in the same folder${f.carryOn.worktree ? ` (${f.carryOn.worktree})` : ""}${f.carryOn.branch ? ` on its branch ${f.carryOn.branch}` : ""}. Read that branch's commits and the earlier chat before you change anything.`, "");
  }
  out.push("## Earlier setup chats");
  if (!f.history.length) out.push("None: this is the project's first Setup chat.");
  for (const h of [...f.history].reverse()) out.push(`- ${h.path} (started ${h.startedAt}, ${h.why === "fresh" ? "closed by Start Fresh" : "ended"} ${h.endedAt}${h.branch ? `, branch ${h.branch}` : ""})`);
  out.push("");
  out.push("## The user's note", f.why?.trim() || "None.");
  if (f.from) out.push("", `They came from ${FROM_WORDS[f.from]}.`);
  return out.join("\n");
}

async function contextFacts(projectId: string, extra: Pick<SetupContextFacts, "carryOn" | "why" | "from">): Promise<SetupContextFacts> {
  const p = readProject(projectId);
  const { servedByQueue } = await import("../merge-queue/served");
  const served = await servedByQueue(p.root).catch(() => false);
  const target = (await targetOf(p.root)) ?? "main";
  const shown = await realGit(["show", `${target}:${CONTRACT_FILE}`], p.root);
  let definition: SetupContextFacts["definition"] = null;
  if (shown.code === 0) {
    try {
      definition = obj(JSON.parse(shown.stdout));
    } catch (err) {
      definition = err instanceof Error ? err.message : String(err);
    }
  }
  const { releaseSetupAt } = await import("./release-proposal");
  const rs = definition && typeof definition === "object" && definition.release ? await releaseSetupAt(p.root, target).catch(() => null) : null;
  return { name: p.name || p.id, root: p.root, target, served, definition, releaseSteps: rs?.steps.map((s) => s.id) ?? [], history: setupRecordOf(projectId).history, ...extra };
}

/** The project's target branch: the merge queue's rule (the definition's merge.target, else the checkout's branch). */
async function targetOf(root: string): Promise<string | null> {
  const [{ resolveTarget }, { definitionAt }] = await Promise.all([import("../merge-queue/served"), import("../project-services/deploy-recipe")]);
  try {
    return await resolveTarget(realGit, root, (r, ref) => definitionAt(r, ref));
  } catch {
    const head = await realGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
    return head.code === 0 ? head.stdout.trim() : null;
  }
}

// ---- the tab's read ---------------------------------------------------------------------------------------

/** One trial as the tab shows it, from its record and run. Pure. */
export function trialView(t: MergeTrial, run: MergeRun | null): SetupTrial {
  const checks: SetupTrialCheck[] = [];
  for (const s of run?.steps ?? []) {
    if (s.kind !== "check" && s.kind !== "rerun-tip") continue;
    checks.push({
      name: s.label,
      kind: s.source === "release" ? "release" : "merge",
      state: s.result === "running" ? "running" : s.result === "passed" ? "passed" : s.result === "failed" ? "failed" : s.result === "skipped" ? "skipped" : "waiting",
      durationMs: s.ms,
      run: t.run,
      step: s.id,
    });
  }
  for (const c of t.notRun ?? []) checks.push({ name: c.label, kind: "release", state: "not-run" });
  return { id: t.run, commit: t.commit, at: t.endedAt ?? t.startedAt, pass: t.verdict === "passed", state: t.verdict, ...(t.why ? { why: t.why } : {}), checks };
}

/** What the proposal is read from: the Setup branch at its head, as Git has it (never the worktree's files). */
export interface SetupBranchRead {
  branch: string;
  target: string;
  commit: string;
  /** The head's pipeline hash (observe.ts pipelineHashOf); absent: no valid definition at the head. */
  hash?: string;
  review: RuntimeRunReview | null;
}

/** The proposal from the branch's read and the queue's trials. Pure. */
export function proposalOf(b: SetupBranchRead, served: boolean, trials: readonly MergeTrial[], readRun: (id: string) => MergeRun | null, untried: string | null, files: SetupProposal["files"] = []): SetupProposal {
  const r = b.review;
  const t = trials.find((x) => x.commit === b.commit);
  const trial = t ? trialView(t, readRun(t.run)) : null;
  const problem = r?.def.state === "invalid" ? r.def.error : r?.def.state === "absent" ? `${b.branch} has no ${CONTRACT_FILE}` : r?.release?.problem;
  const why = !b.hash ? (problem ?? "its branch has no valid setup") : untried;
  return {
    branch: b.branch,
    target: b.target,
    commit: b.commit,
    served,
    ...(b.hash ? { hash: b.hash } : {}),
    ...(problem ? { problem } : {}),
    services: r?.services ?? [],
    merge: r?.merge ?? null,
    ...(r?.release ? { release: r.release } : {}),
    ...(r?.deploy ? { deploy: r.deploy } : {}),
    files,
    trial,
    land: why ? { can: false, why } : { can: true },
  };
}

function setUpOf(definition: SetupContextFacts["definition"], served: boolean): SetupState {
  const d = definition && typeof definition === "object" ? definition : {};
  return { merge: served, release: !!d.release, deploy: !!d.deploy };
}

/** Whether the recorded chat is still the project's open one: its file here, not archived. */
function stillOpen(c: SetupCurrent | undefined): c is SetupCurrent {
  return !!c && !!c.path && existsSync(c.path) && !isArchived(c.sessionId);
}

const git1 = async (root: string, args: string[]): Promise<string> => {
  const r = await realGit(args, root);
  return r.code === 0 ? r.stdout.trim() : "";
};

/** The Setup branch's head and how many commits it has beyond the target; null when the branch is gone. */
export async function branchStateOf(root: string, branch: string, target: string): Promise<{ head: string; ahead: number } | null> {
  const head = await git1(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  if (!head) return null;
  const n = Number(await git1(root, ["rev-list", "--count", `${target}..${head}`]));
  return { head, ahead: Number.isFinite(n) ? n : 0 };
}

/** The Setup branch read at its head: its pipeline hash and review. */
async function readBranch(root: string, branch: string, target: string, head: string): Promise<SetupBranchRead> {
  const [{ branchFacts }, { branchReview }] = await Promise.all([import("../project-services/observe"), import("./playbook-review")]);
  const facts = await branchFacts(root, head).catch(() => null);
  const review = await branchReview(root, head, null, false, realGit, false, true).catch(() => null);
  return { branch, target, commit: head, ...(facts?.pipeline?.hash ? { hash: facts.pipeline.hash } : {}), review };
}

/** The open proposal of a project's Setup chat: its branch has commits beyond the target and no turn runs. */
async function openProposal(projectId: string, cur: SetupCurrent, target: string): Promise<{ read: SetupBranchRead; ahead: number } | null> {
  const root = readProject(projectId).root;
  if (!cur.branch) return null;
  const st = await branchStateOf(root, cur.branch, target);
  if (!st || st.ahead === 0) return null;
  return { read: await readBranch(root, cur.branch, target, st.head), ahead: st.ahead };
}

// ---- Needs you and the banner: the proposal as a verb playbook review (§app.project-runtime/review) -------------

const reviewCache = new Map<string, PlaybookReviewFact>();

/** The Setup chat's proposal as the attention row and the banner read it (kept from the last read); null: none. */
export function setupReviewOf(projectId: string): PlaybookReviewFact | null {
  return reviewCache.get(projectId) ?? null;
}

/** Every project's Setup proposal waiting on the operator, by its project. */
export function setupReviews(): PlaybookReviewFact[] {
  return [...reviewCache.values()];
}

function noteReview(projectId: string, cur: SetupCurrent | null, p: SetupProposal | null, since: number): void {
  const prev = reviewCache.get(projectId);
  if (!cur || !p) {
    // Needs you lists it no more: the digest's memo is dropped, so the row goes at its next read.
    if (reviewCache.delete(projectId)) attentionChanged();
    return;
  }
  const next: PlaybookReviewFact = {
    projectId,
    sessionId: cur.run,
    // Needs you lists it on the chat the user talks to now (after Start Fresh, the carry-on chat).
    path: cur.path,
    label: "Project setup",
    branch: p.branch,
    target: p.target,
    ...(p.hash ? { hash: p.hash } : {}),
    commit: p.commit,
    proposes: "pipeline",
    since,
    setup: true,
  };
  // The same proposal read again keeps its time and changes nothing Needs you shows.
  if (prev && prev.path === next.path && prev.sessionId === next.sessionId && prev.commit === next.commit && prev.hash === next.hash && prev.branch === next.branch && prev.target === next.target) return;
  reviewCache.set(projectId, next);
  attentionChanged();
}

/** Read the project's Setup chat again for Needs you and the banner (the runtime's tick and moves call it). */
export async function refreshSetupReview(projectId: string): Promise<void> {
  await readSetup(projectId).catch(() => undefined);
}

/** The Setup chat as the tabs read it (GET /api/projects/:pid/setup). */
export async function readSetup(projectId: string): Promise<SetupStatus> {
  const p = readProject(projectId);
  const facts = await contextFacts(projectId, {});
  const rec = setupRecordOf(projectId);
  const setUp = setUpOf(facts.definition, facts.served);
  const cur = stillOpen(rec.current) ? rec.current : null;
  let chat: SetupChatView | null = null;
  let proposal: SetupProposal | null = null;
  if (cur) {
    const { runLive } = await import("./playbook-review");
    const now = await runLive(cur.path);
    const open = now?.working ? null : await openProposal(projectId, cur, facts.target);
    if (open) {
      const wire = await import("../merge-queue/wire");
      const q = await wire.setupTrialsAt(p.root);
      const untried = await wire.setupUntriedAt(p.root, open.read.commit);
      const { changedFilesOf } = await import("../merge-queue/setup-branch");
      const files = (await changedFilesOf(realGit, p.root, facts.target, open.read.commit).catch(() => null)) ?? [];
      proposal = proposalOf(open.read, facts.served, q?.trials ?? [], q?.readRun ?? (() => null), untried, files);
    }
    const state: SetupChatView["state"] = now?.working ? "working" : now?.questions ? "waiting" : proposal ? "proposed" : "idle";
    chat = {
      sessionId: cur.sessionId,
      path: cur.path,
      title: setupTitle(p.root, p.name),
      state,
      ...(now?.questions ? { questions: now.questions } : {}),
      startedAt: cur.startedAt,
      ...(cur.branch ? { branch: cur.branch } : {}),
      proposal,
      setUp,
    };
  }
  noteReview(projectId, cur, proposal, Date.now());
  const can = !p.root ? "This project has no folder." : projectArchived(projectId) ? `${p.name || p.id} is archived. Unarchive it first.` : null;
  return { chat, setUp, can: can ? { open: false, why: can } : { open: true }, history: rec.history };
}

// ---- Merge Branch (POST /api/projects/:pid/setup/merge) --------------------------------------------------

export const NO_SETUP_PROPOSAL = "The Setup chat proposes nothing now.";
export const SETUP_CHANGED_SINCE = "The proposed setup changed since it was shown: look again.";
export const SETUP_BRANCH_MOVED = "The branch has a newer commit than the one shown: look again.";

/** What Merge Branch on the Setup proposal needs from the server (live ones in runtime-routes.ts). */
export interface SetupMergeDeps {
  /** Land through the queue at that commit (the operator's approval); false: the queue doesn't serve the project. */
  land: (projectId: string, root: string, sessionId: string, commit: string) => Promise<boolean>;
  /** Merge the build's worktree into its target (a project the queue doesn't serve). */
  merge: (projectId: string, sessionId: string) => Promise<void>;
}

/**
 * Merge Branch on the Setup chat's proposal, the operator's alone: refused unless `hash` is the head's and `commit`
 * the head; then the land gate (a passing trial of that head). A project the queue serves gets Land: the operator's
 * approval of that exact commit, landed by the queue; never a move of the target here. Otherwise the build's worktree
 * is merged, as Merge Branch on any run. Answers whether it was queued.
 */
export async function mergeSetup(projectId: string, hash: string, commit: string | undefined, deps: SetupMergeDeps): Promise<{ queued: boolean }> {
  const root = readProject(projectId).root;
  const rec = setupRecordOf(projectId);
  const cur = rec.current;
  const target = (await targetOf(root)) ?? "main";
  const open = cur ? await openProposal(projectId, cur, target) : null;
  if (!cur || !open) throw new OrgError(NO_SETUP_PROPOSAL, 409);
  if (!open.read.hash || open.read.hash !== hash) throw new OrgError(SETUP_CHANGED_SINCE, 409);
  if (commit && commit !== open.read.commit) throw new OrgError(SETUP_BRANCH_MOVED, 409);
  const untried = await (await import("../merge-queue/wire")).setupUntriedAt(root, open.read.commit);
  if (untried) throw new OrgError(untried, 409);
  if (await deps.land(projectId, root, cur.run, open.read.commit)) return { queued: true };
  await deps.merge(projectId, cur.run);
  return { queued: false };
}

// ---- open, reopen, Start Fresh ----------------------------------------------------------------------------

export interface OpenSetupInput {
  fresh?: boolean;
  from?: SetupFrom;
  why?: string;
  model?: string;
  thinking?: string;
}

/** What starting needs from the server (the live ones in runtime-routes.ts; tests stand them in). */
export interface SetupDeps {
  /** A coding build on its own worktree and branch, its first message and mode given (never a verb playbook run). */
  startRun: (projectId: string, input: { prompt: string; title: string; model: string; thinking: string }, envelope?: Envelope) => Promise<{ sessionId: string; path: string; worktree?: { path: string; branch: string }; notPrompted?: string; held?: unknown }>;
  /** A plain chat in `cwd` with its first message (carrying on in an earlier chat's folder). */
  startChat: (cwd: string, text: string, title: string, model?: { model: string; thinking?: string }) => Promise<{ id: string; path: string }>;
  /** Archive a chat; a refusal says why. */
  archive: (path: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The chat's turn runs now. */
  working: (path: string) => Promise<boolean>;
  /** Remove a build's empty worktree and its branch (no commits beyond the target). */
  removeEmpty: (projectId: string, sessionId: string, branch: string) => Promise<void>;
  now?: () => number;
}

export const STILL_WORKING = "The Setup chat is working: wait for its turn to end (or stop it), then Start Fresh.";

/**
 * Set Up with a Chat / Change Setup / Start Fresh (POST /api/projects/:pid/setup). The open chat is reopened. Start
 * Fresh archives it. A chat that is archived (or Start Fresh'd) leaves its branch behind: with no commits beyond the
 * target, its empty worktree and branch are removed and a new chat starts on a fresh branch; with commits, a new chat
 * carries on in its folder on that branch, and its proposal stays. Never refused as already running.
 */
export async function openSetup(projectId: string, input: OpenSetupInput, deps: SetupDeps, envelope?: Envelope): Promise<SetupOpened> {
  const p = readProject(projectId);
  if (projectArchived(projectId)) throw new OrgError(`${p.name || p.id} is archived. Unarchive it first.`, 409);
  const iso = () => new Date(deps.now?.() ?? Date.now()).toISOString();
  const rec = setupRecordOf(projectId);
  const cur = stillOpen(rec.current) ? rec.current : undefined;
  if (cur && !input.fresh) return { sessionId: cur.sessionId, path: cur.path, reopened: true, ...(cur.worktree && cur.branch ? { worktree: { path: cur.worktree, branch: cur.branch } } : {}) };
  const old = rec.current;
  if (cur && input.fresh) {
    if (await deps.working(cur.path)) throw new OrgError(STILL_WORKING, 409);
    const a = await deps.archive(cur.path);
    if (!a.ok) throw new OrgError(`The Setup chat couldn't be archived: ${a.error}`, 409);
  }
  if (old) {
    rec.history.push({ sessionId: old.sessionId, path: old.path, startedAt: old.startedAt, endedAt: iso(), why: cur && input.fresh ? "fresh" : "ended", ...(old.branch ? { branch: old.branch } : {}) });
    delete rec.current;
  }
  saveRecord(projectId, rec);
  const target = (await targetOf(p.root)) ?? "main";
  const st = old?.branch ? await branchStateOf(p.root, old.branch, target) : null;
  const title = setupTitle(p.root, p.name);
  const { onboardStart } = await import("./onboard");
  const startOf = async (carryOn?: SetupContextFacts["carryOn"]) => {
    const facts = await contextFacts(projectId, { ...(carryOn ? { carryOn } : {}), ...(input.why ? { why: input.why } : {}), ...(input.from ? { from: input.from } : {}) });
    const start = await onboardStart(projectId, { playbook: SETUP_PLAYBOOK_ID, context: setupContext(facts), title, ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) });
    if (start.invalid) throw new OrgError(start.invalid, 409);
    return start;
  };
  // The earlier chat's branch has commits and its folder is there: the new chat carries on in it; the proposal stays.
  if (old && st && st.ahead > 0 && old.worktree && existsSync(old.worktree)) {
    const start = await startOf({ ...(old.branch ? { branch: old.branch } : {}), worktree: old.worktree, from: old.path });
    const made = await deps.startChat(old.worktree, start.prompt, title, { model: start.model, thinking: start.thinking });
    const next: SetupCurrent = { sessionId: made.id, path: made.path, startedAt: iso(), run: old.run, ...(old.branch ? { branch: old.branch } : {}), worktree: old.worktree };
    saveRecord(projectId, { current: next, history: setupRecordOf(projectId).history });
    return { sessionId: made.id, path: made.path, reopened: false, worktree: { path: old.worktree, branch: old.branch ?? "" } };
  }
  // No commits beyond the target: its empty worktree and branch go (nothing is lost), and a new chat starts.
  if (old?.branch && st && st.ahead === 0) await deps.removeEmpty(projectId, old.run, old.branch).catch(() => undefined);
  const start = await startOf();
  const made = await deps.startRun(projectId, { prompt: start.prompt, title, model: start.model, thinking: start.thinking }, envelope);
  if (made.held || !made.sessionId || !made.path) throw new OrgError("The Setup chat didn't start.", 409);
  const next: SetupCurrent = { sessionId: made.sessionId, path: made.path, startedAt: iso(), run: made.sessionId, ...(made.worktree ? { branch: made.worktree.branch, worktree: made.worktree.path } : {}) };
  saveRecord(projectId, { current: next, history: setupRecordOf(projectId).history });
  return { sessionId: made.sessionId, path: made.path, reopened: false, ...(made.worktree ? { worktree: made.worktree } : {}) };
}

/** Tests: the record file. */
export const setupRecordFileForTest = recordFile;
