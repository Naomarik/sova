// What a playbook card needs from this computer: which
// models can run here now (Settings → Models, sign-ins), their names, your profile's model per kind of work,
// the team defaults, the playbook's own pages, and your saved answers. Read fresh for every card drawn.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findCommand } from "../../shared/commands-catalog";
import { checkInputValue, inputValueText, MAIN_ROLE, type InputValue, type PlaybookSpec } from "../../shared/playbook-format";
import { resolveRoleModel } from "../../shared/playbook-models";
import { THINKING_LEVELS } from "../../shared/profiles";
import type { PlaybookInfo, WorkerChoice } from "../../shared/protocol";
import { resolveSubagents } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { chatHandle } from "../chat-handle";
import { workerDenial } from "../delegate";
import { modelDenial, readModelPolicy } from "../model-policy";
import { CLAUDE_CODE_PROVIDER, listModels, modelNames } from "../models";
import { bundleFile } from "../playbook-payload";
import { listPlaybooks } from "../playbooks";
import { agentRoot } from "../state-root";
import type { CardEnv } from "./plan";
import type { PlaybookRef } from "./store";

/** A worker's model as a chat names it: Claude Code's are "claude-code-cli/<id>". */
export const chatRefOf = (c: Pick<WorkerChoice, "backend" | "model">): string => (c.backend === "claude-code" ? `${CLAUDE_CODE_PROVIDER}/${c.model}` : c.model);
/** A chat's model ref as a worker choice. */
export function choiceOfChatRef(ref: string, effort = ""): WorkerChoice {
  const slash = ref.indexOf("/");
  return ref.slice(0, slash) === CLAUDE_CODE_PROVIDER ? { backend: "claude-code", model: ref.slice(slash + 1), effort } : { backend: "pi", model: ref, effort };
}

export interface LoadedPlaybook {
  info: PlaybookInfo;
  spec: PlaybookSpec | null;
  error?: string;
}

/** A playbook by source and id, as the folder `cwd` lists it (unlisted ones included: Sova's own chats start them). */
export async function loadPlaybook(ref: { source: string; id: string }, cwd: string): Promise<LoadedPlaybook | null> {
  const catalog = await listPlaybooks(cwd || undefined, { includeUnlisted: true });
  const info = catalog.playbooks.find((p) => p.source === ref.source && p.id === ref.id);
  if (!info) return null;
  return { info, spec: info.spec ?? null, ...(info.specError ? { error: info.specError } : {}) };
}

export const refOf = (info: PlaybookInfo): PlaybookRef => ({ source: info.source, id: info.id, dir: info.dir, entry: info.entry, title: info.title });

/** Each role's prompt page as written; main's is the recipe page's body. */
export function readPrompts(spec: PlaybookSpec, info: Pick<PlaybookInfo, "dir" | "body">): Record<string, string | { error: string }> {
  const out: Record<string, string | { error: string }> = {};
  for (const role of spec.roles) {
    if (!role.prompt) {
      out[role.id] = role.id === MAIN_ROLE ? info.body : { error: "no prompt page" };
      continue;
    }
    const f = bundleFile(info.dir, role.prompt);
    out[role.id] = "text" in f ? f.text : { error: f.error };
  }
  return out;
}

/** The live environment: read once per card drawn (one model list, one policy read). */
export async function liveEnv(spec: PlaybookSpec, info: PlaybookInfo, chatPath?: string): Promise<CardEnv> {
  const policy = readModelPolicy();
  const [known, names] = await Promise.all([listModels().catch(() => null), modelNames()]);
  const signedIn = known ? new Set(known.map((m) => m.ref)) : null;
  const denial = (c: WorkerChoice, as: "main" | "helper"): string | null => {
    const ref = chatRefOf(c);
    const off = as === "main" ? modelDenial(policy, ref) : workerDenial(policy, c.backend, c.model);
    if (off) return off;
    if (signedIn && !signedIn.has(ref)) return `${c.model} isn't signed in on this computer`;
    return null;
  };
  // An effort the model doesn't take moves to the nearest one it does (a model with no levels: "off").
  const levels = new Map((known ?? []).map((m) => [m.ref, m.thinkingLevels]));
  const clampEffort = (c: WorkerChoice): WorkerChoice => {
    const have = levels.get(chatRefOf(c));
    if (!have?.length || !c.effort || have.includes(c.effort)) return c;
    const at = THINKING_LEVELS.indexOf(c.effort as (typeof THINKING_LEVELS)[number]);
    const near = [...have].sort((a, b) => Math.abs(THINKING_LEVELS.indexOf(a as (typeof THINKING_LEVELS)[number]) - at) - Math.abs(THINKING_LEVELS.indexOf(b as (typeof THINKING_LEVELS)[number]) - at))[0]!;
    return { ...c, effort: near };
  };
  const name = (c: WorkerChoice) => {
    const ref = chatRefOf(c);
    return { label: names.get(ref) ?? c.model.replace(/^.*\//, ""), provider: ref.slice(0, Math.max(0, ref.indexOf("/"))) };
  };
  const resolved = resolveSubagents(agentRoot(), undefined);
  const routes = resolved.delegate?.profiles ?? null;
  const held = chatPath ? chatHandle(chatPath) : undefined;
  const chatModel = held?.mirror.model?.ref ? choiceOfChatRef(held.mirror.model.ref, held.mirror.thinking ?? "") : null;
  const teams = resolved.teams.state === "ok" ? resolved.teams.value : null;
  const own = chatModel ? { model: chatModel.backend === "claude-code" ? `claude-code/${chatModel.model}` : chatModel.model } : { model: "the chat's own model" };
  const team = {
    coordinator: teams ? { model: teams.coordinator.primary.backend === "claude-code" ? `claude-code/${teams.coordinator.primary.model}` : teams.coordinator.primary.model, ...(teams.coordinator.primary.effort ? { effort: teams.coordinator.primary.effort } : {}) } : own,
    monitor: teams ? { model: teams.monitor.primary.backend === "claude-code" ? `claude-code/${teams.monitor.primary.model}` : teams.monitor.primary.model, ...(teams.monitor.primary.effort ? { effort: teams.monitor.primary.effort } : {}) } : own,
  };
  return {
    denial,
    name,
    routes,
    chat: chatModel,
    team,
    prompts: readPrompts(spec, info),
    commandLabel: (id) => findCommand(id)?.label ?? id,
    commandChanges: (id) => findCommand(id)?.effect !== "looks",
    resolve: (input, as) => {
      const r = resolveRoleModel(input, { routes, chat: chatModel, denial: (c) => denial(c, as), name: (c) => `${name(c).label} · ${name(c).provider}` });
      return { ...r, ...(r.use ? { use: clampEffort(r.use) } : {}), chain: r.chain.map((e) => ({ ...e, choice: clampEffort(e.choice) })) };
    },
    checkValue: (input, value) => checkInputValue(input, value),
    valueText: (input, value) => inputValueText(input, value as InputValue),
  };
}

/** Sova's command line, absolute: what the contents page's commands entry tells a run to use. */
export const SOVA_SCRIPT = join(new URL("../../scripts/", import.meta.url).pathname, "sova.mjs");

/** A file as text, or null. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
