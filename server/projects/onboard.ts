import { existsSync } from "node:fs";
import { linkedPlaybook, playbookTurnText } from "../../shared/playbooks";
import type { PlaybookInfo } from "../../shared/protocol";
import { defaultRemoteOf } from "../files";
import { listModels } from "../models";
import { listPlaybooks } from "../playbooks";
import { OrgError } from "../org-error";
import { readProject } from "./spaces";
import { latestClaude } from "../../pi-config/extensions/claude-code/catalog.ts";

/**
 * What the project act `verbs/onboard` starts (§app.project-runtime/onboard): the Project verbs
 * playbook (`playbooks/project-verbs`, §app.project-runtime/playbook) as a coding session's first
 * prompt, its title and model, and the host's refusals. The act, its route and the live-run check
 * are the runtime's (server/projects/runtime*.ts); this module only reads.
 */

export const ONBOARD_PLAYBOOK_ID = "project-verbs";

export interface ModelChoice {
  model: string;
  thinking: string;
}
/** The run's models in order of preference, each at medium: the Claude catalog's current Opus through Claude Code, then the fallback. */
export const ONBOARD_MODELS: readonly string[] = [`claude-code-cli/${latestClaude("opus").id}`, "openai-codex/gpt-6-astra"];
export const ONBOARD_THINKING = "medium";

export const NO_ONBOARD_MODEL =
  `No model for the Project verbs playbook: this host offers neither Claude Code ${latestClaude("opus").name} nor openai-codex gpt-6-astra. Pick a model to run it with.`;

/**
 * The run's model: the one asked for (thinking as asked, else medium); else the first of
 * ONBOARD_MODELS that `offered` (the refs this host's model picker lists) has, at medium. Never a
 * ref outside `offered`: null when it has none of them or is unknown (null). Pure.
 */
export function onboardModel(input: { model?: string | null; thinking?: string | null }, offered: readonly string[] | null): ModelChoice | null {
  const asked = input.model?.trim();
  if (asked) return { model: asked, thinking: input.thinking?.trim() || ONBOARD_THINKING };
  const pick = offered ? ONBOARD_MODELS.find((m) => offered.includes(m)) : undefined;
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
}

/** The host's refusal sentence, or null when the playbook can start. Pure. */
export function onboardInvalid(f: OnboardFacts): string | null {
  if (f.remote) return `${f.name}'s folder is on ${f.remote}: the playbook runs only on a local folder.`;
  if (!f.rootExists) return `${f.name}'s folder ${f.root} is missing on this host.`;
  const id = f.playbookId ?? ONBOARD_PLAYBOOK_ID;
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
  proposes: "definition" | "deploy";
  /** Set when the host refuses: nothing may start. */
  invalid?: string;
}

/** The facts for `projectId`, read on this host. */
export async function onboardFacts(projectId: string, playbookId = ONBOARD_PLAYBOOK_ID): Promise<OnboardFacts> {
  const p = readProject(projectId);
  const remote = defaultRemoteOf(p.root);
  const local = !remote && !!p.root;
  const catalog = local && existsSync(p.root) ? await listPlaybooks(p.root) : null;
  return {
    name: p.name || p.id,
    root: p.root,
    remote: remote ? remote.target : null,
    rootExists: local && existsSync(p.root),
    playbookId,
    playbook: catalog ? linkedPlaybook(catalog.playbooks, playbookId, "sova") : null,
  };
}

/** The refs this host's model picker lists (credentials configured); null when they can't be read. */
async function offeredRefs(): Promise<string[] | null> {
  try {
    return (await listModels()).map((m) => m.ref);
  } catch {
    return null;
  }
}

/** The run's first prompt, title and model from the facts, or why it can't start. Pure. */
export function onboardStartFrom(facts: OnboardFacts, input: { why?: string | null; model?: string | null; thinking?: string | null }, offered: readonly string[] | null): OnboardStart {
  const choice = onboardModel(input, offered);
  const label = facts.playbook?.title || "Project verbs";
  const who = { playbookId: facts.playbookId ?? ONBOARD_PLAYBOOK_ID, label, proposes: facts.playbook?.proposes ?? "definition" };
  const title = onboardTitle(facts.name, label);
  const invalid = onboardInvalid(facts) ?? (choice ? null : NO_ONBOARD_MODEL);
  if (invalid || !facts.playbook || !choice) return { prompt: "", title, model: choice?.model ?? "", thinking: choice?.thinking ?? ONBOARD_THINKING, ...who, invalid: invalid ?? "" };
  return { prompt: playbookTurnText(facts.playbook, input.why ?? ""), title, ...choice, ...who };
}

/** The first prompt, title and model of a Project verbs run on `projectId`, or why it can't start. */
export async function onboardStart(projectId: string, input: { why?: string | null; model?: string | null; thinking?: string | null; playbook?: string | null } = {}): Promise<OnboardStart> {
  const id = input.playbook?.trim() || ONBOARD_PLAYBOOK_ID;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new OrgError(`No playbook "${id}": a playbook id is lower case letters, digits and hyphens.`, 400);
  return onboardStartFrom(await onboardFacts(projectId, id), input, input.model?.trim() ? null : await offeredRefs());
}
