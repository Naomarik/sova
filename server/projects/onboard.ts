import { existsSync } from "node:fs";
import { linkedPlaybook, playbookTurnText } from "../../shared/playbooks";
import type { PlaybookInfo } from "../../shared/protocol";
import { defaultRemoteOf } from "../files";
import { listModels } from "../models";
import { listPlaybooks } from "../playbooks";
import { claudeCodeProviderEnabled } from "../web-settings";
import { readProject } from "./spaces";

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
/** The default, then the fallback when this host offers no credentials for the default. */
export const ONBOARD_MODEL: ModelChoice = { model: "claude-code-cli/opus", thinking: "medium" };
export const ONBOARD_FALLBACK: ModelChoice = { model: "openai-codex/gpt-6-astra", thinking: "medium" };

/**
 * The run's model: the one asked for (thinking as asked, else medium), else the default, else the
 * fallback when `offered` (the refs this host offers with credentials) is known and lacks the
 * default but has the fallback. Unknown offers keep the default: the session's open says if it
 * can't take it. Pure.
 */
export function onboardModel(input: { model?: string | null; thinking?: string | null }, offered: readonly string[] | null): ModelChoice {
  const asked = input.model?.trim();
  if (asked) return { model: asked, thinking: input.thinking?.trim() || "medium" };
  if (offered && !offered.includes(ONBOARD_MODEL.model) && offered.includes(ONBOARD_FALLBACK.model)) return { ...ONBOARD_FALLBACK };
  return { ...ONBOARD_MODEL };
}

/** What the host knows about a project before starting the playbook on it. */
export interface OnboardFacts {
  name: string;
  root: string;
  /** The target the root lives on, when it is a remote placeholder. */
  remote: string | null;
  rootExists: boolean;
  playbook: Pick<PlaybookInfo, "title" | "dir" | "body"> | null;
}

/** The host's refusal sentence, or null when the playbook can start. Pure. */
export function onboardInvalid(f: OnboardFacts): string | null {
  if (f.remote) return `${f.name}'s folder is on ${f.remote}: the playbook runs only on a local folder.`;
  if (!f.rootExists) return `${f.name}'s folder ${f.root} is missing on this host.`;
  if (!f.playbook) return `No playbook "${ONBOARD_PLAYBOOK_ID}" is listed for ${f.name}.`;
  return null;
}

export const onboardTitle = (name: string) => `Project verbs: ${name}`;

export interface OnboardStart {
  prompt: string;
  title: string;
  model: string;
  thinking: string;
  /** Set when the host refuses: nothing may start. */
  invalid?: string;
}

/** The facts for `projectId`, read on this host. */
export async function onboardFacts(projectId: string): Promise<OnboardFacts> {
  const p = readProject(projectId);
  const remote = defaultRemoteOf(p.root);
  const local = !remote && !!p.root;
  const catalog = local && existsSync(p.root) ? await listPlaybooks(p.root) : null;
  return {
    name: p.name || p.id,
    root: p.root,
    remote: remote ? remote.target : null,
    rootExists: local && existsSync(p.root),
    playbook: catalog ? linkedPlaybook(catalog.playbooks, ONBOARD_PLAYBOOK_ID, "sova") : null,
  };
}

/**
 * The refs this host offers with credentials. Claude Code's models register per session runtime, so a
 * server that opened none yet lists none: the Claude Code switch (Settings → Experimental) is what
 * offers the default. Null: unknown (the default is kept).
 */
async function offeredRefs(): Promise<string[] | null> {
  try {
    const refs = (await listModels()).map((m) => m.ref);
    return claudeCodeProviderEnabled() ? [...refs, ONBOARD_MODEL.model] : refs;
  } catch {
    return null;
  }
}

/** The run's first prompt, title and model from the facts, or why it can't start. Pure. */
export function onboardStartFrom(facts: OnboardFacts, input: { why?: string | null; model?: string | null; thinking?: string | null }, offered: readonly string[] | null): OnboardStart {
  const choice = onboardModel(input, offered);
  const title = onboardTitle(facts.name);
  const invalid = onboardInvalid(facts);
  if (invalid || !facts.playbook) return { prompt: "", title, ...choice, invalid: invalid ?? "" };
  return { prompt: playbookTurnText(facts.playbook, input.why ?? ""), title, ...choice };
}

/** The first prompt, title and model of a Project verbs run on `projectId`, or why it can't start. */
export async function onboardStart(projectId: string, input: { why?: string | null; model?: string | null; thinking?: string | null } = {}): Promise<OnboardStart> {
  return onboardStartFrom(await onboardFacts(projectId), input, input.model?.trim() ? null : await offeredRefs());
}
