import { existsSync } from "node:fs";
import { linkedPlaybook, playbookTurnText } from "../../shared/playbooks";
import type { PlaybookInfo, PlaybookProposes } from "../../shared/protocol";
import type { ProjectCodingMode } from "../../shared/project-overseer";
import { defaultRemoteOf } from "../files";
import { listModels } from "../models";
import { FOLDED_SETUP_PLAYBOOKS, listPlaybooks } from "../playbooks";
import { OrgError } from "../org-error";
import { readProject } from "./spaces";
import { gitRootOf, NOT_GIT } from "../project-worktrees";
import { latestClaude } from "../../pi-config/extensions/claude-code/catalog.ts";

/**
 * What the project act `verbs/onboard` starts (§app.project-runtime/onboard): the Project verbs
 * playbook (`system-playbooks/project-verbs`, §app.project-runtime/playbook) as a coding session's first
 * prompt, its title and model, and the host's refusals. The act, its route and the live-run check
 * are the runtime's (server/projects/runtime*.ts); this module only reads.
 */

export const ONBOARD_PLAYBOOK_ID = "project-verbs";
/** The Setup chat's playbook (§app.project-setup/chat): it proposes the whole pipeline. */
export const SETUP_PLAYBOOK_ID = "project-setup";
/** The setup playbooks folded into the Setup chat: a start by their id opens the Setup chat (old ids still resolve). */
export const FOLDED_PLAYBOOKS: readonly string[] = FOLDED_SETUP_PLAYBOOKS;
/** The Setup chat's mode: normal with align and vis (it draws the plan with vis fences and vis_guide), spec off and
    nothing else, whatever this host's coding default adds. Its work is the project's pipeline settings, configuration
    rather than a product change, so never Sova's spec procedure for the project. */
export const SETUP_MODE = { mode: "normal", minorModes: ["align", "vis"] } as const;

/** The mode a verb playbook run of `playbookId` is pinned to: the Setup chat's; undefined (every other run): the
    host's coding default, with align added (project-coding-mode.ts playbookRunMode). Pure. */
export const onboardRunMode = (playbookId: string): ProjectCodingMode | undefined =>
  playbookId === SETUP_PLAYBOOK_ID ? { mode: SETUP_MODE.mode, minorModes: [...SETUP_MODE.minorModes] } : undefined;

/** The playbook a start by `id` runs: a folded one's is the Setup chat's. Pure. */
export const resolvePlaybookId = (id: string): string => (FOLDED_PLAYBOOKS.includes(id) ? SETUP_PLAYBOOK_ID : id);

export interface ModelChoice {
  model: string;
  thinking: string;
}
/** The run's models in order of preference, each at medium: the Claude catalog's current Opus through Claude Code, then the fallback. */
export const onboardModels = (): readonly string[] => [`claude-code-cli/${latestClaude("opus").id}`, "openai-codex/gpt-6-astra"];
export const ONBOARD_THINKING = "medium";

export const noOnboardModel = (): string =>
  `No model for the Project verbs playbook: this host offers neither Claude Code ${latestClaude("opus").name} nor openai-codex gpt-6-astra. Pick a model to run it with.`;

/**
 * The run's model: the one asked for (thinking as asked, else medium); else the first of
 * onboardModels() that `offered` (the refs this host's model picker lists) has, at medium. Never a
 * ref outside `offered`: null when it has none of them or is unknown (null). Pure.
 */
export function onboardModel(input: { model?: string | null; thinking?: string | null }, offered: readonly string[] | null): ModelChoice | null {
  const asked = input.model?.trim();
  if (asked) return { model: asked, thinking: input.thinking?.trim() || ONBOARD_THINKING };
  const pick = offered ? onboardModels().find((m) => offered.includes(m)) : undefined;
  return pick ? { model: pick, thinking: ONBOARD_THINKING } : null;
}

/** What the host knows about a project before starting the playbook on it. */
export interface OnboardFacts {
  name: string;
  root: string;
  /** The target the root lives on, when it is a remote placeholder. */
  remote: string | null;
  rootExists: boolean;
  /** The verb playbook asked for (default project-verbs). */
  playbookId?: string;
  playbook: Pick<PlaybookInfo, "title" | "dir" | "body" | "proposes"> | null;
  /** project-verbs only: why its folder can't hold a branch (server/project-worktrees.ts gitRootOf's tail); absent: it can. */
  noGit?: string;
}

/** The no-Git refusal of the Project verbs playbook: running copies are set up on a branch. Pure. */
export const noGitWhy = (name: string, tail: string): string => `Running copies are set up on a branch: ${tail === NOT_GIT ? `${name}'s folder isn't a Git repository.` : tail}`;

/** The host's refusal sentence, or null when the playbook can start. Pure. */
export function onboardInvalid(f: OnboardFacts): string | null {
  if (f.remote) return `${f.name}'s folder is on ${f.remote}: the playbook runs only on a local folder.`;
  if (!f.rootExists) return `${f.name}'s folder ${f.root} is missing on this host.`;
  const id = f.playbookId ?? ONBOARD_PLAYBOOK_ID;
  if (id === ONBOARD_PLAYBOOK_ID && f.noGit) return noGitWhy(f.name, f.noGit);
  if (!f.playbook) return `No playbook "${id}" is listed for ${f.name}.`;
  if (!f.playbook.proposes) return `${id} is not a verb playbook: its PLAYBOOK.md says no proposes:.`;
  return null;
}

export const onboardTitle = (name: string, label = "Project verbs") => `${label}: ${name}`;

