import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MergeRun, MergeTrial } from "../../shared/merge-queue";
import { CONTRACT_FILE } from "../../shared/project-contract";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import type { SetupChatView, SetupHistoryItem, SetupOpened, SetupProposal, SetupState, SetupStatus, SetupTrial, SetupTrialCheck } from "../../shared/setup-chat";
import { isArchived } from "../archived-sessions";
import { OrgError } from "../org-error";
import type { Envelope } from "../org-envelope";
import { realGit } from "../project-services/engine";
import { stateRoot } from "../state-root";
import { SETUP_PLAYBOOK_ID } from "./onboard";
import { readProject } from "./spaces";

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

/** The proposal from the runtime's run review and the queue's trials. Pure. */
export function proposalOf(view: ProjectRuntimeView, served: boolean, trials: readonly MergeTrial[], readRun: (id: string) => MergeRun | null, untried: string | null, files: SetupProposal["files"] = []): SetupProposal | null {
  const pb = view.playbook;
  if (!pb || view.playbookState !== "proposed" || pb.proposes !== "pipeline" || !pb.branch || !pb.commit) return null;
  const r = pb.review;
  const t = trials.find((x) => x.commit === pb.commit);
  const trial = t ? trialView(t, readRun(t.run)) : null;
  const problem = r?.def.state === "invalid" ? r.def.error : r?.def.state === "absent" ? `${pb.branch} has no ${CONTRACT_FILE}` : r?.release?.problem;
  const why = !pb.branchHash ? (problem ?? "its branch has no valid setup") : untried;
  return {
    branch: pb.branch,
    target: pb.target ?? "main",
    commit: pb.commit,
    served,
    ...(pb.branchHash ? { hash: pb.branchHash } : {}),
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

/** The Setup chat as the tabs read it (GET /api/projects/:pid/setup). */
export async function readSetup(projectId: string): Promise<SetupStatus> {
  const p = readProject(projectId);
  const { readRuntime } = await import("./runtime");
  const view = await readRuntime(projectId);
  const facts = await contextFacts(projectId, {});
  const rec = setupRecordOf(projectId);
  const setUp = setUpOf(facts.definition, facts.served);
  const cur = stillOpen(rec.current) ? rec.current : null;
  const can = p.root ? cannotOpen(projectId, view) : "This project has no folder.";
  let chat: SetupChatView | null = null;
  if (cur) {
    const pb = view.playbook && view.playbook.sessionId === cur.run && view.playbook.playbookId === SETUP_PLAYBOOK_ID ? view.playbook : null;
    const live = pb && view.playbookState !== "idle" ? view.playbookState : "idle";
    const { runLive } = await import("./playbook-review");
    const now = await runLive(cur.path);
    let proposal: SetupProposal | null = null;
    if (pb && live === "proposed") {
      const q = await (await import("../merge-queue/wire")).setupTrialsAt(p.root);
      const untried = pb.commit ? await (await import("../merge-queue/wire")).setupUntriedAt(p.root, pb.commit) : null;
      const { changedFilesOf } = await import("../merge-queue/setup-branch");
      const files = pb.commit ? ((await changedFilesOf(realGit, p.root, pb.target ?? facts.target, pb.commit).catch(() => null)) ?? []) : [];
      proposal = proposalOf(view, facts.served, q?.trials ?? [], q?.readRun ?? (() => null), untried, files);
    }
    // A standing run between turns reads "running" in the registry: what its session does now decides working or idle.
    const state: SetupChatView["state"] = now?.working ? "working" : now?.questions ? "waiting" : live === "proposed" ? "proposed" : live === "waiting" ? "waiting" : live === "running" && !now ? "working" : "idle";
    chat = {
      sessionId: cur.sessionId,
      path: cur.path,
      title: setupTitle(p.root, p.name),
      state,
      ...(now?.questions ? { questions: now.questions } : {}),
      startedAt: cur.startedAt,
      ...((pb?.branch ?? cur.branch) ? { branch: pb?.branch ?? cur.branch } : {}),
      proposal,
      setUp,
    };
  }
  return { chat, setUp, can: chat || !can ? { open: true } : { open: false, why: can }, history: rec.history };
}

/** Why a new Setup chat can't start (an archived project, or another playbook run is live), or null. */
function cannotOpen(projectId: string, view: ProjectRuntimeView): string | null {
  if (view.can.onboard) return null;
  return view.can.onboardWhy ?? null;
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
  /** A verb playbook run (startOnboard). */
  startRun: (projectId: string, input: { playbook: string; context: string; title: string; why?: string; model?: string; thinking?: string }, envelope?: Envelope) => Promise<{ sessionId: string; path: string; worktree?: { path: string; branch: string }; notPrompted?: string; held?: unknown }>;
  /** A plain chat in `cwd` with its first message (Start Fresh carrying on in the earlier run's folder). */
  startChat: (cwd: string, text: string, title: string, model?: { model: string; thinking?: string }) => Promise<{ id: string; path: string }>;
  /** Archive a chat; a refusal says why. */
  archive: (path: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The chat's turn runs now. */
  working: (path: string) => Promise<boolean>;
  /** The runtime's playbook run now. */
  runtime: (projectId: string) => Promise<ProjectRuntimeView>;
  now?: () => number;
}

export const STILL_WORKING = "The Setup chat is working: wait for its turn to end (or stop it), then Start Fresh.";

/** Set Up with a Chat / Change Setup / Start Fresh (POST /api/projects/:pid/setup). */
export async function openSetup(projectId: string, input: OpenSetupInput, deps: SetupDeps, envelope?: Envelope): Promise<SetupOpened> {
  const p = readProject(projectId);
  const iso = () => new Date(deps.now?.() ?? Date.now()).toISOString();
  const rec = setupRecordOf(projectId);
  const cur = stillOpen(rec.current) ? rec.current : undefined;
  if (cur && !input.fresh) return { sessionId: cur.sessionId, path: cur.path, reopened: true, ...(cur.worktree && cur.branch ? { worktree: { path: cur.worktree, branch: cur.branch } } : {}) };
  const view = await deps.runtime(projectId);
  const pb = view.playbook;
  // The run this chat carries, while its proposal (or its questions, or its turn) is still open.
  const liveRun = cur && pb && pb.sessionId === cur.run && view.playbookState !== "idle" ? pb : null;
  if (cur && input.fresh) {
    if (await deps.working(cur.path)) throw new OrgError(STILL_WORKING, 409);
    const a = await deps.archive(cur.path);
    if (!a.ok) throw new OrgError(`The Setup chat couldn't be archived: ${a.error}`, 409);
    rec.history.push({ sessionId: cur.sessionId, path: cur.path, startedAt: cur.startedAt, endedAt: iso(), why: "fresh", ...(cur.branch ? { branch: cur.branch } : {}) });
    delete rec.current;
  } else if (rec.current) {
    // The recorded chat was archived or removed: it is history now.
    const old = rec.current;
    rec.history.push({ sessionId: old.sessionId, path: old.path, startedAt: old.startedAt, endedAt: iso(), why: "ended", ...(old.branch ? { branch: old.branch } : {}) });
    delete rec.current;
  }
  saveRecord(projectId, rec);
  const title = setupTitle(p.root, p.name);
  const model = input.model ? { model: input.model, ...(input.thinking ? { thinking: input.thinking } : {}) } : undefined;
  if (liveRun && cur?.worktree) {
    // Start Fresh with a proposal open: the new chat carries on in its folder and branch; the proposal stays the run's.
    const facts = await contextFacts(projectId, { carryOn: { ...(cur.branch ? { branch: cur.branch } : {}), worktree: cur.worktree, from: cur.path }, ...(input.why ? { why: input.why } : {}), ...(input.from ? { from: input.from } : {}) });
    const { onboardStart } = await import("./onboard");
    const start = await onboardStart(projectId, { playbook: SETUP_PLAYBOOK_ID, context: setupContext(facts), title, ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) });
    if (start.invalid) throw new OrgError(start.invalid, 409);
    const made = await deps.startChat(cur.worktree, start.prompt, title, model ?? { model: start.model, thinking: start.thinking });
    const next: SetupCurrent = { sessionId: made.id, path: made.path, startedAt: iso(), run: cur.run, ...(cur.branch ? { branch: cur.branch } : {}), worktree: cur.worktree };
    saveRecord(projectId, { current: next, history: setupRecordOf(projectId).history });
    return { sessionId: made.id, path: made.path, reopened: false, worktree: { path: cur.worktree, branch: cur.branch ?? "" } };
  }
  const facts = await contextFacts(projectId, { ...(input.why ? { why: input.why } : {}), ...(input.from ? { from: input.from } : {}) });
  const made = await deps.startRun(projectId, { playbook: SETUP_PLAYBOOK_ID, context: setupContext(facts), title, ...(input.why ? { why: input.why } : {}), ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) }, envelope);
  if (made.held || !made.sessionId || !made.path) throw new OrgError("The Setup chat didn't start.", 409);
  const next: SetupCurrent = { sessionId: made.sessionId, path: made.path, startedAt: iso(), run: made.sessionId, ...(made.worktree ? { branch: made.worktree.branch, worktree: made.worktree.path } : {}) };
  saveRecord(projectId, { current: next, history: setupRecordOf(projectId).history });
  return { sessionId: made.sessionId, path: made.path, reopened: false, ...(made.worktree ? { worktree: made.worktree } : {}) };
}

/** Tests: the record file. */
export const setupRecordFileForTest = recordFile;
