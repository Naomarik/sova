// What a playbook card needs from this computer: which
// models can run here now (Settings → Models, sign-ins), their names, your profile's model per kind of work,
// the team defaults, the playbook's own pages, and your saved answers. Read fresh for every card drawn.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findCommand } from "../../shared/commands-catalog";
import { checkInputValue, inputValueText, MAIN_ROLE, refOfChoice, type InputValue, type PlaybookSpec } from "../../shared/playbook-format";
import { resolveRoleModel } from "../../shared/playbook-models";
import { THINKING_LEVELS } from "../../shared/profiles";
import type { ModelInfo, PlaybookInfo, WorkerChoice } from "../../shared/protocol";
import { resolveSubagents } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { chatHandle } from "../chat-handle";
import { workerDenial } from "../delegate";
import { modelDenial, readModelPolicy } from "../model-policy";
import { CLAUDE_CODE_PROVIDER, listModels, modelNames } from "../models";
import { bundleFile } from "../playbook-payload";
import { listPlaybooks } from "../playbooks";
import { projectOf } from "../project-root";
import { servedByQueue } from "../merge-queue/served";
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

/**
 * The helpers a playbook card's run is routed by: this computer's default helper profile, or none while no default
 * is chosen. A run is Sova's own, so it never falls back to the built-in profile the accounts give (as before
 * built-in profiles existed, when no default meant no helper profile).
 */
export const cardHelpers = (dir = agentRoot()) => resolveSubagents(dir, undefined, undefined, undefined, null);

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

/** The live environment: read once per card drawn (one model list, one policy read). */
export async function liveEnv(spec: PlaybookSpec, info: PlaybookInfo, chatPath?: string, cwd?: string): Promise<CardEnv> {
  const t0 = Date.now();
  const policy = readModelPolicy();
  const { known, names } = await modelsNow();
  const tModels = Date.now();
  // Only Settings → Models turns a model off here. Sign-ins and usage are checked later, where each role runs;
  // until then the card claims neither.
  const denial = (c: WorkerChoice, as: "main" | "helper"): string | null => {
    const ref = chatRefOf(c);
    const off = as === "main" ? modelDenial(policy, ref) : workerDenial(policy, c.backend, c.model);
    if (off) return off;
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
  /** A model in words for a reason: "GLM 5.3 · z.ai". */
  const words = (c: WorkerChoice) => {
    const n = name(c);
    return `${n.label} · ${PROVIDER_WORDS[n.provider] ?? n.provider}`;
  };
  /** The rest of a sentence after the model's words, as the resolver puts it: "is turned off in Settings → Models". */
  const rest = (c: WorkerChoice, why: string): string => {
    const ref = chatRefOf(c);
    for (const head of [`${ref} `, `${c.model} `, `${refOfChoice(c)} `]) if (why.startsWith(head)) return why.slice(head.length).replace(/ and can't be used\..*$/, "").replace(/\.$/, "");
    const provider = /^Provider (\S+) is turned off in Settings → Models/.exec(why);
    if (provider) return `is off: its provider, ${PROVIDER_WORDS[provider[1]!] ?? provider[1]}, is turned off in Settings → Models`;
    return `can't run: ${why.replace(/\.$/, "")}`;
  };
  const resolved = cardHelpers();
  const routes = resolved.delegate?.profiles ?? null;
  const held = chatPath ? chatHandle(chatPath) : undefined;
  const chatModel = held?.mirror.model?.ref ? choiceOfChatRef(held.mirror.model.ref, held.mirror.thinking ?? "") : null;
  const teams = resolved.teams.state === "ok" ? resolved.teams.value : null;
  const own = chatModel ? { model: chatModel.backend === "claude-code" ? `claude-code/${chatModel.model}` : chatModel.model } : { model: "the chat's own model" };
  const team = {
    coordinator: teams ? { model: teams.coordinator.primary.backend === "claude-code" ? `claude-code/${teams.coordinator.primary.model}` : teams.coordinator.primary.model, ...(teams.coordinator.primary.effort ? { effort: teams.coordinator.primary.effort } : {}) } : own,
    monitor: teams ? { model: teams.monitor.primary.backend === "claude-code" ? `claude-code/${teams.monitor.primary.model}` : teams.monitor.primary.model, ...(teams.monitor.primary.effort ? { effort: teams.monitor.primary.effort } : {}) } : own,
  };
  const needs = await needsRefusal(spec, cwd);
  const took = Date.now() - t0;
  if (took > 1000) console.warn(`[playbook-runs] a card's environment took ${took} ms (models ${tModels - t0} ms, the rest ${Date.now() - tModels} ms)`);
  return {
    needs,
    denial,
    name,
    routes,
    chat: chatModel,
    team,
    page: (rel) => {
      const f = bundleFile(info.dir, rel);
      return "text" in f ? f.text : null;
    },
    commandLabel: (id) => findCommand(id)?.label ?? id,
    commandChanges: (id) => findCommand(id)?.effect !== "looks",
    resolve: (input, as) => {
      const r = resolveRoleModel(input, { routes, chat: chatModel, denial: (c) => {
        const why = denial(c, as);
        return why ? rest(c, why) : null;
      }, name: words });
      return { ...r, ...(r.use ? { use: clampEffort(r.use) } : {}), chain: r.chain.map((e) => ({ ...e, choice: clampEffort(e.choice) })) };
    },
    checkValue: (input, value) => checkInputValue(input, value),
    valueText: (input, value) => inputValueText(input, value as InputValue),
  };
}

/** Providers in words, as the page names them (src/lib/cost-history.ts PROVIDER_NAMES). */
const PROVIDER_WORDS: Record<string, string> = {
  "claude-code-cli": "Claude Code",
  "claude-code": "Claude Code",
  anthropic: "Anthropic",
  "openai-codex": "Codex",
  openai: "OpenAI",
  zai: "z.ai",
  "ollama-cloud": "Ollama Cloud",
  ollama: "Ollama",
  deepseek: "DeepSeek",
  google: "Google",
  openrouter: "OpenRouter",
};

/** The models with credentials and their names, read at most every few seconds: a card drawn per edit asks again. */
const MODELS_FRESH_MS = 15_000;
let modelsRead: { at: number; value: Promise<{ known: ModelInfo[] | null; names: Map<string, string> }> } | null = null;
function modelsNow(): Promise<{ known: ModelInfo[] | null; names: Map<string, string> }> {
  if (modelsRead && Date.now() - modelsRead.at < MODELS_FRESH_MS) return modelsRead.value;
  const value = Promise.all([listModels().catch(() => null), modelNames()]).then(([known, names]) => ({ known, names }));
  modelsRead = { at: Date.now(), value };
  return value;
}

/** Why the folder can't run this playbook (its run.needs), or null. */
async function needsRefusal(spec: PlaybookSpec, cwd: string | undefined): Promise<string | null> {
  if (!spec.run.needs.length) return null;
  const p = cwd ? await projectOf(cwd).catch(() => null) : null;
  if (!p || p.state !== "ok") return "This playbook runs only in a project's folder: open it from a chat in one.";
  if (spec.run.needs.includes("merge-queue") && !(await servedByQueue(p.root).catch(() => false))) return "This playbook runs only in a project the merge queue serves: set up its merge queue first.";
  return null;
}

/** Sova's command line, absolute: what the contents page's commands entry tells a run to use. */
export const SOVA_SCRIPT = fileURLToPath(new URL("../../scripts/sova.mjs", import.meta.url));

/** A file as text, or null. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
