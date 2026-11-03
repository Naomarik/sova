import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EffectiveModel, ModelChoice } from "../../shared/merge-queue-settings";
import { THINKING_LEVELS } from "../../shared/profiles";
import { loadDefaults } from "../web-defaults";

/**
 * The review's and the merge thread's model for one project, kept on this computer (§app.merge-queue/settings):
 * `<state>/merge-queue/<project key>/models.json` = `{v: 1, review?: ModelChoice, thread?: ModelChoice}`. Unset: Same
 * as new chats (the new-chat default, read when each chat starts). A pick applies from the next reviewer or the next
 * fresh thread; a chat already running keeps its model. A pick that can't be used now (turned off in Settings →
 * Models, not signed in) starts the chat on the new-chat default instead, and says why.
 */

export type ModelRole = "review" | "thread";
export interface ProjectModels {
  review?: ModelChoice;
  thread?: ModelChoice;
}

export const modelsFile = (queueDir: string): string => join(queueDir, "models.json");

const REF = /^[^/\s]+\/\S+$/;

/** A choice from a body or the file, checked; null: cleared. Throws a sentence on a bad one. Pure. */
export function parseChoice(v: unknown, what: string): ModelChoice | null {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is {model: "provider/model", thinking?} or null`);
  const o = v as Record<string, unknown>;
  if (typeof o.model !== "string" || !REF.test(o.model) || o.model.length > 200) throw new Error(`${what}.model is "provider/model"`);
  if (o.thinking !== undefined && o.thinking !== null && !(THINKING_LEVELS as readonly unknown[]).includes(o.thinking)) throw new Error(`${what}.thinking is one of ${THINKING_LEVELS.join(", ")}`);
  return { model: o.model, ...(typeof o.thinking === "string" ? { thinking: o.thinking } : {}) };
}

/** The file's picks; a missing or broken file is none. */
export function readModels(queueDir: string): ProjectModels {
  try {
    const raw = JSON.parse(readFileSync(modelsFile(queueDir), "utf8")) as Record<string, unknown>;
    const out: ProjectModels = {};
    for (const role of ["review", "thread"] as const) {
      try {
        const c = raw[role] === undefined ? null : parseChoice(raw[role], role);
        if (c) out[role] = c;
      } catch {
        // one broken pick reads as unset
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Set or clear (null) each role the patch names; the others stay. Atomic. */
export function writeModels(queueDir: string, patch: { review?: ModelChoice | null; thread?: ModelChoice | null }): ProjectModels {
  const next = readModels(queueDir);
  for (const role of ["review", "thread"] as const) {
    if (!(role in patch)) continue;
    const c = patch[role];
    if (c) next[role] = c;
    else delete next[role];
  }
  const file = modelsFile(queueDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, ...next }, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}

export interface ModelCheck {
  /** The new-chat default (web-defaults.ts loadDefaults). */
  defaults: () => { model?: string; thinking?: string };
  /** Why `ref` can't be used: turned off (model-policy.ts modelDenial), or not signed in; null: usable. */
  denial: (ref: string) => string | null | Promise<string | null>;
}

/** What the next chat of `role` starts on. */
export async function effectiveModel(picked: ModelChoice | undefined, check: ModelCheck): Promise<EffectiveModel> {
  const d = check.defaults();
  const fallback: ModelChoice = { model: d.model ?? "", ...(d.thinking ? { thinking: d.thinking } : {}) };
  if (!picked) return { picked: null, effective: fallback };
  const why = await check.denial(picked.model);
  if (why) return { picked, effective: fallback, fallbackWhy: why };
  return { picked, effective: picked };
}

/** The opening choice a chat start carries (POST /api/sessions model/thinking): only a usable pick; else none (the default). */
export async function openingOf(picked: ModelChoice | undefined, check: ModelCheck): Promise<ModelChoice | null> {
  if (!picked) return null;
  return (await check.denial(picked.model)) ? null : picked;
}

/** The live check: Settings → Models' policy, and the models with configured auth. */
export function liveModelCheck(): ModelCheck {
  return {
    defaults: () => loadDefaults(),
    async denial(ref) {
      const [{ modelDenial, readModelPolicy }, { listModels }] = await Promise.all([import("../model-policy"), import("../models")]);
      const off = modelDenial(readModelPolicy(), ref);
      if (off) return off;
      const known = await listModels().catch(() => null);
      if (known && !known.some((m) => m.ref === ref)) return `${ref} isn't signed in on this computer`;
      return null;
    },
  };
}

/** The queue folder of `root` under the live state root. */
async function liveQueueDir(root: string): Promise<string> {
  const [{ stateRoot }, { projectKey }] = await Promise.all([import("../state-root"), import("./store")]);
  return join(stateRoot(), "merge-queue", projectKey(root));
}

/** The opening choice the next `role` chat of `root` starts with (null: the new-chat default). Never throws. */
export async function startingModel(root: string, role: ModelRole, opts: { queueDir?: string; check?: ModelCheck } = {}): Promise<ModelChoice | null> {
  try {
    const dir = opts.queueDir ?? (await liveQueueDir(root));
    return await openingOf(readModels(dir)[role], opts.check ?? liveModelCheck());
  } catch {
    return null;
  }
}