export interface OnboardStart {
  prompt: string;
  title: string;
  model: string;
  thinking: string;
  /** The verb playbook the run is keyed by (§app.project-runtime/verb-playbooks): its id, title and what it proposes. */
  playbookId: string;
  label: string;
  proposes: PlaybookProposes;
  /** Set when the host refuses: nothing may start. */
  invalid?: string;
}

/** The facts for `projectId`, read on this host. */
export async function onboardFacts(projectId: string, playbookId = ONBOARD_PLAYBOOK_ID): Promise<OnboardFacts> {
  const p = readProject(projectId);
  const remote = defaultRemoteOf(p.root);
  const local = !remote && !!p.root;
  const catalog = local && existsSync(p.root) ? await listPlaybooks(p.root, { includeUnlisted: true }) : null;
  // Only the Project verbs playbook needs a branch to work on (never the Setup chat, deploy or release).
  const repo = playbookId === ONBOARD_PLAYBOOK_ID && local && existsSync(p.root) ? await gitRootOf(p.root) : null;
  return {
    ...(repo && "reason" in repo ? { noGit: repo.reason } : {}),
    name: p.name || p.id,
    root: p.root,
    remote: remote ? remote.target : null,
    rootExists: local && existsSync(p.root),
    playbookId,
    playbook: catalog ? linkedPlaybook(catalog.playbooks, playbookId, "sova") : null,
  };
}

let offeredForTest: (() => Promise<string[] | null>) | null = null;
/** Tests: what this host's model picker lists (null: the real list again). */
export function setOfferedRefsForTest(f: (() => Promise<string[] | null>) | null): void {
  offeredForTest = f;
  refusalMemo.clear();
}

/** The refs this host's model picker lists (credentials configured); null when they can't be read. */
async function offeredRefs(): Promise<string[] | null> {
  if (offeredForTest) return offeredForTest();
  try {
    return (await listModels()).map((m) => m.ref);
  } catch {
    return null;
  }
}

/** Why a start with these facts and this model choice is refused, or null: the host's refusal, else no model. The one
    rule a press and the setup line's reason read (onboardRefusal). Pure. */
export const startRefusal = (facts: OnboardFacts, choice: ModelChoice | null): string | null => onboardInvalid(facts) ?? (choice ? null : noOnboardModel());

/** Why a start of the playbook on `projectId` would be refused now, or null: the same sentence a press answers
    (onboardStart), read before any press for the setup line. */
export async function onboardRefusal(projectId: string, input: { model?: string | null; thinking?: string | null; playbook?: string | null } = {}): Promise<string | null> {
  const id = resolvePlaybookId(input.playbook?.trim() || ONBOARD_PLAYBOOK_ID);
  const facts = await onboardFacts(projectId, id);
  return startRefusal(facts, onboardModel(input, input.model?.trim() ? null : await offeredRefs()));
}

/** How long the setup line's reason is kept: the registry is read on every poll, and the reason lists this host's
    models and asks Git for the folder's repository. A press always reads it fresh (onboardStart). */
export const ONBOARD_REFUSAL_TTL_MS = 10_000;
const refusalMemo = new Map<string, { at: number; why: Promise<string | null> }>();

/** onboardRefusal(projectId) as the setup line reads it, the same answer kept for ONBOARD_REFUSAL_TTL_MS (one read in
    flight is shared; a failed read is not kept). */
export function onboardRefusalCached(projectId: string, now: number = Date.now()): Promise<string | null> {
  const hit = refusalMemo.get(projectId);
  if (hit && now - hit.at < ONBOARD_REFUSAL_TTL_MS) return hit.why;
  const why = onboardRefusal(projectId);
  refusalMemo.set(projectId, { at: now, why });
  why.catch(() => {
    if (refusalMemo.get(projectId)?.why === why) refusalMemo.delete(projectId);
  });
  return why;
}

/** The run's first prompt, title and model from the facts, or why it can't start. Pure. */
export function onboardStartFrom(facts: OnboardFacts, input: { why?: string | null; model?: string | null; thinking?: string | null; context?: string | null; title?: string | null }, offered: readonly string[] | null): OnboardStart {
  const choice = onboardModel(input, offered);
  const label = facts.playbook?.title || "Project verbs";
  const who = { playbookId: facts.playbookId ?? ONBOARD_PLAYBOOK_ID, label, proposes: facts.playbook?.proposes ?? "definition" };
  const title = input.title?.trim() || onboardTitle(facts.name, label);
  const invalid = startRefusal(facts, choice);
  if (invalid || !facts.playbook || !choice) return { prompt: "", title, model: choice?.model ?? "", thinking: choice?.thinking ?? ONBOARD_THINKING, ...who, invalid: invalid ?? "" };
  // The host's own context (the Setup chat's project, current setup and earlier chats) follows the playbook's turn.
  const turn = playbookTurnText(facts.playbook, input.context?.trim() ? "" : (input.why ?? ""));
  return { prompt: input.context?.trim() ? `${turn}\n---\n\n${input.context.trim()}\n` : turn, title, ...choice, ...who };
}

/** The first prompt, title and model of a Project verbs run on `projectId`, or why it can't start. */
export async function onboardStart(projectId: string, input: { why?: string | null; model?: string | null; thinking?: string | null; playbook?: string | null; context?: string | null; title?: string | null } = {}): Promise<OnboardStart> {
  const id = resolvePlaybookId(input.playbook?.trim() || ONBOARD_PLAYBOOK_ID);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new OrgError(`No playbook "${id}": a playbook id is lower case letters, digits and hyphens.`, 400);
  return onboardStartFrom(await onboardFacts(projectId, id), input, input.model?.trim() ? null : await offeredRefs());
}
